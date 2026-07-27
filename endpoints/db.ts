/**
 * DB access for the Studio endpoints.
 *
 * Studio is HTTP-reachable admin tooling that shares one connection pool with
 * user traffic. Before the execution seam it reached Postgres through raw
 * `db.unsafe` / tagged templates: no timeout, no cancellation, no metric, no
 * concurrency bound. A studio table scan and a customer's checkout competed for
 * the same slots on equal terms, and nothing recorded that they had.
 *
 * Two policies, applied here rather than at 21 call sites:
 *
 * LANE — everything here is `background`, capped at half the admission limit.
 * Admin tooling must never be able to lock user traffic out of the pool. It also
 * makes studio load attributable in `/metrics.dbAdmission`.
 *
 * ONE BUDGET PER REQUEST — `studioDeadline()` is called once per handler and the
 * same absolute deadline is passed to every query it issues. Per-query timeouts
 * would let a handler that runs six statements (or `archetypes.ts`, which loops
 * until it has filled a page) spend the full budget six times over, which is the
 * stacked-clock problem the seam exists to remove. The deadline covers waiting
 * for capacity as well as running, so a saturated pool fails the handler on time
 * instead of queueing it.
 *
 * Note the deadline is not a *statement* bound: an abandoned query keeps its
 * pooled slot until it finishes on its own (docs/POOLING.md B8a). It bounds the
 * handler and returns the admission permit; the server-side `statement_timeout`
 * is what stops the work.
 */
import { dbExec, isAdmissionTimeout } from "../database/gateway";
import { isPoolAcquisitionError } from "../database/poolErrors";

/**
 * Wall-clock budget for one studio request, across all of its queries.
 *
 * 15 s: generous for admin tooling that legitimately runs table scans and
 * `COUNT(*)` over un-indexed columns, far below the 30 s default that let a
 * studio tab hold pool slots while the API degraded.
 */
export const STUDIO_DB_TIMEOUT_MS = (() => {
    const raw = parseInt(process.env.BUNSANE_STUDIO_DB_TIMEOUT ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

/** Absolute deadline for one studio request. Call once per handler, then share it. */
export function studioDeadline(): number {
    return Date.now() + STUDIO_DB_TIMEOUT_MS;
}

/** Run a studio query in the background lane against a shared request deadline. */
export function studioExec<T = any>(
    label: string,
    deadline: number,
    sql: string,
    params?: any[],
): Promise<T> {
    return dbExec<T>(sql, params, { lane: "background", label, deadline });
}

/**
 * Map a handler failure to a response.
 *
 * Capacity failures are 503 + `Retry-After`, not 500: the request was never
 * attempted, retrying is the correct client behaviour, and reporting a saturated
 * pool as an internal error is what made the outage hard to read. Studio
 * handlers catch their own errors, so the equivalent mapping in
 * `core/app/requestRouter.ts` never sees them — hence this.
 */
export function studioErrorResponse(error: unknown, contextMessage: string): Response {
    if (isAdmissionTimeout(error) || isPoolAcquisitionError(error)) {
        return new Response(
            JSON.stringify({
                error: "Database capacity exhausted — the request was not attempted",
                code: "POOL_EXHAUSTED",
                retryable: true,
            }),
            {
                status: 503,
                headers: { "Content-Type": "application/json", "Retry-After": "1" },
            },
        );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: `${contextMessage}: ${message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
    });
}
