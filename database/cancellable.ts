/**
 * Wraps a Bun SQL Query so an AbortSignal can cancel the in-flight query
 * via the underlying `query.cancel()` method. When the signal fires the
 * server-side query receives a cancel request, the awaited promise rejects,
 * any enclosing transaction triggers ROLLBACK, and the pooled backend
 * connection is released. Without this, a wall-clock timeout leaks the
 * backend into `idle in transaction` under pgbouncer transaction-mode.
 *
 * Rejection on abort is immediate (raced) rather than waiting for the
 * driver to honor the cancel — some drivers (PGlite socket bridge) ignore
 * `cancel()` entirely and would otherwise hang the caller until the query
 * finishes on its own. The query's eventual settle is swallowed so it can't
 * surface as an unhandled rejection after the race is lost.
 */
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
    if (signal.aborted) {
        try { q.cancel?.(); } catch { /* ignore */ }
        throw signal.reason ?? new Error('Query aborted');
    }
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
            try { q.cancel?.(); } catch { /* ignore */ }
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
