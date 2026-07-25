/**
 * PostgresLeaseLockBackend — pooler-safe distributed lock via a lease-row table.
 *
 * Each operation (acquire / renew / release) is a SINGLE autocommit statement,
 * so it runs in exactly one transaction on one backend. That makes it correct
 * behind pgbouncer `pool_mode = transaction` — unlike session advisory locks,
 * which strand when lock and unlock land on different backends (BUNSANE-1). It
 * also keys on the raw text `key`, so distinct keys never collide (no 32-bit
 * hash folding — BUNSANE-4).
 *
 * Crash safety: a holder owns `key` until it deletes its row OR `expires_at`
 * passes. A crashed holder's lease lapses after `ttlMs` and the next acquirer
 * steals it. Long-running work must `renew` before the lease elapses (the
 * DistributedLock/withLock layer drives a heartbeat).
 *
 * Fencing: `owner` is a per-acquisition random token. renew/release act only on
 * `key = $key AND owner = $token`, so a holder whose lease expired and was
 * stolen cannot renew or release the new holder's lease (returns false — the
 * canonical lost-lease signal).
 *
 * The table is created lazily and idempotently on first use, so `withLock`
 * works even without a full `App.init()` migration pass.
 */

import { randomUUID } from "crypto";
import type { SQL } from "bun";
import db from "../../../database";
import { logger } from "../../Logger";
import type { AcquireOptions, LockBackend, LockHandle } from "./LockBackend";

const loggerInstance = logger.child({ scope: "PostgresLeaseLockBackend" });

const TABLE = "bunsane_locks";
const DEFAULT_TTL_MS = 30_000;

export interface PostgresLeaseBackendConfig {
    enableLogging: boolean;
}

export class PostgresLeaseLockBackend implements LockBackend {
    readonly name = "postgres-lease";
    private config: PostgresLeaseBackendConfig;
    private readonly sql: SQL;
    /** Runs the idempotent table create exactly once per backend instance. */
    private tableReady: Promise<void> | null = null;

    constructor(config: Partial<PostgresLeaseBackendConfig> = {}, sql: SQL = db) {
        this.config = { enableLogging: config.enableLogging ?? false };
        this.sql = sql;
    }

    private ensureTable(): Promise<void> {
        if (!this.tableReady) {
            this.tableReady = this.sql
                .unsafe(
                    `CREATE TABLE IF NOT EXISTS ${TABLE} (
                        key text PRIMARY KEY,
                        owner text NOT NULL,
                        expires_at timestamptz NOT NULL
                    )`
                )
                .then(() => undefined)
                .catch((err) => {
                    // Reset so a transient failure (pool exhausted at boot)
                    // retries on the next call rather than caching the reject.
                    this.tableReady = null;
                    throw err;
                });
        }
        return this.tableReady;
    }

    async acquire(key: string, opts?: AcquireOptions): Promise<LockHandle | null> {
        const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        const token = randomUUID();
        try {
            await this.ensureTable();
            // Fresh insert OR steal of an expired lease both RETURN a row whose
            // owner is us. A live foreign lease fails the conditional UPDATE and
            // RETURNING yields zero rows.
            const rows = await this.sql.unsafe(
                `INSERT INTO ${TABLE} (key, owner, expires_at)
                 VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
                 ON CONFLICT (key) DO UPDATE
                     SET owner = excluded.owner, expires_at = excluded.expires_at
                     WHERE ${TABLE}.expires_at < now()
                 RETURNING (owner = $2) AS acquired`,
                [key, token, ttlMs]
            );
            const acquired = rows.length > 0 && rows[0]?.acquired === true;
            if (!acquired) return null;

            if (this.config.enableLogging) {
                loggerInstance.debug(`Acquired lease ${key} (ttl ${ttlMs}ms)`);
            }
            return { key, token, expiresAt: Date.now() + ttlMs };
        } catch (error) {
            loggerInstance.error(
                `Error acquiring lease ${key}: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
        }
    }

    async renew(handle: LockHandle, ttlMs: number): Promise<boolean> {
        try {
            const rows = await this.sql.unsafe(
                `UPDATE ${TABLE}
                 SET expires_at = now() + ($3::bigint * interval '1 millisecond')
                 WHERE key = $1 AND owner = $2 AND expires_at > now()
                 RETURNING 1 AS renewed`,
                [handle.key, handle.token, ttlMs]
            );
            return rows.length > 0;
        } catch (error) {
            loggerInstance.error(
                `Error renewing lease ${handle.key}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    async release(handle: LockHandle): Promise<boolean> {
        try {
            // Delete only our own row. A row stolen after our lease lapsed has a
            // different owner → 0 rows → false (lost-lease signal).
            const rows = await this.sql.unsafe(
                `DELETE FROM ${TABLE}
                 WHERE key = $1 AND owner = $2
                 RETURNING 1 AS released`,
                [handle.key, handle.token]
            );
            const released = rows.length > 0;
            // A 0-row release (lease stolen / already gone) is surfaced loudly
            // by the DistributedLock facade; keep the backend log at debug to
            // avoid double-logging.
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    released
                        ? `Released lease ${handle.key}`
                        : `Lease release for ${handle.key} affected 0 rows (stolen or already released)`
                );
            }
            return released;
        } catch (error) {
            loggerInstance.error(
                `Error releasing lease ${handle.key}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    async dispose(): Promise<void> {
        // Stateless aside from the table-ready cache; nothing to release. Rows
        // self-expire via TTL; an explicit releaseAll() at the DistributedLock
        // layer deletes still-held leases on graceful shutdown.
        this.tableReady = null;
    }
}
