/**
 * Distributed Lock using PostgreSQL Advisory Locks
 *
 * PostgreSQL advisory locks are session-level (bound to the connection that
 * acquired them). Bun's SQL pool hands out a different connection per query,
 * so naively calling `pg_try_advisory_lock` on the pooled client leaves the
 * lock stranded on whichever connection was used — `pg_advisory_unlock` on a
 * different connection silently returns `false` and the lock is held until
 * that connection eventually closes.
 *
 * Fix: reserve a dedicated connection via `sql.reserve()` once per instance
 * and route every lock/unlock query through it. All locks owned by this
 * instance live in one PostgreSQL session, so unlock always hits the session
 * that acquired the lock. If the process crashes, PostgreSQL terminates the
 * session and every held lock is released automatically — no cleanup needed.
 *
 * The reservation is lazy (acquired on first use) and released when either
 * `releaseAll()` is called or no locks remain outstanding, so idle instances
 * do not permanently consume a pool slot.
 *
 * @see https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
 */

import type { ReservedSQL } from "bun";
import db from "../../database";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "DistributedLock" });

export interface LockResult {
    acquired: boolean;
    lockKey: bigint;
    taskId: string;
}

export interface DistributedLockConfig {
    enabled: boolean;
    lockKeyPrefix: number;
    enableLogging: boolean;
    /** Timeout for lock acquisition attempts in ms (0 = no retry) */
    lockTimeout: number;
    /** Retry interval when lockTimeout > 0 */
    retryInterval: number;
}

export const DEFAULT_LOCK_CONFIG: DistributedLockConfig = {
    enabled: true,
    lockKeyPrefix: 0x42554E53, // "BUNS" in hex as a namespace prefix
    enableLogging: false,
    lockTimeout: 0,
    retryInterval: 100,
};

export class DistributedLock {
    private config: DistributedLockConfig;
    private heldLocks: Set<string> = new Set();
    private reservedConn: ReservedSQL | null = null;
    private reservePromise: Promise<ReservedSQL> | null = null;

    constructor(config: Partial<DistributedLockConfig> = {}) {
        this.config = { ...DEFAULT_LOCK_CONFIG, ...config };
    }

