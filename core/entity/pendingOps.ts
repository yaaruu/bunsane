// Drainable background-work tracking for Entity. Extracted from Entity.ts
// (RFC_REFACTOR_TARGETS §3.2). Module-level state owns the Sets; Entity
// keeps thin public static delegates for external callers.

// Drainable set of fire-and-forget cache ops triggered from set/remove.
// App.shutdown can await these to avoid losing writes mid-shutdown
// (H-CACHE-1).
const pendingCacheOps: Set<Promise<void>> = new Set();

// Drainable set of post-commit side-effect Promises scheduled via
// queueMicrotask from save(). Includes cache invalidation + lifecycle
// hooks (EntityCreated / EntityUpdated). Hooks may transitively trigger
// more DB work (e.g., entity.save() from a handler), which is why this
// is tracked separately from pendingCacheOps. Tests running against
// PGlite's single-connection pool should drain this between test files
// to prevent background work from prior files queueing behind the
// current file's save and masking visibility of recently-committed
// rows. See BUNSANE-001.
const pendingSideEffects: Set<Promise<void>> = new Set();

/**
 * Await all pending background cache operations. Call during shutdown
 * after HTTP drain but before cache.disconnect so setImmediate'd cache
 * writes are not lost. Bounded by `timeoutMs`.
 */
export async function drainPendingCacheOps(timeoutMs: number = 5_000): Promise<void> {
    if (pendingCacheOps.size === 0) return;
    const snapshot = [...pendingCacheOps];
    const drainTimer = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), timeoutMs);
        t.unref?.();
    });
    await Promise.race([
        Promise.allSettled(snapshot).then(() => 'drained' as const),
        drainTimer,
    ]);
}

/**
 * Await all pending post-commit side effects (cache invalidation +
 * lifecycle hooks scheduled via queueMicrotask from save()). Call from
 * test setup/teardown hooks under PGlite to guarantee prior-file
 * background work has settled before the next file's saves run. Bounded
 * by `timeoutMs`. Safe to call repeatedly; no-op when the set is empty.
 */
export async function drainPendingSideEffects(timeoutMs: number = 5_000): Promise<void> {
    if (pendingSideEffects.size === 0) return;
    const snapshot = [...pendingSideEffects];
    const drainTimer = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), timeoutMs);
        t.unref?.();
    });
    await Promise.race([
        Promise.allSettled(snapshot).then(() => 'drained' as const),
        drainTimer,
    ]);
}

/**
 * Track a fire-and-forget cache promise in the drainable set. Public so
 * other framework read paths (e.g. Query.populateComponents cache
 * warming) share the same drain semantics (H-CACHE-1).
 */
export function trackCacheOp(p: Promise<void>): void {
    pendingCacheOps.add(p);
    p.finally(() => pendingCacheOps.delete(p));
}

export function trackSideEffect(p: Promise<void>): void {
    pendingSideEffects.add(p);
    p.finally(() => pendingSideEffects.delete(p));
}
