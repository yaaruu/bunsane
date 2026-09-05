import { studioReadOnlyQuery, studioErrorResponse } from "./db";
import { assertRunnableSingleSelect } from "./sqlGuard";
import { isAdmissionTimeout } from "../database/gateway";
import { isPoolAcquisitionError } from "../database/poolErrors";
import type { StudioQueryRequest, StudioQueryResponse } from "./types";

const MAX_ROWS = 500;
const QUERY_TIMEOUT_MS = 10_000;

/**
 * SEC-02: the runner exists only when explicitly opted in. The previous gate
 * (`NODE_ENV !== 'production'`) left it enabled whenever the variable was
 * unset — which is the common state in dev containers, CI images and staging.
 */
function isStudioQueryEnabled(): boolean {
    const v = process.env.BUNSANE_STUDIO_QUERY;
    return v === "on" || v === "true";
}

function notFound(): Response {
    return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Short classified failure text instead of raw Postgres internals. The
 * verbose message stays available to operators via server logs; clients of
 * an unauthenticated-capable endpoint do not need `relation "x"` detail.
 */
function classifyQueryError(message: string): string {
    if (/syntax error/i.test(message)) return "Syntax error in SQL statement";
    if (/does not exist/i.test(message)) return "Relation or column does not exist";
    if (/permission denied/i.test(message)) return "Permission denied";
    if (/canceling statement due to (statement )?timeout|statement timeout/i.test(message)) {
        return "Query timed out";
    }
    if (/must appear in the GROUP BY|aggregate functions/i.test(message)) {
        return "Invalid aggregate/GROUP BY usage";
    }
    return "Query failed";
}

export async function handleStudioQueryRequest(
    requestBody: StudioQueryRequest
): Promise<Response> {
    // Explicit opt-in only — default OFF regardless of NODE_ENV (SEC-02).
    if (!isStudioQueryEnabled()) {
        return notFound();
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

    // Literal/comment-aware vetting: single statement, read-only keywords
    // only. The old regex checks were fooled by text inside comments and
    // string literals, and missed SET/CALL/VACUUM/MERGE entirely.
    const guard = assertRunnableSingleSelect(sql);
    if (!guard.ok || !guard.statement) {
        return new Response(
            JSON.stringify({ error: guard.error ?? "Rejected" }),
            {
                status: guard.status,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    // Server-side row bound on EVERY query. Wrapping as a derived table means
    // a comment containing "LIMIT" can no longer suppress the limit, and the
    // full result set never reaches this process. A trailing terminator was
    // already removed by the guard.
    const wrapped = `SELECT * FROM (${guard.statement}) _bunsane_studio_q LIMIT ${MAX_ROWS}`;

    try {
        const startTime = Date.now();

        const result = await studioReadOnlyQuery<unknown>(
            "studio.query.adhoc",
            Date.now() + QUERY_TIMEOUT_MS,
            wrapped,
        );

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
        if (isAdmissionTimeout(error) || isPoolAcquisitionError(error)) {
            return studioErrorResponse(error, "Query failed");
        }
        const rawMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: classifyQueryError(rawMessage) }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}
