import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { shouldUseLateralJoins, shouldUseDirectPartition } from "../core/Config";
import { FilterBuilderRegistry } from "./FilterBuilderRegistry";
import {ComponentRegistry} from "../core/components";

export class ComponentInclusionNode extends QueryNode {
    private getComponentTableName(compId: string): string {
        if (shouldUseDirectPartition()) {
            return ComponentRegistry.getPartitionTableName(compId) || 'components';
        }
        return 'components';
    }

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
        const useCTE = Boolean(context.hasCTE && context.cteName);

        // Collect LATERAL join fragments if using LATERAL joins
        const lateralJoins: string[] = [];
        const lateralConditions: string[] = [];

        // Check if we need custom sorting (sortOrders specified)
        const hasSortOrders = context.sortOrders.length > 0;

        if (componentCount === 1) {
            // Single component case
            const componentId = componentIds[0]!;

            // Check if we can use single-pass optimization (filter + sort on same component)
            // This must be checked BEFORE adding any params to avoid orphan params
            const canUseSinglePass = hasSortOrders &&
                context.sortOrders.length === 1 &&
                context.componentFilters.size > 0 &&
                !context.withId &&
                excludedIds.length === 0 &&
                context.excludedEntityIds.size === 0 &&
                !useCTE;

            if (canUseSinglePass) {
                const singlePass = this.applySinglePassFilterSort(context);
                if (singlePass) {
                    // Single-pass handles filters, sort, and pagination all in one query
                    return { sql: singlePass, params: context.params, context };
                }
            }

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

            // Apply component filters for single component (normal path)
            sql = this.applyComponentFilters(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, new Map());

            // Apply sorting with component data joins if sortOrders are specified
            if (hasSortOrders) {
                sql = this.applySortingWithComponentJoins(sql, context);
            } else {
                // Default: order by entity_id
                const tableAlias = useCTE ? context.cteName : "ec";
                const idColumn = useCTE ? `${context.cteName}.entity_id` : `${tableAlias}.entity_id`;

                // Apply cursor-based pagination if cursor is set (more efficient than OFFSET)
                if (context.cursorId !== null && !context.paginationAppliedInCTE) {
                    const operator = context.cursorDirection === 'after' ? '>' : '<';
                    const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                    sql += ` ${whereKeyword} ${idColumn} ${operator} $${context.addParam(context.cursorId)}`;
                }

                // Order direction depends on cursor direction
                const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
                sql += ` ORDER BY ${idColumn} ${orderDirection}`;

                // Add LIMIT and OFFSET only if not already applied in CTE
                // When pagination is applied at CTE level, skip it here to avoid double pagination
                if (!context.paginationAppliedInCTE) {
                    if (context.limit !== null) {
                        sql += ` LIMIT $${context.addParam(context.limit)}`;
                    }
                    // Only add OFFSET when not using cursor-based pagination
                    if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                        sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
                    }
                }
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
            
            // Apply sorting with component data joins if sortOrders are specified
            if (hasSortOrders) {
                sql = this.applySortingWithComponentJoins(sql, context);
            } else {
                // Default: order by entity_id
                const tableAlias = useCTE ? context.cteName : "ec";
                const idColumn = useCTE ? `${context.cteName}.entity_id` : `${tableAlias}.entity_id`;

                // Apply cursor-based pagination if cursor is set (more efficient than OFFSET)
                if (context.cursorId !== null && !context.paginationAppliedInCTE) {
                    const operator = context.cursorDirection === 'after' ? '>' : '<';
                    const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                    sql += ` ${whereKeyword} ${idColumn} ${operator} $${context.addParam(context.cursorId)}`;
                }

                // Order direction depends on cursor direction
                const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
                sql += ` ORDER BY ${idColumn} ${orderDirection}`;

                // Add LIMIT and OFFSET only if not already applied in CTE
                // When pagination is applied at CTE level, skip it here to avoid double pagination
                if (!context.paginationAppliedInCTE) {
                    if (context.limit !== null) {
                        sql += ` LIMIT $${context.addParam(context.limit)}`;
                    }
                    // Only add OFFSET when not using cursor-based pagination
                    if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                        sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
                    }
                }
            }
        }

        return {
            sql,
            params: context.params,
            context
        };
    }

    /**
     * Wrap the base query with sorting joins and apply ORDER BY, LIMIT, OFFSET
     * This ensures that sorting and pagination work together correctly
     */
    private applySortingWithComponentJoins(baseQuery: string, context: QueryContext): string {
        // Check if we can use the optimized direct partition sort
        if (shouldUseDirectPartition() && context.sortOrders.length === 1) {
            const optimized = this.applySortingOptimized(baseQuery, context);
            if (optimized) return optimized;
        }

        // Try single-pass optimization when filters and sort are on the same component
        if (context.sortOrders.length === 1) {
            const singlePass = this.applySinglePassFilterSort(context);
            if (singlePass) return singlePass;
        }

        // Wrap the base query as a subquery to get entity ids
        let sql = `SELECT base_entities.id FROM (${baseQuery}) AS base_entities`;
        
        // Build LEFT JOINs for each sort order to access component data
        const sortJoins: string[] = [];
        const orderByClauses: string[] = [];
        
        for (let i = 0; i < context.sortOrders.length; i++) {
            const sortOrder = context.sortOrders[i]!;
            const sortAlias = `sort_${i}`;
            const compAlias = `comp_${i}`;
            
            // Get the component type ID for this sort order
            const typeId = ComponentRegistry.getComponentId(sortOrder.component);
            if (!typeId) {
                continue; // Skip if component not registered
            }
            
            // LEFT JOIN to entity_components and components to get the sort data
            const sortComponentTableName = this.getComponentTableName(typeId);
            sortJoins.push(`
                LEFT JOIN entity_components ${sortAlias}
                    ON ${sortAlias}.entity_id = base_entities.id
                    AND ${sortAlias}.type_id = $${context.addParam(typeId)}::text
                    AND ${sortAlias}.deleted_at IS NULL
                LEFT JOIN ${sortComponentTableName} ${compAlias}
                    ON ${compAlias}.id = ${sortAlias}.component_id
                    AND ${compAlias}.deleted_at IS NULL`);
            
            // Build ORDER BY clause for this sort order
            // Access the property from JSONB data
            const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
            orderByClauses.push(`${compAlias}.data->>'${sortOrder.property}' ${sortOrder.direction} ${nullsClause}`);
        }
        
        // Combine joins
        sql += sortJoins.join('');
        
        // Add ORDER BY clause
        if (orderByClauses.length > 0) {
            sql += ` ORDER BY ${orderByClauses.join(', ')}`;
        } else {
            // Fallback to entity id if no valid sort orders
            sql += ` ORDER BY base_entities.id`;
        }
        
        // Add LIMIT and OFFSET only if not already applied in CTE
        // When pagination is applied at CTE level, skip it here to avoid double pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Only add OFFSET when not using cursor-based pagination
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
    }

    /**
     * Single-pass optimization when all filters and sort are on the same component.
     * Instead of: CTE -> EXISTS filters -> subquery -> JOIN for sort -> LIMIT
     * We do: JOIN once -> filter + sort in same query -> LIMIT
     *
     * This is dramatically faster because PostgreSQL can use indexes to find
     * the top N matching rows directly instead of finding ALL matches first.
     */
    private applySinglePassFilterSort(context: QueryContext): string | null {
        if (context.sortOrders.length !== 1) return null;

        const sortOrder = context.sortOrders[0]!;
        const sortTypeId = ComponentRegistry.getComponentId(sortOrder.component);
        if (!sortTypeId) return null;

        // Check if all filters are on the same component as the sort
        const filterComponentIds = Array.from(context.componentFilters.keys());
        if (filterComponentIds.length === 0) return null;
        if (filterComponentIds.length > 1) return null; // Multiple components - can't optimize
        if (filterComponentIds[0] !== sortTypeId) return null; // Filter and sort on different components

        // All filters and sort are on the same component - use single-pass optimization
        const filters = context.componentFilters.get(sortTypeId) || [];
        if (filters.length === 0) return null;

        const componentTableName = this.getComponentTableName(sortTypeId);
        const useDirectPartition = shouldUseDirectPartition() && componentTableName !== 'components';

        // Build filter conditions
        const filterConditions: string[] = [];
        for (const filter of filters) {
            // Build JSON path
            let jsonPath: string;
            if (filter.field.includes('.')) {
                const parts = filter.field.split('.');
                const lastPart = parts.pop()!;
                const nestedPath = parts.map(p => `'${p}'`).join('->');
                jsonPath = `c.data->${nestedPath}->>'${lastPart}'`;
            } else {
                jsonPath = `c.data->>'${filter.field}'`;
            }

            // Build condition based on type
            let condition: string;
            if (typeof filter.value === 'number') {
                condition = `(${jsonPath})::numeric ${filter.operator} $${context.addParam(filter.value)}::numeric`;
            } else if (typeof filter.value === 'boolean') {
                condition = `(${jsonPath})::boolean ${filter.operator} $${context.addParam(filter.value)}`;
            } else if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
                if (Array.isArray(filter.value)) {
                    const placeholders = filter.value.map((v: any) => `$${context.addParam(v)}`).join(', ');
                    condition = `${jsonPath} ${filter.operator} (${placeholders})`;
                } else {
                    return null; // Invalid - fall back to normal path
                }
            } else if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE' || filter.operator === 'ILIKE') {
                condition = `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}::text`;
            } else {
                condition = `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}::text`;
            }

            filterConditions.push(condition);
        }

        const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';

        let sql: string;
        if (useDirectPartition) {
            // Direct partition access - most efficient
            // No DISTINCT needed since each entity has one component of this type
            sql = `SELECT c.entity_id as id FROM ${componentTableName} c
                WHERE c.type_id = $${context.addParam(sortTypeId)}::text
                AND c.deleted_at IS NULL
                AND ${filterConditions.join(' AND ')}
                ORDER BY c.data->>'${sortOrder.property}' ${sortOrder.direction} ${nullsClause}`;
        } else {
            // Use entity_components junction
            // No DISTINCT needed since each entity has one component of this type
            sql = `SELECT ec.entity_id as id FROM entity_components ec
                JOIN ${componentTableName} c ON c.id = ec.component_id AND c.deleted_at IS NULL
                WHERE ec.type_id = $${context.addParam(sortTypeId)}::text
                AND ec.deleted_at IS NULL
                AND ${filterConditions.join(' AND ')}
                ORDER BY c.data->>'${sortOrder.property}' ${sortOrder.direction} ${nullsClause}`;
        }

        // Add pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
    }

    /**
     * Optimized sorting for direct partition access
     * Queries the partition table directly without going through entity_components for the sort join
     */
    private applySortingOptimized(baseQuery: string, context: QueryContext): string | null {
        if (context.sortOrders.length !== 1) return null;
        
        const sortOrder = context.sortOrders[0]!;
        const typeId = ComponentRegistry.getComponentId(sortOrder.component);
        if (!typeId) return null;
        
        const partitionTable = ComponentRegistry.getPartitionTableName(typeId);
        if (!partitionTable) return null;
        
        const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
        
        // Optimized query: Direct join to partition table, skip entity_components for sort
        // This is faster because we go directly to the partition table
        let sql = `SELECT base.id FROM (${baseQuery}) AS base
            JOIN ${partitionTable} c ON c.entity_id = base.id 
                AND c.type_id = $${context.addParam(typeId)}::text 
                AND c.deleted_at IS NULL
            ORDER BY c.data->>'${sortOrder.property}' ${sortOrder.direction} ${nullsClause}`;
        
        // Add LIMIT and OFFSET only if not already applied in CTE
        // When pagination is applied at CTE level, skip it here to avoid double pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Only add OFFSET when not using cursor-based pagination
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
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
                    // Validate filter value to prevent PostgreSQL UUID parsing errors
                    if (filter.value === '' || (typeof filter.value === 'string' && filter.value.trim() === '')) {
                        throw new Error(`Filter value for field "${filter.field}" is an empty string. This would cause PostgreSQL UUID parsing errors.`);
                    }
                    
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
                    } else if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE' || filter.operator === 'ILIKE') {
                        // String LIKE/ILIKE comparison - no casting
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
                    
                    const componentTableName = this.getComponentTableName(compId);
                    const useDirectPartition = shouldUseDirectPartition() && componentTableName !== 'components';
                    
                    if (useDirectPartition) {
                        // Direct partition access - query partition table directly by entity_id
                        lateralJoins.push(
                            `CROSS JOIN LATERAL (
                            SELECT 1 FROM ${componentTableName} c
                            WHERE c.entity_id = ${tableAlias}.entity_id
                            AND c.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                            AND ${condition}
                            AND c.deleted_at IS NULL
                            LIMIT 1
                        ) AS ${lateralAlias}`
                        );
                    } else {
                        // Use entity_components junction table
                        lateralJoins.push(
                            `CROSS JOIN LATERAL (
                            SELECT 1 FROM entity_components ec_f
                            JOIN ${componentTableName} c ON ec_f.component_id = c.id
                            WHERE ec_f.entity_id = ${tableAlias}.entity_id
                            AND ec_f.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                            AND ${condition}
                            AND ec_f.deleted_at IS NULL
                            AND c.deleted_at IS NULL
                            LIMIT 1
                        ) AS ${lateralAlias}`
                        );
                    }
                    lateralConditions.push(`${lateralAlias} IS NOT NULL`);
                } else {
                    // Use traditional EXISTS subquery
                    const componentTableName = this.getComponentTableName(compId);
                    const useDirectPartition = shouldUseDirectPartition() && componentTableName !== 'components';
                    
                    if (useDirectPartition) {
                        // Direct partition access - query partition table directly by entity_id
                        sql += ` ${whereKeyword} EXISTS (
                        SELECT 1 FROM ${componentTableName} c
                        WHERE c.entity_id = ${tableAlias}.entity_id
                        AND c.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                        AND ${condition}
                        AND c.deleted_at IS NULL
                    )`;
                    } else {
                        // Use entity_components junction table
                        sql += ` ${whereKeyword} EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN ${componentTableName} c ON ec_f.component_id = c.id
                        WHERE ec_f.entity_id = ${tableAlias}.entity_id
                        AND ec_f.type_id = $${componentParamIndices.has(compId) ? componentParamIndices.get(compId) : context.addParam(compId)}::text
                        AND ${condition}
                        AND ec_f.deleted_at IS NULL
                        AND c.deleted_at IS NULL
                    )`;
                    }
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