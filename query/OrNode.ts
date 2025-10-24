import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { OrQuery } from "./OrQuery";
import ComponentRegistry from "../core/ComponentRegistry";

export class OrNode extends QueryNode {
    private orQuery: OrQuery;

    constructor(orQuery: OrQuery) {
        super();
        this.orQuery = orQuery;
    }

    public execute(context: QueryContext): QueryResult {
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

            let branchSql: string;

            if (hasComponentDependency) {
                // Filter entities from base query (ComponentInclusionNode returns 'id' column)
                branchSql = `
                SELECT base.id as entity_id
                FROM (${baseEntityQuery}) AS base
                WHERE EXISTS (
                    SELECT 1 FROM components c
                    WHERE c.entity_id = base.id
                    AND c.type_id = $${paramIndex}
                    AND c.deleted_at IS NULL
                    AND c.created_at = (
                        SELECT MAX(c2.created_at)
                        FROM components c2
                        WHERE c2.entity_id = c.entity_id
                        AND c2.type_id = c.type_id
                        AND c2.deleted_at IS NULL
                    )`;
            } else {
                // Use original query without base
                branchSql = `
                SELECT ec.entity_id
                FROM entity_components ec
                WHERE ec.type_id = $${paramIndex} AND ec.deleted_at IS NULL
                AND EXISTS (
                    SELECT 1 FROM components c
                    WHERE c.entity_id = ec.entity_id
                    AND c.type_id = $${paramIndex}
                    AND c.deleted_at IS NULL
                    AND c.created_at = (
                        SELECT MAX(c2.created_at)
                        FROM components c2
                        WHERE c2.entity_id = c.entity_id
                        AND c2.type_id = c.type_id
                        AND c2.deleted_at IS NULL
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
                    componentConditions.push(`EXISTS (SELECT 1 FROM entity_components ec_all WHERE ec_all.entity_id = or_results.entity_id AND ec_all.type_id = $${paramIndex} AND ec_all.deleted_at IS NULL)`);
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
            conditions.push(`NOT EXISTS (SELECT 1 FROM entity_components ec_ex WHERE ec_ex.entity_id = or_results.entity_id AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`);
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