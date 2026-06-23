/**
 * DistributedLock — task-keyed mutual exclusion over a pluggable
 * {@link LockBackend}.
 *
 * This class is the stable, task-id-oriented facade the scheduler and
 * {@link withLock} use. The actual locking mechanism is delegated to a backend:
 *
 *  - `advisory`   — PostgreSQL session advisory locks (historical default;
 *                   only safe with a session-pinned connection — see BUNSANE-1).
 *  - `in-process` — in-memory, single instance / test double.
 *  - `postgres`   — pooler-safe lease table (Phase 2).
 *  - `redis`      — `SET NX PX` lease (Phase 4).
 *
 * Select via `config.backend`, the `BUNSANE_LOCK_BACKEND` env var, or leave it
 * `'auto'`. The facade keeps a per-instance map of held handles so the public
 * API (`isHeld`, `getHeldLockCount`, …) is unchanged from the advisory-only
 * era.
 *
 * @see core/scheduler/locks/LockBackend.ts
 */

import { logger } from "../Logger";
import {
    createLockBackend,
    UnsafeAdvisoryPoolingError,
    type LockBackend,
    type LockBackendKind,
    type LockHandle,
} from "./locks";

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
    /** Which {@link LockBackend} to use. Omitted → env / `'auto'`. */
    backend?: LockBackendKind;
    /** Lease lifetime in ms for lease backends (ignored by advisory). */
    leaseTtlMs: number;
}

export const DEFAULT_LOCK_CONFIG: DistributedLockConfig = {
    enabled: true,
    lockKeyPrefix: 0x42554e53, // "BUNS" in hex as a namespace prefix
    enableLogging: false,
    lockTimeout: 0,
    retryInterval: 100,
    leaseTtlMs: 30_000,
};

interface HeldLease {
    handle: LockHandle;
    /** TTL used at acquire time; reused for heartbeat renewals. */
    ttlMs: number;
}

export class DistributedLock {
    private config: DistributedLockConfig;
    private backend: LockBackend;
    /** Held leases keyed by taskId (one logical lock per task per instance). */
    private heldLocks: Map<string, HeldLease> = new Map();
    /** Count of releases/renews that found the lease already lost (stranded). */
    private lostLeases = 0;

    constructor(config: Partial<DistributedLockConfig> = {}) {
        this.config = { ...DEFAULT_LOCK_CONFIG, ...config };
        this.backend = this.makeBackend();
    }

    private makeBackend(): LockBackend {
        return createLockBackend({
            kind: this.config.backend,
            lockKeyPrefix: this.config.lockKeyPrefix,
            enableLogging: this.config.enableLogging,
        });
    }

