/**
 * Transaction-aware cache invalidation.
 *
 * `comp.save(trx, id)` writes the DB but does no cache invalidation on its own.
 * Inside a tracked transaction we accumulate the (entityId, typeId) pairs that
 * were touched and, once the transaction COMMITS, run the same invalidation that
 * entity.save() uses (CacheManager.invalidateEntityComponents → deleteMany +
 * cross-instance pub/sub).
 *
 * Bun.SQL exposes no commit hook, so "on commit" means: after the
 * `db.transaction(cb)` promise resolves. The `transaction()` wrapper below owns
 * that boundary. Tracking is keyed by the trx object via a WeakMap, so
 * `trackComponentDirty` is a cheap no-op for any comp.save() that runs outside a
 * tracked transaction (top-level db, or entity.save() which handles its own
 * cache) — zero behavior change for existing callers.
 */
import { logger as MainLogger } from '../Logger';

const logger = MainLogger.child({ scope: 'TxCacheInvalidation' });

/** Anything carrying a component type_id — avoids a hard BaseComponent import (cycle). */
type ComponentRef = string | { _typeId?: string } | (new (...args: any[]) => any);

type SQLLike = Bun.SQL;

interface TxState {
    /** entityId -> set of touched component type_ids */
    dirty: Map<string, Set<string>>;
    onCommit: Array<() => void | Promise<void>>;
}

/** Tracking state keyed by the transaction's SQL handle. */
const txRegistry = new WeakMap<SQLLike, TxState>();

/** Begin tracking for a transaction handle. Idempotent. */
export function beginTxTracking(trx: SQLLike): TxState {
    let state = txRegistry.get(trx);
    if (!state) {
        state = { dirty: new Map(), onCommit: [] };
        txRegistry.set(trx, state);
    }
    return state;
}

export function getTxState(trx: SQLLike): TxState | undefined {
    return txRegistry.get(trx);
}

/**
 * Record that a component (entityId + typeId) was written under this trx.
 * No-op when the trx is not tracked (i.e. not inside transaction()).
 */
export function trackComponentDirty(trx: SQLLike, entityId: string, typeId: string): void {
    const state = txRegistry.get(trx);
    if (!state || !entityId || !typeId) return;
    let set = state.dirty.get(entityId);
    if (!set) {
        set = new Set();
        state.dirty.set(entityId, set);
    }
    set.add(typeId);
}

/** Resolve a component ctor / instance / raw typeId string to its type_id. */
function resolveTypeId(component: ComponentRef): string | null {
    if (typeof component === 'string') return component;
    // Instance carrying a _typeId (BaseComponent) — duck-typed to avoid an import cycle.
    const instanceTypeId = (component as { _typeId?: string })._typeId;
    if (typeof instanceTypeId === 'string' && instanceTypeId.length > 0) return instanceTypeId;
    // Constructor: derive from class name via metadata.
    if (typeof component === 'function') {
        try {
            const { getMetadataStorage } = require('../metadata');
            return getMetadataStorage().getComponentId(component.name);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Explicitly mark a component dirty for invalidation on commit.
 * Accepts a component constructor, instance, or raw type_id string.
 */
export function markDirty(trx: SQLLike, entityId: string, component: ComponentRef): void {
    const typeId = resolveTypeId(component);
    if (!typeId) {
        logger.warn({ entityId, msg: 'markDirty: could not resolve component type_id; skipping' });
        return;
    }
    trackComponentDirty(trx, entityId, typeId);
}

/** Register a callback to run after the transaction commits. */
export function registerOnCommit(trx: SQLLike, cb: () => void | Promise<void>): void {
    const state = beginTxTracking(trx);
    state.onCommit.push(cb);
}

/**
 * Flush accumulated invalidations + run onCommit callbacks. Call ONLY after the
 * transaction has committed. Errors are logged, never thrown — a cache flush
 * failure must not surface as a transaction failure (the data is already
 * committed; stale cache is recoverable, a thrown error is not).
 */
export async function flushTxTracking(state: TxState | undefined): Promise<void> {
    if (!state) return;
    try {
        if (state.dirty.size > 0) {
            const { CacheManager } = require('./CacheManager');
            const cacheManager = CacheManager.getInstance();
            await Promise.all(
                Array.from(state.dirty.entries()).map(([entityId, typeIds]) =>
                    cacheManager
                        .invalidateEntityComponents(entityId, Array.from(typeIds), { includeEntityKey: true })
                        .catch((error: unknown) =>
                            logger.error({ entityId, error, msg: 'Failed to invalidate entity components on commit' }),
                        ),
                ),
            );
        }
    } catch (error) {
        logger.error({ error, msg: 'Error during transaction cache flush' });
    }

    for (const cb of state.onCommit) {
        try {
            await cb();
        } catch (error) {
            logger.error({ error, msg: 'onCommit callback threw' });
        }
    }
}

/** Context handed to the transaction() callback for explicit control. */
export interface TxContext {
    /** Mark a component dirty for invalidation on commit. */
    markDirty(entityId: string, component: ComponentRef): void;
    /** Run a callback after the transaction commits (cache already flushed). */
    onCommit(cb: () => void | Promise<void>): void;
}

/**
 * Run a transaction with automatic, transaction-aware cache invalidation.
 *
 * Any `comp.save(trx, entityId)` performed with the provided `trx` is tracked
 * automatically; on commit, those components are invalidated using the same
 * logic entity.save() uses. The `tx` context adds explicit markDirty/onCommit
 * escape hatches.
 *
 * Invalidation runs inline (awaited) after commit, so when this resolves the
 * cache is already consistent.
 *
 * @example
 * ```typescript
 * await transaction(async (trx, tx) => {
 *   await positionComp.save(trx, entityId);   // auto-tracked
 *   tx.markDirty(entityId, Velocity);          // explicit
 *   tx.onCommit(() => metrics.bump());         // after commit
 * });
 * ```
 */
export async function transaction<T>(
    fn: (trx: SQLLike, tx: TxContext) => Promise<T>,
): Promise<T> {
    const { getDb } = require('../../database');
    const db: SQLLike = getDb();

    let state: TxState | undefined;
    const result = await db.transaction(async (trx: SQLLike) => {
        state = beginTxTracking(trx);
        const ctx: TxContext = {
            markDirty: (entityId, component) => markDirty(trx, entityId, component),
            onCommit: (cb) => registerOnCommit(trx, cb),
        };
        return await fn(trx, ctx);
    });

    // Transaction committed (resolved without throwing) → flush invalidations.
    await flushTxTracking(state);
    return result as T;
}
