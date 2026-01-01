import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { OrQuery } from "./OrQuery";
import ComponentRegistry from "../core/ComponentRegistry";
import { shouldUseDirectPartition } from "../core/Config";

export class OrNode extends QueryNode {
    private orQuery: OrQuery;

    constructor(orQuery: OrQuery) {
        super();
        this.orQuery = orQuery;
    }

    private getComponentTableName(compId: string): string {
        if (shouldUseDirectPartition()) {
            return ComponentRegistry.getPartitionTableName(compId) || 'components';
        }
        return 'components';
    }

    /**
     * Check if we can use the optimized UNION ALL approach with direct partition access.
     * This works for both:
     * - Multiple different component types (each queries its own partition)
     * - Same component type with different filters (queries same partition, UNION dedupes results)
     */
    private canUseUnionAllOptimization(): boolean {
        if (!shouldUseDirectPartition()) return false;
        
        // Verify all components are registered and have valid partition tables
        for (const branch of this.orQuery.branches) {
            const compId = ComponentRegistry.getComponentId(branch.component.name);
            if (!compId) return false;
            // Ensure partition table exists for this component
            const partitionTable = ComponentRegistry.getPartitionTableName(compId);
            if (!partitionTable) return false;
        }
        
        // With direct partition access, always use the optimized path
        // The UNION automatically dedupes results when branches use the same partition
        return true;
    }

    /**
     * Optimized UNION ALL execution for OR queries with direct partition access
     * Each branch queries its partition directly using simple queries
     * This avoids the complex EXISTS subqueries of the original implementation
     */
    private executeUnionAllOptimized(context: QueryContext): QueryResult {
        // Special case: if all branches use the same component type, combine into single query with OR conditions
        const componentTypes = new Set<string>();
        for (const branch of this.orQuery.branches) {
            const compId = ComponentRegistry.getComponentId(branch.component.name);
            if (compId) {
                componentTypes.add(compId);
            }
        }

        if (componentTypes.size === 1) {
            return this.executeSingleComponentOptimized(context);
        }

        // Original multi-component logic
        const branches: string[] = [];
        let paramIndex = context.paramIndex;

        // Build SQL for each branch - direct, simple partition queries
        for (const branch of this.orQuery.branches) {
            const componentId = ComponentRegistry.getComponentId(branch.component.name);
            if (!componentId) {
                throw new Error(`Component ${branch.component.name} is not registered`);
            }

            const partitionTable = ComponentRegistry.getPartitionTableName(componentId) || 'components';

            // Simple, direct query to partition table - no EXISTS, no subqueries
            let branchSql = `SELECT entity_id FROM ${partitionTable} WHERE type_id = $${paramIndex} AND deleted_at IS NULL`;

            context.params.push(componentId);
            paramIndex++;

            // Add filters for this branch - inline in WHERE clause
            if (branch.filters && branch.filters.length > 0) {
                for (const filter of branch.filters) {
                    const { field, operator, value } = filter;
                    const jsonPath = `data->>'${field}'`;

                    switch (operator) {
                        case "=":
                        case ">":
                        case "<":
                        case ">=":
                        case "<=":
                        case "!=":
                            if (typeof value === "string") {
                                branchSql += ` AND ${jsonPath} ${operator} $${paramIndex}::text`;
                            } else {
                                branchSql += ` AND (${jsonPath})::numeric ${operator} $${paramIndex}`;
                            }
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "LIKE":
                            branchSql += ` AND ${jsonPath} LIKE $${paramIndex}::text`;
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                branchSql += ` AND ${jsonPath} IN (${placeholders})`;
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                branchSql += ` AND ${jsonPath} NOT IN (${placeholders})`;
                                context.params.push(...value);
                            }
                            break;
                        default:
                            throw new Error(`Unsupported operator: ${operator}`);
                    }
                }
            }

            branches.push(branchSql);
        }

        // Combine with UNION (automatically dedupes) - simpler than UNION ALL + DISTINCT wrapper
        let sql = `SELECT entity_id as id FROM (${branches.join(' UNION ')}) AS or_results`;

        // Apply global constraints
        const conditions: string[] = [];

