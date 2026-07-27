/**
 * Wraps a Bun SQL Query so an AbortSignal can stop the caller waiting on an
 * in-flight query, requesting cancellation via `query.cancel()` first.
 *
 * WHAT THIS DOES NOT DO — measured, not assumed (ticket B8a):
 *
 *   `query.cancel()` does not cancel anything server-side. On Bun
 *   1.4.0-canary.1 it issues no Postgres CancelRequest: watched from a second
 *   connection, the backend running `pg_sleep(8)` stayed `active` at every
 *   sample from 1.3 s to 7.7 s after `cancel()` was called at 0.4 s, then the
 *   query RESOLVED (not rejected) at 8.0 s — its natural end. The `cancel()`
 *   promise likewise resolves only when the statement finishes on its own.
 *
 *   This is a DRIVER property, not a pooling one. An earlier revision of this
 *   comment blamed cancel-forwarding through pgbouncer; re-measuring on a direct
 *   connection gave the same slot-recovery time to within 1 ms (5010 ms direct
 *   vs 5009 ms pooled, for a 5000 ms statement), and the probe above was
 *   re-run with three pool slots free to rule out the cancel channel being
 *   queued behind the query it targets. Session pooling does NOT fix this.
 *
 *   So: this bounds the CALLER's wait. It does not bound the STATEMENT, and it
 *   is not a recovery mechanism for slot exhaustion. The only effective bound on
 *   a statement is server-side — `ALTER ROLE <user> SET statement_timeout` for a
 *   universal ceiling, or `SET LOCAL statement_timeout` inside a transaction
 *   (killed a 6 s statement at 1.21 s with the slot reusable 1-2 ms later, on
 *   both topologies). See docs/POOLING.md.
 *
 * Rejection on abort is immediate (raced) rather than waiting for the driver to
 * honor the cancel — some drivers (PGlite socket bridge) ignore `cancel()`
 * entirely and would otherwise hang the caller until the query finishes on its
 * own. The query's eventual settle is swallowed so it can't surface as an
 * unhandled rejection after the race is lost.
 */

/**
 * BUNSANE_ABORT_MODE — TEMPORARY, for bisecting ticket B8b (pool slots that
 * never returned after a timeout, mechanism still undetermined).
 *
 *   'cancel' (default, current behaviour) — request cancellation, then reject.
 *   'off'                                 — reject without touching the query,
 *                                           so a deployment can test whether
 *                                           `cancel()` itself is what wedges
 *                                           the connection.
 *
 * As of the 2026-07-27 measurements the two modes are equivalent from the
 * SERVER's point of view — `cancel()` sends nothing — so this switch can only
 * bisect client-side effects (driver state corruption), never slot recovery.
 *
 * Read at call time so it can be flipped without a restart in a test harness.
 *
 * There is deliberately no 'destroy' mode: Bun SQL exposes no way to destroy a
 * single pooled connection (`SQL.close()` closes the whole pool), and shipping a
 * mode whose name promises an action it cannot perform is the precise
 * silently-lying-in-the-safe-direction pattern this release exists to remove.
 *
 * DELETE this switch once experiments E1–E3 identify the mechanism.
 */
export type AbortMode = 'cancel' | 'off';

export function abortMode(): AbortMode {
    return process.env.BUNSANE_ABORT_MODE === 'off' ? 'off' : 'cancel';
}
/**
 * Forward an upstream abort (e.g. the request-scoped `req.signal`) onto a
 * locally-owned controller, so a caller-supplied signal and an internal
 * wall-clock timeout can share one signal without either being dropped.
 * Hand-rolled rather than `AbortSignal.any` for runtime portability.
 * Returns an unlink function; call it when the operation settles.
 */
export function linkAbortSignals(upstream: AbortSignal | undefined, controller: AbortController): () => void {
    if (!upstream) return () => { /* nothing to unlink */ };
    if (upstream.aborted) {
        controller.abort(upstream.reason);
        return () => { /* already settled */ };
    }
    const onAbort = () => controller.abort(upstream.reason);
    upstream.addEventListener('abort', onAbort, { once: true });
    return () => upstream.removeEventListener('abort', onAbort);
}

export async function runWithSignal<T>(q: any, signal?: AbortSignal): Promise<T> {
    if (!signal) return await q;
    const requestCancel = () => {
        if (abortMode() === 'off') return;
        try { q.cancel?.(); } catch { /* ignore */ }
    };
    if (signal.aborted) {
        requestCancel();
        throw signal.reason ?? new Error('Query aborted');
    }
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
            requestCancel();
            Promise.resolve(q).catch(() => { /* swallow post-abort settle */ });
            reject(signal.reason ?? new Error('Query aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([q, abortPromise]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}