    private generateLockKey(taskId: string): bigint {
        let hash = 0;
        for (let i = 0; i < taskId.length; i++) {
            const char = taskId.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        hash = Math.abs(hash);

        const prefix = BigInt(this.config.lockKeyPrefix);
        const hashBigInt = BigInt(hash >>> 0);
        return (prefix << 32n) | hashBigInt;
    }

    /**
     * Lazily reserve one dedicated connection that owns every advisory lock
     * this instance takes. Concurrent callers share the same reservation via
     * `reservePromise`.
     */
    private async ensureReserved(): Promise<ReservedSQL> {
        if (this.reservedConn) return this.reservedConn;
        if (!this.reservePromise) {
            // On reject (pool exhausted, shutdown mid-reserve), null the
            // promise so subsequent callers retry a fresh reserve instead of
            // receiving the same rejected promise forever (H-DB-2).
            this.reservePromise = db.reserve().then(
                (conn) => {
                    this.reservedConn = conn;
                    this.reservePromise = null;
                    return conn;
                },
                (err) => {
                    this.reservePromise = null;
                    throw err;
                }
            );
        }
        return this.reservePromise;
    }

    /**
     * Release the pinned connection back to the pool. Only safe when no
     * advisory locks are currently held on this instance — otherwise the
     * session would be closed and locks forfeited.
     */
    private releaseReservation(): void {
        if (!this.reservedConn) return;
        try {
            this.reservedConn.release();
        } catch (error) {
            loggerInstance.warn(
                `Failed to release reserved connection: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        this.reservedConn = null;
    }

    /**
     * Try to acquire a distributed lock for a task. Non-blocking when
     * `lockTimeout` is 0 (default); retries every `retryInterval` ms up to
     * `lockTimeout` otherwise.
     */
    async tryAcquire(taskId: string): Promise<LockResult> {
        if (!this.config.enabled) {
            return { acquired: true, lockKey: 0n, taskId };
        }

        const lockKey = this.generateLockKey(taskId);

        if (this.heldLocks.has(taskId)) {
            // Defense in depth: if this instance already holds the lock for
            // taskId, a second concurrent acquirer would mean overlapping
            // execution (retry firing while previous run is still in the
            // finally → release step, for example). Return acquired:false so
            // the second caller skips, even if caller-side guards missed it.
            // (H-SCHED-4).
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Lock for ${taskId} already held locally — reporting overlap (acquired:false)`
                );
            }
            return { acquired: false, lockKey, taskId };
        }

        const startTime = Date.now();

        try {
            const conn = await this.ensureReserved();

            let acquired = await this.attemptLock(conn, lockKey);

            if (!acquired && this.config.lockTimeout > 0) {
                while (
                    !acquired &&
                    Date.now() - startTime < this.config.lockTimeout
                ) {
                    await this.sleep(this.config.retryInterval);
                    acquired = await this.attemptLock(conn, lockKey);
                }
            }

            if (acquired) {
                this.heldLocks.add(taskId);
                if (this.config.enableLogging) {
                    loggerInstance.debug(
                        `Acquired lock for task ${taskId} (key: ${lockKey})`
                    );
                }
                return { acquired: true, lockKey, taskId };
            }

            // No locks taken on this attempt — if nothing else is held,
            // return the reserved connection to the pool.
            if (this.heldLocks.size === 0) {
                this.releaseReservation();
            }

            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Failed to acquire lock for task ${taskId} (key: ${lockKey}) — another instance is executing`
                );
            }
            return { acquired: false, lockKey, taskId };
        } catch (error) {
            loggerInstance.error(
                `Error acquiring lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
            );
            if (this.heldLocks.size === 0) {
                this.releaseReservation();
            }
            return { acquired: false, lockKey, taskId };
        }
    }

    /**
     * Release a single distributed lock. When the last lock is released the
     * reserved connection is returned to the pool.
     */
    async release(taskId: string): Promise<boolean> {
        if (!this.config.enabled) {
            return true;
        }

        if (!this.heldLocks.has(taskId)) {
            if (this.config.enableLogging) {
                loggerInstance.warn(
                    `Lock for task ${taskId} was not held or already released`
                );
            }
            return false;
        }

        const lockKey = this.generateLockKey(taskId);

        if (!this.reservedConn) {
            loggerInstance.warn(
                `No reserved connection available for ${taskId}; dropping from heldLocks`
            );
            this.heldLocks.delete(taskId);
            return false;
        }

        try {
            const result = await this.reservedConn`
                SELECT pg_advisory_unlock(${lockKey}::bigint) as pg_advisory_unlock
            `;
            const released = result[0]?.pg_advisory_unlock ?? false;

            this.heldLocks.delete(taskId);

            if (released && this.config.enableLogging) {
                loggerInstance.debug(
                    `Released lock for task ${taskId} (key: ${lockKey})`
                );
            } else if (!released) {
                loggerInstance.warn(
                    `pg_advisory_unlock returned false for task ${taskId} (key: ${lockKey})`
                );
            }

            if (this.heldLocks.size === 0) {
                this.releaseReservation();
            }
            return released;
        } catch (error) {
            loggerInstance.error(
                `Error releasing lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
            );
            this.heldLocks.delete(taskId);
            if (this.heldLocks.size === 0) {
                this.releaseReservation();
            }
            return false;
        }
    }

    /**
     * Release all held locks. Safe to call during shutdown.
     */
    async releaseAll(): Promise<void> {
        const tasks = Array.from(this.heldLocks);
        for (const taskId of tasks) {
            await this.release(taskId);
        }
        // release() returns the reservation once heldLocks empties, but if
        // nothing was held we still need to clean up any pending reservation.
        if (this.heldLocks.size === 0) {
            this.releaseReservation();
        }
    }

    isHeld(taskId: string): boolean {
        return this.heldLocks.has(taskId);
    }

    getHeldLockCount(): number {
        return this.heldLocks.size;
    }

    updateConfig(config: Partial<DistributedLockConfig>): void {
        this.config = { ...this.config, ...config };
    }

    getConfig(): DistributedLockConfig {
        return { ...this.config };
    }

    private async attemptLock(
        conn: ReservedSQL,
        lockKey: bigint
    ): Promise<boolean> {
        const result = await conn`
            SELECT pg_try_advisory_lock(${lockKey}::bigint) as pg_try_advisory_lock
        `;
        return result[0]?.pg_try_advisory_lock ?? false;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

let distributedLockInstance: DistributedLock | null = null;

export function getDistributedLock(
    config?: Partial<DistributedLockConfig>
): DistributedLock {
    if (!distributedLockInstance) {
        distributedLockInstance = new DistributedLock(config);
    } else if (config) {
        distributedLockInstance.updateConfig(config);
    }
    return distributedLockInstance;
}

export function resetDistributedLock(): void {
    if (distributedLockInstance) {
        distributedLockInstance.releaseAll().catch(() => {});
        distributedLockInstance = null;
    }
}
