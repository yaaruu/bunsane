/**
 * Commit / rollback hooks keyed by transaction handle.
 *
 * Bun.SQL has no commit hook: a transaction committed when the promise
 * returned by `sql.begin(cb)` / `sql.transaction(cb)` resolves, and rolled back
 * when it rejects. `instrumentTransactions` wraps those two methods on the pool
 * instance, so every transaction opened through `db`, `getDb()` or
 * `dbTransaction` — framework or application — is tracked.
 *
 * `trx.savepoint(cb)` hands `cb` the SAME handle (Bun 1.4), so a savepoint is
 * a scope on the enclosing transaction's hook lists: hooks registered inside a
 * savepoint that rolls back are dropped (rollback hooks run), and hooks from a
 * released savepoint stay queued for the outer commit.
 *
 * A handle is tracked only while its transaction is open. Anything else — a
 * finished transaction, a `sql.reserve()` connection, a pool the framework did
 * not create — makes `onCommit` / `onRollback` return false, and the caller
 * decides the fallback.
 */
import type { SQL } from 'bun';
import { logger as MainLogger } from '../core/Logger';

const logger = MainLogger.child({ scope: 'txLifecycle' });

type Hook = () => void | Promise<void>;

interface TxHooks {
    commit: Hook[];
    rollback: Hook[];
}

const registry = new WeakMap<object, TxHooks>();

function hooksOf(trx: unknown): TxHooks | undefined {
    return (typeof trx === 'object' || typeof trx === 'function') && trx !== null
        ? registry.get(trx)
        : undefined;
}

/** True while `trx` is an open transaction whose end this module observes. */
export function isTrackedTransaction(trx: unknown): boolean {
    return hooksOf(trx) !== undefined;
}

/** Run `hook` after the transaction commits. False when `trx` is not tracked. */
export function onCommit(trx: unknown, hook: Hook): boolean {
    const hooks = hooksOf(trx);
    if (!hooks) return false;
    hooks.commit.push(hook);
    return true;
}

/** Run `hook` if the transaction (or the savepoint it was registered in) rolls back. False when untracked. */
export function onRollback(trx: unknown, hook: Hook): boolean {
    const hooks = hooksOf(trx);
    if (!hooks) return false;
    hooks.rollback.push(hook);
    return true;
}

async function runHooks(hooks: Hook[], phase: 'commit' | 'rollback'): Promise<void> {
    for (const hook of hooks) {
        try {
            await hook();
        } catch (err) {
            logger.error({ err, phase }, `transaction ${phase} hook threw`);
        }
    }
}

type Opener = (optionsOrFn: unknown, fn?: unknown) => Promise<unknown>;

/** Split Bun's `(fn)` / `(options, fn)` call shapes; null when there is no callback. */
function callbackOf(optionsOrFn: unknown, fn: unknown): ((trx: SQL) => Promise<unknown>) | null {
    const callback = typeof optionsOrFn === 'function' ? optionsOrFn : fn;
    return typeof callback === 'function' ? callback as (trx: SQL) => Promise<unknown> : null;
}

/** Savepoints on a tracked handle scope the hooks registered inside them. */
function trackSavepoints(trx: SQL, hooks: TxHooks): void {
    const original = Reflect.get(trx, 'savepoint') as Opener | undefined;
    if (typeof original !== 'function') return;
    const scoped: Opener = async (optionsOrFn, fn) => {
        const commitMark = hooks.commit.length;
        const rollbackMark = hooks.rollback.length;
        try {
            return await original.call(trx, optionsOrFn, fn);
        } catch (err) {
            hooks.commit.splice(commitMark);
            const undo = hooks.rollback.splice(rollbackMark);
            if (undo.length > 0) await runHooks(undo.reverse(), 'rollback');
            throw err;
        }
    };
    Reflect.set(trx, 'savepoint', scoped);
}

/**
 * Track every `begin` / `transaction` on a pool instance (Bun defines both as
 * the same own-property function). Commit hooks run after COMMIT, awaited
 * before the returned promise resolves; rollback hooks run newest-first when
 * it rejects, then the error is rethrown. Hook errors are logged, not thrown.
 */
export function instrumentTransactions(sql: SQL): void {
    const original = Reflect.get(sql, 'begin') as Opener;
    const tracked: Opener = async (optionsOrFn, fn) => {
        const userFn = callbackOf(optionsOrFn, fn);
        if (!userFn) return original(optionsOrFn, fn);

        let handle: SQL | undefined;
        const hooks: TxHooks = { commit: [], rollback: [] };
        const body = (trx: SQL): Promise<unknown> => {
            handle = trx;
            registry.set(trx, hooks);
            trackSavepoints(trx, hooks);
            return userFn(trx);
        };
        let result: unknown;
        try {
            result = await (typeof optionsOrFn === 'function' ? original(body) : original(optionsOrFn, body));
        } catch (err) {
            if (handle) registry.delete(handle);
            if (hooks.rollback.length > 0) await runHooks(hooks.rollback.reverse(), 'rollback');
            throw err;
        }
        if (handle) registry.delete(handle);
        if (hooks.commit.length > 0) await runHooks(hooks.commit, 'commit');
        return result;
    };
    Reflect.set(sql, 'begin', tracked);
    Reflect.set(sql, 'transaction', tracked);
}
