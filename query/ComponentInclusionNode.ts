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