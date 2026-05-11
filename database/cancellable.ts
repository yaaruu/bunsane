/**
 * Wraps a Bun SQL Query so an AbortSignal can cancel the in-flight query
 * via the underlying `query.cancel()` method. When the signal fires the
 * server-side query receives a cancel request, the awaited promise rejects,
 * any enclosing transaction triggers ROLLBACK, and the pooled backend
 * connection is released. Without this, a wall-clock timeout leaks the
 * backend into `idle in transaction` under pgbouncer transaction-mode.
 */
export async function runWithSignal<T>(q: any, signal?: AbortSignal): Promise<T> {
    if (!signal) return await q;
    if (signal.aborted) {
        try { q.cancel?.(); } catch { /* ignore */ }
        throw signal.reason ?? new Error('Query aborted');
    }
    const onAbort = () => { try { q.cancel?.(); } catch { /* ignore */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await q;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
