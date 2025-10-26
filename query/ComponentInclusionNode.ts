import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";

export class ComponentInclusionNode extends QueryNode {
    public execute(context: QueryContext): QueryResult {
        const componentIds = Array.from(context.componentIds);
        const excludedIds = Array.from(context.excludedComponentIds);

        if (componentIds.length === 0) {
            // No components required, return the input as-is
            return {
                sql: "",
                params: context.params,
                context
            };
        }

        let sql = "";
        const componentCount = componentIds.length;

        if (componentCount === 1) {
            // Single component case
            const componentId = componentIds[0]!;
            sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id = $${context.addParam(componentId)} AND ec.deleted_at IS NULL`;

            if (context.withId) {
                sql += ` AND ec.entity_id = $${context.addParam(context.withId)}`;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` AND NOT EXISTS (
                    SELECT 1 FROM entity_components ec_ex
                    WHERE ec_ex.entity_id = ec.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` AND ec.entity_id NOT IN (${entityPlaceholders})`;
            }

            // Apply component filters for single component
            for (const [compId, filters] of context.componentFilters) {
                for (const filter of filters) {
                    // Check if value looks like a UUID (case-insensitive, with or without hyphens)
                    const valueStr = String(filter.value);
                    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);
                    
                    // Debug logging
                    console.log('[ComponentInclusionNode] Filter:', { 
                        field: filter.field, 
                        operator: filter.operator, 
                        value: filter.value,
                        valueStr,
                        isUUID 
                    });
                    
                    let condition: string;
                    if (isUUID && filter.operator === '=') {
                        // UUID equality comparison - only cast the parameter, compare as text
                        // This allows matching UUID parameter against both UUID and text fields
                        condition = `c.data->>'${filter.field}' = $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE') {
                        // String LIKE comparison - no casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
                        // IN/NOT IN comparison - no casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    } else if (typeof filter.value === 'number' || !isNaN(Number(filter.value))) {
                        // Numeric comparison - cast to numeric
                        condition = `(c.data->>'${filter.field}')::numeric ${filter.operator} $${context.addParam(filter.value)}::numeric`;
                    } else {
                        // Default: text comparison without casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    }
                    
                    console.log('[ComponentInclusionNode] Condition:', condition);
                    
                    sql += ` AND EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN components c ON ec_f.component_id = c.id
                        WHERE ec_f.entity_id = ec.entity_id
                        AND ec_f.type_id = $${context.addParam(compId)}
                        AND ${condition}
                        AND ec_f.deleted_at IS NULL
                        AND c.deleted_at IS NULL
                    )`;
                }
            }

            sql += " ORDER BY ec.entity_id";
        } else {
            // Multiple components case
            const componentPlaceholders = componentIds.map((id) => `$${context.addParam(id)}`).join(', ');
            sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id IN (${componentPlaceholders}) AND ec.deleted_at IS NULL`;

            if (context.withId) {
                sql += ` AND ec.entity_id = $${context.addParam(context.withId)}`;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` AND NOT EXISTS (
                    SELECT 1 FROM entity_components ec_ex
                    WHERE ec_ex.entity_id = ec.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` AND ec.entity_id NOT IN (${entityPlaceholders})`;
            }

            // Apply component filters for multiple components
            for (const [compId, filters] of context.componentFilters) {
                for (const filter of filters) {
                    // Check if value looks like a UUID (case-insensitive, with or without hyphens)
                    const valueStr = String(filter.value);
                    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);
                    
                    let condition: string;
                    if (isUUID && filter.operator === '=') {
                        // UUID equality comparison - only cast the parameter, compare as text
                        // This allows matching UUID parameter against both UUID and text fields
                        condition = `c.data->>'${filter.field}' = $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE') {
                        // String LIKE comparison - no casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
                        // IN/NOT IN comparison - no casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    } else if (typeof filter.value === 'number' || !isNaN(Number(filter.value))) {
                        // Numeric comparison - cast to numeric
                        condition = `(c.data->>'${filter.field}')::numeric ${filter.operator} $${context.addParam(filter.value)}::numeric`;
                    } else {
                        // Default: text comparison without casting
                        condition = `c.data->>'${filter.field}' ${filter.operator} $${context.addParam(filter.value)}`;
                    }
                    
                    sql += ` AND EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN components c ON ec_f.component_id = c.id
                        WHERE ec_f.entity_id = ec.entity_id
                        AND ec_f.type_id = $${context.addParam(compId)}
                        AND ${condition}
                        AND ec_f.deleted_at IS NULL
                        AND c.deleted_at IS NULL
                    )`;
                }
            }

            sql += ` GROUP BY ec.entity_id HAVING COUNT(DISTINCT ec.type_id) = $${context.addParam(componentCount)} ORDER BY ec.entity_id`;
        }

        return {
            sql,
            params: context.params,
            context
        };
    }

    public getNodeType(): string {
        return "ComponentInclusionNode";
    }
}