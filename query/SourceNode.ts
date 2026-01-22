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

        // Apply cursor-based pagination (more efficient than OFFSET)
        if (context.cursorId !== null) {
            const operator = context.cursorDirection === 'after' ? '>' : '<';
            sql += ` AND id ${operator} $${context.addParam(context.cursorId)}`;
        }

        // Order by id - reverse for 'before' cursor direction
        const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
        sql += ` ORDER BY id ${orderDirection}`;

        // Only apply pagination if CTENode hasn't already applied it
        // This prevents double parameter addition and incorrect SQL
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Only include OFFSET when not using cursor-based pagination
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
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