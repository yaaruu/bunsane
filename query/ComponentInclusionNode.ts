import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { shouldUseLateralJoins } from "../core/Config";
import { FilterBuilderRegistry } from "./FilterBuilderRegistry";

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
        const useLateralJoins = Boolean(shouldUseLateralJoins());

        // Check if CTE is available and use it to avoid redundant entity_components scans
        const useCTE = context.hasCTE && context.cteName;

        // Collect LATERAL join fragments if using LATERAL joins
        const lateralJoins: string[] = [];
        const lateralConditions: string[] = [];

        if (componentCount === 1) {
            // Single component case
            const componentId = componentIds[0]!;
            
            if (useCTE) {
                // Use CTE for base entity filtering
                sql = `SELECT DISTINCT ${context.cteName}.entity_id as id FROM ${context.cteName}`;
                
                // Filter by the specific component type if not already in CTE
                if (!componentIds.some(id => context.componentIds.has(id))) {
                    sql += ` WHERE EXISTS (
                        SELECT 1 FROM entity_components ec
                        WHERE ec.entity_id = ${context.cteName}.entity_id
                        AND ec.type_id = $${context.addParam(componentId)}::text
                        AND ec.deleted_at IS NULL
                    )`;
                }
            } else {
                sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id = $${context.addParam(componentId)}::text AND ec.deleted_at IS NULL`;
            }

            if (context.withId) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                sql += ` ${whereKeyword} ${tableAlias}.entity_id = $${context.addParam(context.withId)}`;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} NOT EXISTS (
                    SELECT 1 FROM entity_components ec_ex
                    WHERE ec_ex.entity_id = ${tableAlias}.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} ${tableAlias}.entity_id NOT IN (${entityPlaceholders})`;
            }

            // Apply component filters for single component
            sql = this.applyComponentFilters(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, new Map());

            const tableAlias = useCTE ? context.cteName : "ec";
            sql += ` ORDER BY ${tableAlias}.entity_id`;
            
            // Add LIMIT and OFFSET
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            if (context.offsetValue > 0) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        } else {
            // Multiple components case
            // Create parameter indices for component IDs to avoid duplicates
            const componentParamIndices: Map<string, number> = new Map();
            const componentPlaceholders = componentIds.map((id) => {
                if (!componentParamIndices.has(id)) {
                    componentParamIndices.set(id, context.addParam(id));
                }
                return `$${componentParamIndices.get(id)}::text`;
            }).join(', ');
            
            if (useCTE) {
                // Use CTE for base entity filtering
                sql = `SELECT DISTINCT ${context.cteName}.entity_id as id FROM ${context.cteName}`;
                
                // Ensure all required components are present
                sql += ` WHERE (`;
                const componentChecks = componentIds.map(compId => {
                    if (!componentParamIndices.has(compId)) {
                        componentParamIndices.set(compId, context.addParam(compId));
                    }
                    return `EXISTS (
                        SELECT 1 FROM entity_components ec
                        WHERE ec.entity_id = ${context.cteName}.entity_id
                        AND ec.type_id = $${componentParamIndices.get(compId)}::text
                        AND ec.deleted_at IS NULL
                    )`;
                });
                sql += componentChecks.join(' AND ') + `)`;
            } else {
                sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id IN (${componentPlaceholders}) AND ec.deleted_at IS NULL`;
            }

            if (context.withId) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                sql += ` ${whereKeyword} ${tableAlias}.entity_id = $${context.addParam(context.withId)}`;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} NOT EXISTS (
                    SELECT 1 FROM entity_components ec_ex
                    WHERE ec_ex.entity_id = ${tableAlias}.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} ${tableAlias}.entity_id NOT IN (${entityPlaceholders})`;
            }

            // Apply component filters for multiple components
            sql = this.applyComponentFilters(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, componentParamIndices);

            if (!useCTE) {
                sql += ` GROUP BY ec.entity_id HAVING COUNT(DISTINCT ec.type_id) = $${context.addParam(componentCount)}`;
            }
            
            const tableAlias = useCTE ? context.cteName : "ec";
            sql += ` ORDER BY ${tableAlias}.entity_id`;
            
            // Add LIMIT and OFFSET
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            if (context.offsetValue > 0) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return {
            sql,
            params: context.params,
            context
        };
    }

    /**
     * Apply component filters using either EXISTS subqueries or LATERAL joins
     */
    private applyComponentFilters(
        context: QueryContext,
        componentIds: string[],
        useCTE: boolean,
        useLateralJoins: boolean,
        lateralJoins: string[],
        lateralConditions: string[],
        sql: string,
        componentParamIndices: Map<string, number>
    ): string {
        for (const [compId, filters] of context.componentFilters) {
            for (const filter of filters) {
                let condition: string;

                // Check for custom filter builder first
                if (FilterBuilderRegistry.has(filter.operator)) {
                    // Validate filter if validator is provided
                    const options = FilterBuilderRegistry.getOptions(filter.operator);
                    if (options?.validate && !options.validate(filter)) {
                        throw new Error(`Invalid filter value for operator '${filter.operator}': ${JSON.stringify(filter.value)}`);
                    }

                    const customBuilder = FilterBuilderRegistry.get(filter.operator)!;
                    const result = customBuilder(filter, "c", context);
                    condition = result.sql;
                    // Note: custom builder is responsible for adding parameters via context.addParam()
                } else {
                    // Default filter logic
                    // Check if value looks like a UUID (case-insensitive, with or without hyphens)
                    const valueStr = String(filter.value);
                    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);
                    
                    // Debug logging
                    // console.log('[ComponentInclusionNode] Filter:', { 
                    //     field: filter.field, 
                    //     operator: filter.operator, 
                    //     value: filter.value,
                    //     valueStr,
                    //     isUUID 
                    // });
                    
                    // Build JSON path for nested fields (e.g., "device.unique_id" -> "c.data->'device'->>'unique_id'")
                    let jsonPath: string;
                    if (filter.field.includes('.')) {
                        const parts = filter.field.split('.');
                        const lastPart = parts.pop()!;
                        const nestedPath = parts.map(p => `'${p}'`).join('->');
                        jsonPath = `c.data->${nestedPath}->>'${lastPart}'`;
                    } else {
                        jsonPath = `c.data->>'${filter.field}'`;
                    }
                    
                    if (isUUID && filter.operator === '=') {
                        // UUID equality comparison - only cast the parameter, compare as text
                        // This allows matching UUID parameter against both UUID and text fields
                        condition = `${jsonPath} = $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE') {
                        // String LIKE comparison - no casting
                        condition = `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}`;
                    } else if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
                        // IN/NOT IN comparison - handle arrays properly
                        if (Array.isArray(filter.value)) {
                            const placeholders = Array.from({length: filter.value.length}, (_, i) => `$${context.addParam(filter.value[i])}`).join(', ');
                            condition = `${jsonPath} ${filter.operator} (${placeholders})`;
                        } else {
                            throw new Error(`${filter.operator} operator requires an array of values`);
                        }
                    } else if (typeof filter.value === 'number') {
                        // Only treat as numeric if the value is actually a number type, not a string
                        condition = `(${jsonPath})::numeric ${filter.operator} $${context.addParam(filter.value)}::numeric`;
                    } else if (typeof filter.value === 'boolean') {
                        // Boolean comparison - cast JSON text to boolean
                        condition = `(${jsonPath})::boolean ${filter.operator} $${context.addParam(filter.value)}`;
                    } else {
                        // Default: text comparison without casting
                        condition = `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}`;
                    }
                    
                    // console.log('[ComponentInclusionNode] Condition:', condition);
                }
                
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';

                if (useLateralJoins) {
                    // Use LATERAL join approach
                    // Create a short, unique alias (PostgreSQL has 63 char limit)
                    // Use first 8 chars of component ID + field name + index
                    const compIdShort = compId.substring(0, 8);
                    const fieldShort = filter.field.replace(/\./g, '_').substring(0, 20);
                    const lateralAlias = `lat_${compIdShort}_${fieldShort}_${lateralJoins.length}`;
                    
                    lateralJoins.push(
                        `CROSS JOIN LATERAL (
                            SELECT 1 FROM entity_components ec_f
                            JOIN components c ON ec_f.component_id = c.id
                            WHERE ec_f.entity_id = ${tableAlias}.entity_id
                            AND ec_f.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                            AND ${condition}
                            AND ec_f.deleted_at IS NULL
                            AND c.deleted_at IS NULL
                            LIMIT 1
                        ) AS ${lateralAlias}`
                    );
                    lateralConditions.push(`${lateralAlias} IS NOT NULL`);
                } else {
                    // Use traditional EXISTS subquery
                    sql += ` ${whereKeyword} EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN components c ON ec_f.component_id = c.id
                        WHERE ec_f.entity_id = ${tableAlias}.entity_id
                        AND ec_f.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                        AND ${condition}
                        AND ec_f.deleted_at IS NULL
                        AND c.deleted_at IS NULL
                    )`;
                }
            }
        }

        // If using LATERAL joins, add them to the FROM clause and conditions to WHERE
        if (useLateralJoins && lateralJoins.length > 0) {
            // Add LATERAL conditions to WHERE clause FIRST (before inserting LATERAL joins)
            let whereClause = '';
            if (lateralConditions.length > 0) {
                const conditionsString = lateralConditions.join(' AND ');
                
                // Find ORDER BY or GROUP BY to determine WHERE insertion point
                const orderByMatch = sql.match(/\s+(ORDER\s+BY)/i);
                const groupByMatch = sql.match(/\s+(GROUP\s+BY)/i);
                
                let insertIndex = -1;
                if (orderByMatch) {
                    insertIndex = orderByMatch.index!;
                } else if (groupByMatch) {
                    insertIndex = groupByMatch.index!;
                }
                
                // Check if WHERE already exists in the query (before ORDER BY/GROUP BY)
                const beforeClause = insertIndex !== -1 ? sql.substring(0, insertIndex) : sql;
                const hasWhere = beforeClause.includes(' WHERE ');
                const whereKeyword = hasWhere ? ' AND' : ' WHERE';
                whereClause = `${whereKeyword} ${conditionsString}`;
                
                if (insertIndex !== -1) {
                    // Insert before ORDER BY or GROUP BY
                    sql = sql.substring(0, insertIndex) + whereClause + sql.substring(insertIndex);
                } else {
                    // No ORDER BY or GROUP BY, append at end
                    sql += whereClause;
                }
            }
            
            // Now find the FROM clause and add LATERAL joins after the table name
            const fromIndex = sql.indexOf(' FROM ');
            if (fromIndex !== -1) {
                const afterFromStart = fromIndex + 6; // Position after "FROM "
                const afterFromPart = sql.substring(afterFromStart);
                
                // Find the end of the table name/alias (before WHERE, ORDER BY, or GROUP BY)
                let tableEndIndex = afterFromPart.search(/\s+(WHERE|AND|ORDER\s+BY|GROUP\s+BY)/i);
                if (tableEndIndex === -1) {
                    tableEndIndex = afterFromPart.length;
                }
                
                const tableName = afterFromPart.substring(0, tableEndIndex).trim();
                const restOfQuery = afterFromPart.substring(tableEndIndex);
                
                const beforeFrom = sql.substring(0, afterFromStart);
                const lateralSql = lateralJoins.join(' ');
                sql = beforeFrom + tableName + ' ' + lateralSql + restOfQuery;
            }
        }

        return sql;
    }

    public getNodeType(): string {
        return "ComponentInclusionNode";
    }
}