import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";

export class SourceNode extends QueryNode {
    public execute(context: QueryContext): QueryResult {
        let sql = "SELECT id FROM entities WHERE deleted_at IS NULL";

        if (context.withId) {
            sql += ` AND id = $${context.addParam(context.withId)}`;
        }

        // Add entity exclusions if any
        if (context.excludedEntityIds.size > 0) {
            const excludedIds = Array.from(context.excludedEntityIds);
            // Fix: Use the id directly instead of shift() which mutates the array
            const placeholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            sql += ` AND id NOT IN (${placeholders})`;
        }

        sql += " ORDER BY id";

        // Only apply pagination if CTENode hasn't already applied it
        // This prevents double parameter addition and incorrect SQL
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Always include OFFSET when pagination is used for consistent SQL structure
            if (context.offsetValue > 0 || context.limit !== null) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return {
            sql,
            params: context.params,
            context
        };
    }

    public getNodeType(): string {
        return "SourceNode";
    }
}