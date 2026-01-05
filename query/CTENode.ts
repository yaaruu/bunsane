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
        cteSql += "    SELECT DISTINCT ec.entity_id\n";
        cteSql += "    FROM entity_components ec\n";
        cteSql += "    WHERE ec.type_id IN (";

        // Add component type placeholders
        const typePlaceholders = componentIds.map((_, index) => `$${context.addParam(componentIds[index])}`).join(', ');
        cteSql += typePlaceholders + ")\n";
        cteSql += "    AND ec.deleted_at IS NULL\n";

        // Add exclusions if any
        if (excludedIds.length > 0) {
            const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            cteSql += `    AND NOT EXISTS (\n`;
            cteSql += `        SELECT 1 FROM entity_components ec_ex\n`;
            cteSql += `        WHERE ec_ex.entity_id = ec.entity_id\n`;
            cteSql += `        AND ec_ex.type_id IN (${excludedPlaceholders})\n`;
            cteSql += `        AND ec_ex.deleted_at IS NULL\n`;
            cteSql += `    )\n`;
        }

        // Add entity exclusions if any
        if (context.excludedEntityIds.size > 0) {
            const entityExcludedIds = Array.from(context.excludedEntityIds);
            const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            cteSql += `    AND ec.entity_id NOT IN (${entityPlaceholders})\n`;
        }

        // Group by entity_id to count distinct component types
        // This ensures entities have ALL required components
        cteSql += `    GROUP BY ec.entity_id\n`;
        cteSql += `    HAVING COUNT(DISTINCT ec.type_id) >= $${context.addParam(componentIds.length)}\n`;

        // Add ORDER BY for deterministic pagination results
        // Must be before LIMIT/OFFSET for consistent page results
        cteSql += `    ORDER BY ec.entity_id\n`;

        // Check if there are component filters - if so, pagination must happen AFTER filtering
        // Otherwise we'd limit results before applying filters, causing incorrect results
        const hasComponentFilters = context.componentFilters.size > 0;

        // Add LIMIT/OFFSET at CTE level ONLY when there are no component filters
        // When filters exist, pagination must be applied after LATERAL joins filter the results
        if (!hasComponentFilters) {
            if (context.limit !== null) {
                cteSql += `    LIMIT $${context.addParam(context.limit)}\n`;
            }
            if (context.offsetValue > 0 || context.limit !== null) {
                // Always include OFFSET when pagination is used for consistent SQL structure
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