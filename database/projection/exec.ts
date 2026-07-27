/**
 * DB access for projection maintenance (schema sync, backfill, reconcile).
 *
 * All of it is `background` lane: backfill and reconcile are unbounded sweeps
 * over user data that legitimately take minutes, and before the seam they
 * competed for pool slots with request traffic on equal terms and with no
 * timeout. The lane caps them at half the admission limit, so a running backfill
 * can never be the reason a user request cannot get a connection.
 *
 * NOT everything in these modules routes through here. Statements that execute
 * on a caller-supplied `trx` handle — `ProjectionManager.setStatus(…, trx)`, the
 * dual-write in `applyProjection`, `DDLGenerator`'s `executor(trx)` — stay on
 * the raw handle until their enclosing transaction is itself migrated
 * (`saveEntity`, W2 slice 4). Routing them now would take an admission permit
 * while the caller's transaction already holds a pooled connection, which is the
 * nested-acquire deadlock the seam exists to prevent: admission is per
 * TRANSACTION, and there is no admitted scope to inherit until the transaction
 * owner opens it via `dbTransaction`.
 */
import { dbExec } from '../gateway';
import { DDL_TIMEOUT_MS } from '../index';

/** A projection query or DML statement on the pool, in the background lane. */
export function projExec<T = any>(
    label: string,
    sql: string,
    params?: any[],
    timeoutMs?: number,
): Promise<T> {
    // Server-side bound opted in: these are sweeps over user data, so ~1 ms of
    // transaction wrapper is nothing against them, and a runaway one holding a
    // pool slot indefinitely is the failure this exists to prevent. Deliberately
    // NOT on `projDdl` below.
    return dbExec<T>(sql, params, { lane: 'background', label, timeoutMs, serverTimeout: true });
}

/**
 * Projection schema DDL (`ALTER TABLE … ADD COLUMN`, index creation).
 *
 * Long budget for the same reason as `IndexingStrategy`: DDL outlives a query
 * timeout by design, and aborting it does not stop the server-side work.
 *
 * No `serverTimeout` here, and it is not an oversight: it would open a
 * transaction, and `CREATE INDEX CONCURRENTLY` cannot run inside one. PGlite
 * strips CONCURRENTLY (`USE_PGLITE` guard in `DDLGenerator`), so that mistake
 * would pass the PGlite suite and fail only on real Postgres.
 */
export function projDdl<T = any>(label: string, sql: string, params?: any[]): Promise<T> {
    return dbExec<T>(sql, params, { lane: 'background', label, timeoutMs: DDL_TIMEOUT_MS });
}
