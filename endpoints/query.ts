import db from "../database";
import type { StudioQueryRequest, StudioQueryResponse } from "./types";

const FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|EXECUTE|DO)\b/i;
const MAX_ROWS = 500;
const QUERY_TIMEOUT_MS = 10_000;

export async function handleStudioQueryRequest(
    requestBody: StudioQueryRequest
): Promise<Response> {
    // Only allow in non-production
    if (process.env.NODE_ENV === "production") {
        return new Response(
            JSON.stringify({ error: "Query runner is disabled in production" }),
            {
                status: 403,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    const { sql } = requestBody;

    if (!sql || typeof sql !== "string" || sql.trim().length === 0) {
        return new Response(
            JSON.stringify({ error: "SQL query is required" }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    const trimmed = sql.trim();

    // Block write operations
    if (FORBIDDEN_KEYWORDS.test(trimmed)) {
        return new Response(
            JSON.stringify({
                error: "Only read-only (SELECT) queries are allowed",
            }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    // Enforce LIMIT if not present
    const hasLimit = /\bLIMIT\b/i.test(trimmed);
    const queryToRun = hasLimit ? trimmed : `${trimmed} LIMIT ${MAX_ROWS}`;

    try {
        const startTime = Date.now();

        const result = await Promise.race([
            db.unsafe(queryToRun),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error("Query timed out")),
                    QUERY_TIMEOUT_MS
                )
            ),
        ]);

        const duration = Date.now() - startTime;

        const rows = Array.isArray(result) ? result : [];
        const columns =
            rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];

        const responseData: StudioQueryResponse = {
            columns,
            rows: rows.slice(0, MAX_ROWS) as Record<string, unknown>[],
            rowCount: rows.length,
            duration,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: errorMessage }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}
