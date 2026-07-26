/**
 * Classification of pool-acquisition failures.
 *
 * `connectionTimeout` (DB_CONNECTION_TIMEOUT) expiring means the caller waited
 * for a free pool slot and never got one — the statement never reached the
 * server. That is a capacity signal, not a query fault, and it must surface as
 * a fast, labelled 503 (retryable) rather than a generic 500: a 500 tells the
 * client the request was wrong, when in fact the server was simply full.
 *
 * Kept in its own module so `database/index.ts` (pool construction) and
 * `database/instrumentedDb.ts` (metrics) can both use it without an import
 * cycle.
 */

/** Bun SQL's code when the pool wait expires before a slot frees. */
export const POOL_ACQUIRE_TIMEOUT_CODE = 'ERR_POSTGRES_CONNECTION_TIMEOUT';

export function isPoolAcquisitionError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return code === POOL_ACQUIRE_TIMEOUT_CODE;
}
