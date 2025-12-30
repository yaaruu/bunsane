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
            const placeholders = excludedIds.map(() => `$${context.addParam(excludedIds.shift())}`).join(', ');
            sql += ` AND id NOT IN (${placeholders})`;
        }

        sql += " ORDER BY id";

        // Always include OFFSET (even when 0) to ensure consistent SQL structure for prepared statement caching
        if (context.limit !== null) {
            sql += ` LIMIT $${context.addParam(context.limit)}`;
        }
        sql += ` OFFSET $${context.addParam(context.offsetValue)}`;

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