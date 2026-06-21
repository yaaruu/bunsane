import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { OrQuery } from "./OrQuery";
import { ComponentRegistry } from "../core/components";
import { shouldUseDirectPartition } from "../core/Config";
import { getMembershipTable } from "./membershipSource";
import { jsonbInListCast } from "./FilterBuilder";

/**
 * Gate for the base-dependency single-pass OR rewrite (base scanned once,
 * branches combined as OR-of-EXISTS instead of N× base + UNION + DISTINCT).
 *
 * Default ON — the single-pass shape is parity-proven against the legacy UNION
 * path (identical exec/paginate/count results) and ~20× faster (no per-branch
 * cartesian nested-loop; base anti-join computed once). Read at call time.
 *
 * Kill-switch: set BUNSANE_ORNODE_SINGLE_PASS=0 (or "false") to revert to the
 * legacy UNION shape instantly, no redeploy — for the unlikely case a real
 * Postgres planner regresses on a specific OR shape.
 */
function shouldUseOrSinglePass(): boolean {
    const v = process.env.BUNSANE_ORNODE_SINGLE_PASS;
    return v !== '0' && v !== 'false';
}

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
                        case "ILIKE":
                            branchSql += ` AND ${jsonPath} ${operator} $${paramIndex}::text`;
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                branchSql += ` AND ${cast.lhs(jsonPath)} IN (${placeholders})`;
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                branchSql += ` AND ${cast.lhs(jsonPath)} NOT IN (${placeholders})`;
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
            conditions.push(`NOT EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_ex WHERE ec_ex.entity_id = or_results.entity_id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Add ordering (skipped when an outer sort wrapper re-orders the set)
        if (!context.suppressNodeOrdering) {
            sql += " ORDER BY id";
        }

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
        if(!branch) {
            throw new Error("OrNode: No branches found in OrQuery");
        }
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
                        case "ILIKE":
                            // Note: data->>'field' returns text, so no cast needed
                            // Explicit casting can cause issues with Bun's SQL parameter type inference
                            conditions.push(`${jsonPath} ${operator} $${paramIndex}`);
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                conditions.push(`${cast.lhs(jsonPath)} IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                conditions.push(`${cast.lhs(jsonPath)} NOT IN (${placeholders})`);
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
            conditions.push(`NOT EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_ex WHERE ec_ex.entity_id = ${partitionTable}.entity_id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` AND ${conditions.join(' AND ')}`;
        }

        // Add ordering (skipped when an outer sort wrapper re-orders the set)
        if (!context.suppressNodeOrdering) {
            sql += " ORDER BY entity_id";
        }

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
        // (Verbose console.log debug traces removed — H-QUERY-2. Re-enable via
        // a framework logger at debug level if needed.)
        const canUseOptimized = this.canUseUnionAllOptimization() && this.dependencies.length === 0;

        if (canUseOptimized) {
            return this.executeUnionAllOptimized(context);
        }

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
            // Get base entities from ComponentInclusionNode.
            //
            // CRITICAL: the base set must be UNBOUNDED. OrNode embeds this SQL
            // as `FROM (base) WHERE EXISTS (<or filter>)` and applies LIMIT/
            // OFFSET to the *final* OR-filtered result below. If the base node
            // bakes the caller's LIMIT/OFFSET into its own SQL, the EXISTS OR
            // filter only ever sees the first page of base entities (ordered by
            // entity_id), so any match beyond that page silently vanishes —
            // e.g. a search whose only hits live on page 2+ returns 0 rows
            // while count() (which strips pagination) reports them. Null out
            // pagination around the base build, then restore so the final
            // pagination below is unaffected. cursorId is left intact: it
            // constrains the candidate set (entity_id > cursor) which composes
            // correctly with the final LIMIT.
            const componentNode = this.dependencies[0];
            if (componentNode) {
                const savedLimit = context.limit;
                const savedOffset = context.offsetValue;
                context.limit = null;
                context.offsetValue = 0;
                const baseResult = componentNode.execute(context);
                context.limit = savedLimit;
                context.offsetValue = savedOffset;
                baseEntityQuery = baseResult.sql;
                paramIndex = baseResult.context.paramIndex;
            }
        }

        // Gated single-pass rewrite: scan the base set ONCE and combine the OR
        // branches as a disjunction of EXISTS predicates, instead of embedding
        // the base SQL inside every branch and UNION-ing (N× base scan +
        // UNION dedup + redundant outer DISTINCT). Same param push order, same
        // result set, same ORDER BY entity_id ASC + pagination semantics.
        if (hasComponentDependency && baseEntityQuery && shouldUseOrSinglePass()) {
            return this.executeBaseSinglePass(context, baseEntityQuery, paramIndex);
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
                    AND c.type_id = $${componentIdParamIndex}                    AND c.deleted_at IS NULL`;
            } else {
                // Use original query without base
                const componentTableName = this.getComponentTableName(componentId);
                branchSql = `
                SELECT ec.entity_id
                FROM ${getMembershipTable()} ec
                WHERE ec.type_id = $${componentIdParamIndex} AND ec.deleted_at IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${componentTableName} c
                    WHERE c.entity_id = ec.entity_id
                    AND c.type_id = $${componentIdParamIndex}                    AND c.deleted_at IS NULL`;
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
                        case "ILIKE":
                            filterConditions.push(`${jsonPath} ${operator} $${paramIndex}`);
                            context.params.push(value);
                            paramIndex++;
                            break;
                        case "IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                filterConditions.push(`${cast.lhs(jsonPath)} IN (${placeholders})`);
                                context.params.push(...value);
                            }
                            break;
                        case "NOT IN":
                            if (Array.isArray(value)) {
                                const cast = jsonbInListCast(value);
                                const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                                filterConditions.push(`${cast.lhs(jsonPath)} NOT IN (${placeholders})`);
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
                    componentConditions.push(`EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_all WHERE ec_all.entity_id = or_results.entity_id AND ec_all.type_id = $${paramIndex} AND ec_all.deleted_at IS NULL)`);
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
            conditions.push(`NOT EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_ex WHERE ec_ex.entity_id = or_results.entity_id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
            context.params.push(...excludedTypes);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Add ordering (skipped when an outer sort wrapper re-orders the set)
        if (!context.suppressNodeOrdering) {
            sql += " ORDER BY entity_id";
        }

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
     * Build a single OR branch as an `EXISTS (...)` predicate against the
     * branch component's table, correlated to `idExpr` (e.g. `base.id`).
     * Mirrors the filter switch of the legacy dependency branch exactly —
     * same SQL fragments, same param push order — so the single-pass shape is
     * result- and parameter-identical to the UNION shape it replaces.
     */
    private buildBranchExists(
        branch: OrQuery['branches'][number],
        idExpr: string,
        context: QueryContext,
        paramIndex: number
    ): { sql: string; paramIndex: number } {
        const componentId = ComponentRegistry.getComponentId(branch.component.name);
        if (!componentId) {
            throw new Error(`Component ${branch.component.name} is not registered`);
        }

        const componentTableName = this.getComponentTableName(componentId);
        const componentIdParamIndex = paramIndex;

        let sql = `EXISTS (
            SELECT 1 FROM ${componentTableName} c
            WHERE c.entity_id = ${idExpr}
            AND c.type_id = $${componentIdParamIndex}
            AND c.deleted_at IS NULL`;

        context.params.push(componentId);
        paramIndex++;

        if (branch.filters && branch.filters.length > 0) {
            for (const filter of branch.filters) {
                const { field, operator, value } = filter;
                const jsonPath = `c.data->>'${field}'`;

                switch (operator) {
                    case "=":
                    case ">":
                    case "<":
                    case ">=":
                    case "<=":
                    case "!=":
                        if (typeof value === "string") {
                            sql += ` AND ${jsonPath} ${operator} $${paramIndex}`;
                        } else {
                            sql += ` AND (${jsonPath})::numeric ${operator} $${paramIndex}`;
                        }
                        context.params.push(value);
                        paramIndex++;
                        break;
                    case "LIKE":
                    case "ILIKE":
                        sql += ` AND ${jsonPath} ${operator} $${paramIndex}`;
                        context.params.push(value);
                        paramIndex++;
                        break;
                    case "IN":
                        if (Array.isArray(value)) {
                            const cast = jsonbInListCast(value);
                            const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                            sql += ` AND ${cast.lhs(jsonPath)} IN (${placeholders})`;
                            context.params.push(...value);
                        }
                        break;
                    case "NOT IN":
                        if (Array.isArray(value)) {
                            const cast = jsonbInListCast(value);
                            const placeholders = value.map(() => `$${paramIndex++}${cast.param}`).join(', ');
                            sql += ` AND ${cast.lhs(jsonPath)} NOT IN (${placeholders})`;
                            context.params.push(...value);
                        }
                        break;
                    default:
                        throw new Error(`Unsupported operator: ${operator}`);
                }
            }
        }

        sql += ")";
        return { sql, paramIndex };
    }

    /**
     * Single-pass execution for OR-on-base queries. The base set (the embedded
     * ComponentInclusionNode SQL) is referenced once; each OR branch becomes an
     * EXISTS predicate OR-ed together. Exclusions, ordering and pagination
     * match the UNION path exactly (the base node already applied exclusions —
     * re-applying here is the same idempotent no-op the UNION path performed).
     */
    private executeBaseSinglePass(
        context: QueryContext,
        baseEntityQuery: string,
        paramIndexStart: number
    ): QueryResult {
        let paramIndex = paramIndexStart;

        const existsClauses: string[] = [];
        for (const branch of this.orQuery.branches) {
            const built = this.buildBranchExists(branch, 'base.id', context, paramIndex);
            existsClauses.push(built.sql);
            paramIndex = built.paramIndex;
        }

        let sql = `SELECT base.id as id FROM (${baseEntityQuery}) AS base WHERE (${existsClauses.join(' OR ')})`;

        // Entity exclusions (idempotent — base already excluded them).
        if (context.excludedEntityIds.size > 0) {
            const excludedIds = Array.from(context.excludedEntityIds);
            const placeholders = excludedIds.map(() => `$${paramIndex++}`).join(', ');
            sql += ` AND base.id NOT IN (${placeholders})`;
            context.params.push(...excludedIds);
        }

        // Component exclusions (idempotent — base already excluded them).
        if (context.excludedComponentIds.size > 0) {
            const excludedTypes = Array.from(context.excludedComponentIds);
            const placeholders = excludedTypes.map(() => `$${paramIndex++}`).join(', ');
            sql += ` AND NOT EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_ex WHERE ec_ex.entity_id = base.id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`;
            context.params.push(...excludedTypes);
        }

        // Add ordering (skipped when an outer sort wrapper re-orders the set)
        if (!context.suppressNodeOrdering) {
            sql += " ORDER BY base.id";
        }

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

    public getNodeType(): string {
        return "OrNode";
    }
}