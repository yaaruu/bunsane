import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";

export class CTENode extends QueryNode {
    public execute(context: QueryContext): QueryResult {
        // Generate CTE for base entity filtering
        const componentIds = Array.from(context.componentIds);
        const excludedIds = Array.from(context.excludedComponentIds);

        if (componentIds.length === 0) {
            throw new Error("CTENode requires at least one component type to filter on");
        }

        let cteSql = "WITH base_entities AS (\n";

        // Build cursor condition for reuse across INTERSECT queries
        let cursorCondition = "";
        if (context.cursorId !== null) {
            const operator = context.cursorDirection === 'after' ? '>' : '<';
            cursorCondition = ` AND ec.entity_id ${operator} $${context.addParam(context.cursorId)}`;
        }

        // Build exclusion condition for reuse across INTERSECT queries
        let exclusionCondition = "";
        if (excludedIds.length > 0) {
            const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            exclusionCondition = ` AND NOT EXISTS (
                SELECT 1 FROM entity_components ec_ex
                WHERE ec_ex.entity_id = ec.entity_id
                AND ec_ex.type_id IN (${excludedPlaceholders})
                AND ec_ex.deleted_at IS NULL
            )`;
        }

        // Build entity exclusion condition for reuse
        let entityExclusionCondition = "";
        if (context.excludedEntityIds.size > 0) {
            const entityExcludedIds = Array.from(context.excludedEntityIds);
            const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            entityExclusionCondition = ` AND ec.entity_id NOT IN (${entityPlaceholders})`;
        }

        if (componentIds.length === 1) {
            // Single component - simple query, no INTERSECT needed
            const paramIdx = context.addParam(componentIds[0]);
            cteSql += `    SELECT DISTINCT ec.entity_id\n`;
            cteSql += `    FROM entity_components ec\n`;
            cteSql += `    WHERE ec.type_id = $${paramIdx}::text\n`;
            cteSql += `    AND ec.deleted_at IS NULL\n`;
            if (cursorCondition) cteSql += `    ${cursorCondition.trim()}\n`;
            if (exclusionCondition) cteSql += `    ${exclusionCondition.trim()}\n`;
            if (entityExclusionCondition) cteSql += `    ${entityExclusionCondition.trim()}\n`;
        } else {
            // Multiple components - use INTERSECT for much faster queries
            // INTERSECT allows PostgreSQL to use index scans independently per component
            // then efficiently merge results, avoiding Cartesian product explosion
            const intersectQueries = componentIds.map((compId) => {
                const paramIdx = context.addParam(compId);
                let subquery = `SELECT ec.entity_id FROM entity_components ec WHERE ec.type_id = $${paramIdx}::text AND ec.deleted_at IS NULL`;
                // Add cursor/exclusion conditions to each subquery for efficiency
                if (cursorCondition) subquery += cursorCondition;
                if (exclusionCondition) subquery += exclusionCondition;
                if (entityExclusionCondition) subquery += entityExclusionCondition;
                return `(${subquery})`;
            });
            cteSql += `    SELECT entity_id FROM (\n`;
            cteSql += `        ${intersectQueries.join('\n        INTERSECT\n        ')}\n`;
            cteSql += `    ) AS intersected\n`;
        }

        // Add ORDER BY for deterministic pagination results
        // Must be before LIMIT/OFFSET for consistent page results
        // Reverse order for 'before' cursor direction
        const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
        // Use correct column reference based on query structure
        const orderColumn = componentIds.length === 1 ? 'ec.entity_id' : 'entity_id';
        cteSql += `    ORDER BY ${orderColumn} ${orderDirection}\n`;

        // Check if there are component filters - if so, pagination must happen AFTER filtering
        // Otherwise we'd limit results before applying filters, causing incorrect results
        const hasComponentFilters = context.componentFilters.size > 0;

        // Add LIMIT/OFFSET at CTE level ONLY when there are no component filters
        // When filters exist, pagination must be applied after LATERAL joins filter the results
        if (!hasComponentFilters) {
            if (context.limit !== null) {
                cteSql += `    LIMIT $${context.addParam(context.limit)}\n`;
            }
            // Only include OFFSET when not using cursor-based pagination
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                cteSql += `    OFFSET $${context.addParam(context.offsetValue)}\n`;
            }
            // Mark pagination as handled at CTE level to prevent double application
            context.paginationAppliedInCTE = true;
        } else {
            // Pagination will be applied later, after filters
            context.paginationAppliedInCTE = false;
        }

        cteSql += ")";

        // Mark CTE as available in context
        context.hasCTE = true;
        context.cteName = "base_entities";

        return {
            sql: cteSql,
            params: context.params,
            context
        };
    }

    public getNodeType(): string {
        return "CTENode";
    }
}