        // Add entity exclusions
        if (context.excludedEntityIds.size > 0) {
            const excludedIds = Array.from(context.excludedEntityIds);
            const placeholders = excludedIds.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`entity_id NOT IN (${placeholders})`);
            context.params.push(...excludedIds);
        }

        // Add component exclusions
        if (context.excludedComponentIds.size > 0) {
            const excludedTypes = Array.from(context.excludedComponentIds);
            const placeholders = excludedTypes.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`NOT EXISTS (SELECT 1 FROM entity_components ec_ex WHERE ec_ex.entity_id = or_results.id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Add ordering
        sql += " ORDER BY id";

        // Add pagination
        if (context.limit !== null) {
            sql += ` LIMIT $${paramIndex++}`;
            context.params.push(context.limit);
        }

        if (context.offsetValue > 0) {
            sql += ` OFFSET $${paramIndex++}`;
            context.params.push(context.offsetValue);
        }

        context.paramIndex = paramIndex;

        return {
            sql,
            params: context.params,
            context
        };
    }

    /**
     * Special optimized execution for OR queries where all branches use the same component type
     * Uses OR conditions in a single query instead of UNION to avoid PostgreSQL parameter type inference issues
     */
    private executeSingleComponentOptimized(context: QueryContext): QueryResult {
        let paramIndex = context.paramIndex;

        // Get the single component info
        const branch = this.orQuery.branches[0];
        const componentId = ComponentRegistry.getComponentId(branch.component.name);
        if (!componentId) {
            throw new Error(`Component ${branch.component.name} is not registered`);
        }

        const partitionTable = ComponentRegistry.getPartitionTableName(componentId) || 'components';

        // Build WHERE conditions for all branches
        const orConditions: string[] = [];

        for (const branch of this.orQuery.branches) {
            const conditions: string[] = [];

            // Use literal component type value (no parameter) to avoid type inference issues
            conditions.push(`type_id = '${componentId}'`);

            // Add filters for this branch
            if (branch.filters && branch.filters.length > 0) {
                for (const filter of branch.filters) {
                    const { field, operator, value } = filter;
                    const jsonPath = `data->>'${field}'`;

                    switch (operator) {
                        case "=":
                        case ">":
                        case "<":
                        case ">=":
                        case "<=":
                        case "!=":
                        case "LIKE":
                            // Note: data->>'field' returns text, so no cast needed
                            // Explicit casting can cause issues with Bun's SQL parameter type inference
                            conditions.push(`${jsonPath} ${operator} $${paramIndex}`);
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                conditions.push(`${jsonPath} IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                conditions.push(`${jsonPath} NOT IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        default:
                            throw new Error(`Unsupported operator: ${operator}`);
                    }
                }
            }

            // Combine conditions for this branch with AND
            orConditions.push(`(${conditions.join(' AND ')})`);
        }

        // Build the main query
        let sql = `SELECT entity_id as id FROM ${partitionTable} WHERE deleted_at IS NULL AND (${orConditions.join(' OR ')})`;

        // Apply global constraints
        const conditions: string[] = [];

        // Add entity exclusions
        if (context.excludedEntityIds.size > 0) {
            const excludedIds = Array.from(context.excludedEntityIds);
            const placeholders = excludedIds.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`entity_id NOT IN (${placeholders})`);
            context.params.push(...excludedIds);
        }

        // Add component exclusions
        if (context.excludedComponentIds.size > 0) {
            const excludedTypes = Array.from(context.excludedComponentIds);
            const placeholders = excludedTypes.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`NOT EXISTS (SELECT 1 FROM entity_components ec_ex WHERE ec_ex.entity_id = ${partitionTable}.entity_id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` AND ${conditions.join(' AND ')}`;
        }

        // Add ordering
        sql += " ORDER BY entity_id";

        // Add pagination
        if (context.limit !== null) {
            sql += ` LIMIT $${paramIndex++}`;
            context.params.push(context.limit);
        }

        if (context.offsetValue > 0) {
            sql += ` OFFSET $${paramIndex++}`;
            context.params.push(context.offsetValue);
        }

        context.paramIndex = paramIndex;

        return {
            sql,
            params: context.params,
            context
        };
    }

    public execute(context: QueryContext): QueryResult {
        // Try optimized UNION ALL path for direct partition access
        // This avoids the slow multi-partition scanning by querying each partition directly
        const canUseOptimized = this.canUseUnionAllOptimization() && this.dependencies.length === 0;
        console.log(`OrNode: Using optimized path: ${canUseOptimized}, dependencies: ${this.dependencies.length}, direct partition: ${require("../core/Config").shouldUseDirectPartition()}`);
        console.log(`OrNode: Component types:`, Array.from(this.orQuery.getComponentTypes()));

        if (canUseOptimized) {
            console.log("OrNode: Using optimized UNION path");
            return this.executeUnionAllOptimized(context);
        }
        console.log("OrNode: Using fallback path");

        // Fall back to original implementation for:
        // - HASH partitioning (no direct partition access)
        // - Queries with ComponentInclusionNode dependencies
        // - Single component type OR queries
        const branches: string[] = [];
        let paramIndex = context.paramIndex;

        // Get all component types referenced in the OR query
        const allComponentTypes = this.orQuery.getComponentTypes();

        // Check if we have ComponentInclusionNode as a dependency
        const hasComponentDependency = this.dependencies.length > 0;
        let baseEntityQuery = "";

        if (hasComponentDependency) {
            // Get base entities from ComponentInclusionNode
            const componentNode = this.dependencies[0];
            if (componentNode) {
                const baseResult = componentNode.execute(context);
                baseEntityQuery = baseResult.sql;
                paramIndex = baseResult.context.paramIndex;
            }
        }

        // Build SQL for each branch
        for (const branch of this.orQuery.branches) {
            const componentId = ComponentRegistry.getComponentId(branch.component.name);
            if (!componentId) {
                throw new Error(`Component ${branch.component.name} is not registered`);
            }

            const componentIdParamIndex = paramIndex;
            let branchSql: string;

            if (hasComponentDependency) {
                // Filter entities from base query (ComponentInclusionNode returns 'id' column)
                const componentTableName = this.getComponentTableName(componentId);
                branchSql = `
                SELECT base.id as entity_id
                FROM (${baseEntityQuery}) AS base
                WHERE EXISTS (
                    SELECT 1 FROM ${componentTableName} c
                    WHERE c.entity_id = base.id
                    AND c.type_id = $${componentIdParamIndex}                    AND c.deleted_at IS NULL
                    AND c.created_at = (
                        SELECT MAX(c2.created_at)
                        FROM ${componentTableName} c2
                        WHERE c2.entity_id = c.entity_id
                        AND c2.type_id = $${componentIdParamIndex}                        AND c2.deleted_at IS NULL
                    )`;
            } else {
                // Use original query without base
                const componentTableName = this.getComponentTableName(componentId);
                branchSql = `
                SELECT ec.entity_id
                FROM entity_components ec
                WHERE ec.type_id = $${componentIdParamIndex} AND ec.deleted_at IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${componentTableName} c
                    WHERE c.entity_id = ec.entity_id
                    AND c.type_id = $${componentIdParamIndex}                    AND c.deleted_at IS NULL
                    AND c.created_at = (
                        SELECT MAX(c2.created_at)
                        FROM ${componentTableName} c2
                        WHERE c2.entity_id = c.entity_id
                        AND c2.type_id = $${componentIdParamIndex}                        AND c2.deleted_at IS NULL
                    )`;
            }

            context.params.push(componentId);
            paramIndex++;

            // Add filters for this branch - applied to the latest component data
            const filterConditions: string[] = [];
            if (branch.filters && branch.filters.length > 0) {
                for (const filter of branch.filters) {
                    const { field, operator, value } = filter;

                    // Build JSON path for nested properties
                    const jsonPath = `c.data->>'${field}'`;

                    switch (operator) {
                        case "=":
                        case ">":
                        case "<":
                        case ">=":
                        case "<=":
                        case "!=":
                            if (typeof value === "string") {
                                filterConditions.push(`${jsonPath} ${operator} $${paramIndex}`);
                                context.params.push(value);
                                paramIndex++;
                            } else {
                                filterConditions.push(`(${jsonPath})::numeric ${operator} $${paramIndex}`);
                                context.params.push(value);
                                paramIndex++;
                            }
                            break;
                        case "LIKE":
                            filterConditions.push(`${jsonPath} LIKE $${paramIndex}`);
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                filterConditions.push(`${jsonPath} IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                                filterConditions.push(`${jsonPath} NOT IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        default:
                            throw new Error(`Unsupported operator: ${operator}`);
                    }
                }
            }

            // Apply filters inside the EXISTS/WHERE clause
            if (filterConditions.length > 0) {
                branchSql += ` AND ${filterConditions.join(' AND ')}`;
            }

            branchSql += ")";

            branches.push(branchSql);
        }

        // Combine branches with UNION
        let sql = `SELECT DISTINCT entity_id as id FROM (${branches.join(' UNION ')}) AS or_results`;

        // Only ensure entities have ALL components when OrNode is the root (no base requirements)
        // When used as a filter on top of ComponentInclusionNode, base requirements are already ensured
        const componentConditions: string[] = [];

        if (!hasComponentDependency) {
            for (const componentType of allComponentTypes) {
                const componentId = ComponentRegistry.getComponentId(componentType);
                if (componentId) {
                    componentConditions.push(`EXISTS (SELECT 1 FROM entity_components ec_all WHERE ec_all.entity_id = or_results.id AND ec_all.type_id = $${paramIndex} AND ec_all.deleted_at IS NULL)`);
                    context.params.push(componentId);
                    paramIndex++;
                }
            }
        }

        // Apply global constraints
        const conditions: string[] = [...componentConditions];

        // Add entity exclusions
        if (context.excludedEntityIds.size > 0) {
            const excludedIds = Array.from(context.excludedEntityIds);
            const placeholders = excludedIds.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`entity_id NOT IN (${placeholders})`);
            context.params.push(...excludedIds);
        }

        // Add component exclusions (entities that have excluded components)
        if (context.excludedComponentIds.size > 0) {
            const excludedTypes = Array.from(context.excludedComponentIds);
            const placeholders = excludedTypes.map(() => `$${paramIndex++}`).join(', ');
            conditions.push(`NOT EXISTS (SELECT 1 FROM entity_components ec_ex WHERE ec_ex.entity_id = or_results.id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Add ordering
        sql += " ORDER BY entity_id";

        // Add pagination
        if (context.limit !== null) {
            sql += ` LIMIT $${paramIndex++}`;
            context.params.push(context.limit);
        }

        if (context.offsetValue > 0) {
            sql += ` OFFSET $${paramIndex++}`;
            context.params.push(context.offsetValue);
        }

        context.paramIndex = paramIndex;

        return {
            sql,
            params: context.params,
            context
        };
    }    public getNodeType(): string {
        return "OrNode";
    }
}