    /**
     * Stable bigint id for a task, used only for the {@link LockResult.lockKey}
     * field (logs/events). Matches the advisory backend's own hash so a
     * reported key lines up with the underlying advisory id when that backend
     * is active. NOTE (BUNSANE-4): 32-bit space → possible collisions; this is
     * an observability id, not the source of exclusion.
     */
    private generateLockKey(taskId: string): bigint {
        let hash = 0;
        for (let i = 0; i < taskId.length; i++) {
            const char = taskId.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        hash = Math.abs(hash);
        const prefix = BigInt(this.config.lockKeyPrefix);
        const hashBigInt = BigInt(hash >>> 0);
        return (prefix << 32n) | hashBigInt;
    }

    /**
     * Try to acquire a distributed lock for a task. Non-blocking when
     * `lockTimeout` is 0 (default); retries every `retryInterval` ms up to
     * `lockTimeout` otherwise.
     */
    async tryAcquire(
        taskId: string,
        ttlMs: number = this.config.leaseTtlMs
    ): Promise<LockResult> {
        const lockKey = this.generateLockKey(taskId);

        if (!this.config.enabled) {
            return { acquired: true, lockKey: 0n, taskId };
        }

        if (this.heldLocks.has(taskId)) {
            // Defense in depth: this instance already holds the lock. A second
            // concurrent acquirer means overlapping execution (e.g. a retry
            // firing before the prior run hit its release). Report contention
            // even if caller-side guards missed it (H-SCHED-4).
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Lock for ${taskId} already held locally — reporting overlap (acquired:false)`
                );
            }
            return { acquired: false, lockKey, taskId };
        }

        const startTime = Date.now();

        try {
            let handle = await this.backend.acquire(taskId, { ttlMs });

            if (!handle && this.config.lockTimeout > 0) {
                while (
                    !handle &&
                    Date.now() - startTime < this.config.lockTimeout
                ) {
                    await this.sleep(this.config.retryInterval);
                    handle = await this.backend.acquire(taskId, { ttlMs });
                }
            }

            if (handle) {
                this.heldLocks.set(taskId, { handle, ttlMs });
                if (this.config.enableLogging) {
                    loggerInstance.debug(
                        `Acquired lock for task ${taskId} (key: ${lockKey}, backend: ${this.backend.name})`
                    );
                }
                return { acquired: true, lockKey, taskId };
            }

            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Failed to acquire lock for task ${taskId} (key: ${lockKey}) — another holder is executing`
                );
            }
            return { acquired: false, lockKey, taskId };
        } catch (error) {
            // An unsafe-pooling config is NOT a transient lock failure — never
            // degrade it to a silent {acquired:false}. Fail loud (BUNSANE-7).
            if (error instanceof UnsafeAdvisoryPoolingError) {
                throw error;
            }
            loggerInstance.error(
                `Error acquiring lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
            );
            return { acquired: false, lockKey, taskId };
        }
    }

    /**
     * Release a single distributed lock. Returns `true` only if a genuinely
     * held lock was released.
     */
    async release(taskId: string): Promise<boolean> {
        if (!this.config.enabled) {
            return true;
        }

        const held = this.heldLocks.get(taskId);
        if (!held) {
            if (this.config.enableLogging) {
                loggerInstance.warn(
                    `Lock for task ${taskId} was not held or already released`
                );
            }
            return false;
        }

        // Drop local ownership first so a failed backend release can't leave a
        // phantom entry that blocks re-acquire forever.
        this.heldLocks.delete(taskId);

        try {
            const released = await this.backend.release(held.handle);
            if (!released) {
                // A false release is the canonical stranded/lost-lease signal
                // (BUNSANE-1/2). Surface it LOUDLY (ERROR) and count it — this
                // is the single highest-signal symptom of a broken lock.
                this.lostLeases++;
                loggerInstance.error(
                    `Lock release for task ${taskId} returned false (backend: ${this.backend.name}) — lease was lost/stranded; the critical section may have run without exclusion`
                );
            } else if (this.config.enableLogging) {
                loggerInstance.debug(`Released lock for task ${taskId}`);
            }
            return released;
        } catch (error) {
            loggerInstance.error(
                `Error releasing lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /**
     * Renew the lease for a held task (heartbeat). Returns `true` if the lease
     * is still ours and was extended. A `false` means the lease lapsed and was
     * stolen mid-execution — surfaced as ERROR + counted. Backends without a
     * lease (advisory: session-bound, never lapses while held) report `true`.
     */
    async renew(taskId: string): Promise<boolean> {
        if (!this.config.enabled) return true;

        const held = this.heldLocks.get(taskId);
        if (!held) return false;

        // Session-bound backends have no renew → the lock cannot lapse while
        // held, so treat as a successful no-op.
        if (!this.backend.renew) return true;

        try {
            const ok = await this.backend.renew(held.handle, held.ttlMs);
            if (!ok) {
                this.lostLeases++;
                this.heldLocks.delete(taskId);
                loggerInstance.error(
                    `Lease renewal failed for task ${taskId} (backend: ${this.backend.name}) — lease expired and was stolen; the critical section is NO LONGER protected`
                );
            }
            return ok;
        } catch (error) {
            loggerInstance.error(
                `Error renewing lease for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /** Total leases observed lost/stranded (failed renew or release). */
    getLostLeaseCount(): number {
        return this.lostLeases;
    }

    /** Configured lease lifetime in ms (drives heartbeat cadence in withLock). */
    getLeaseTtlMs(): number {
        return this.config.leaseTtlMs;
    }

    /**
     * Release all held locks. Safe to call during shutdown.
     */
    async releaseAll(): Promise<void> {
        const tasks = Array.from(this.heldLocks.keys());
        for (const taskId of tasks) {
            await this.release(taskId);
        }
    }

    isHeld(taskId: string): boolean {
        return this.heldLocks.has(taskId);
    }

    getHeldLockCount(): number {
        return this.heldLocks.size;
    }

    updateConfig(config: Partial<DistributedLockConfig>): void {
        const prevBackendKind = this.config.backend;
        this.config = { ...this.config, ...config };
        // Recreate the backend only when its identity changes; otherwise keep
        // the live one (it may own a reserved connection / held leases).
        if (config.backend !== undefined && config.backend !== prevBackendKind) {
            void this.backend.dispose?.();
            this.backend = this.makeBackend();
        }
    }

    getConfig(): DistributedLockConfig {
        return { ...this.config };
    }

    /** Backend name, for diagnostics / health output. */
    getBackendName(): string {
        return this.backend.name;
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
