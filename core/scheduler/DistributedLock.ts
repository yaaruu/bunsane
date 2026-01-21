/**
 * Distributed Lock using PostgreSQL Advisory Locks
 *
 * PostgreSQL advisory locks are application-level locks that can be used
 * to coordinate between multiple application instances. They are:
 * - Session-based: automatically released when connection closes
 * - Non-blocking with pg_try_advisory_lock
 * - Perfect for distributed task scheduling
 *
 * @see https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
 */

import db from "../../database";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "DistributedLock" });

/**
 * Result of a lock acquisition attempt
 */
export interface LockResult {
    acquired: boolean;
    lockKey: bigint;
    taskId: string;
}

/**
 * Configuration for the distributed lock system
 */
export interface DistributedLockConfig {
    /** Whether distributed locking is enabled */
    enabled: boolean;
    /** Prefix for lock keys to avoid collisions with other applications */
    lockKeyPrefix: number;
    /** Whether to log lock acquisition/release events */
    enableLogging: boolean;
    /** Timeout for lock acquisition attempts in milliseconds (0 = no retry) */
    lockTimeout: number;
    /** Retry interval when lockTimeout > 0 */
    retryInterval: number;
}

/**
 * Default configuration
 */
export const DEFAULT_LOCK_CONFIG: DistributedLockConfig = {
    enabled: true,
    lockKeyPrefix: 0x42554E53, // "BUNS" in hex as a namespace prefix
    enableLogging: false,
    lockTimeout: 0, // No retry by default - skip if can't acquire
    retryInterval: 100,
};

/**
 * Distributed Lock Manager using PostgreSQL Advisory Locks
 *
 * Provides distributed coordination for scheduled tasks across multiple
 * application instances. Uses PostgreSQL's advisory lock system which
 * guarantees that only one instance can hold a lock at a time.
 *
 * Advisory locks are automatically released when:
 * - Explicitly unlocked via pg_advisory_unlock
 * - The database session ends
 * - The connection is closed
 */
export class DistributedLock {
    private config: DistributedLockConfig;
    private heldLocks: Set<string> = new Set();

    constructor(config: Partial<DistributedLockConfig> = {}) {
        this.config = { ...DEFAULT_LOCK_CONFIG, ...config };
    }

    /**
     * Generate a consistent 64-bit lock key from a task ID
     * Uses a simple hash function to convert string task IDs to bigints
     *
     * The lock key is composed of:
     * - Upper 32 bits: lockKeyPrefix (namespace)
     * - Lower 32 bits: hash of taskId
     */
    private generateLockKey(taskId: string): bigint {
        // Simple hash function for the task ID
        let hash = 0;
        for (let i = 0; i < taskId.length; i++) {
            const char = taskId.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        // Make it positive
        hash = Math.abs(hash);

        // Combine prefix (upper 32 bits) with hash (lower 32 bits)
        const prefix = BigInt(this.config.lockKeyPrefix);
        const hashBigInt = BigInt(hash >>> 0); // Ensure unsigned
        return (prefix << 32n) | hashBigInt;
    }

    /**
     * Try to acquire a distributed lock for a task
     *
     * Uses pg_try_advisory_lock which is non-blocking:
     * - Returns true immediately if lock is available
     * - Returns false immediately if lock is held by another session
     *
     * @param taskId The unique identifier for the task
     * @returns LockResult indicating whether the lock was acquired
     */
    async tryAcquire(taskId: string): Promise<LockResult> {
        if (!this.config.enabled) {
            return { acquired: true, lockKey: 0n, taskId };
        }

        const lockKey = this.generateLockKey(taskId);
        const startTime = Date.now();

        try {
            // Try to acquire the lock
            let acquired = await this.attemptLock(lockKey);

            // If lockTimeout > 0, retry until timeout
            if (!acquired && this.config.lockTimeout > 0) {
                while (!acquired && (Date.now() - startTime) < this.config.lockTimeout) {
                    await this.sleep(this.config.retryInterval);
                    acquired = await this.attemptLock(lockKey);
                }
            }

            if (acquired) {
                this.heldLocks.add(taskId);
                if (this.config.enableLogging) {
                    loggerInstance.debug(`Acquired lock for task ${taskId} (key: ${lockKey})`);
                }
            } else {
                if (this.config.enableLogging) {
                    loggerInstance.debug(`Failed to acquire lock for task ${taskId} (key: ${lockKey}) - another instance is executing`);
                }
            }

            return { acquired, lockKey, taskId };
        } catch (error) {
            loggerInstance.error(`Error acquiring lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
            // On error, return false to be safe (don't execute without lock)
            return { acquired: false, lockKey, taskId };
        }
    }

    /**
     * Attempt to acquire the PostgreSQL advisory lock
     */
    private async attemptLock(lockKey: bigint): Promise<boolean> {
        const result = await db`
            SELECT pg_try_advisory_lock(${lockKey}::bigint) as pg_try_advisory_lock
        `;
        return result[0]?.pg_try_advisory_lock ?? false;
    }

    /**
     * Release a distributed lock for a task
     *
     * Uses pg_advisory_unlock to explicitly release the lock.
     * The lock is also automatically released if the connection closes.
     *
     * @param taskId The unique identifier for the task
     * @returns true if the lock was released, false if it wasn't held
     */
    async release(taskId: string): Promise<boolean> {
        if (!this.config.enabled) {
            return true;
        }

        const lockKey = this.generateLockKey(taskId);

        try {
            const result = await db`
                SELECT pg_advisory_unlock(${lockKey}::bigint) as pg_advisory_unlock
            `;

            const released = result[0]?.pg_advisory_unlock ?? false;

            if (released) {
                this.heldLocks.delete(taskId);
                if (this.config.enableLogging) {
                    loggerInstance.debug(`Released lock for task ${taskId} (key: ${lockKey})`);
                }
            } else {
                if (this.config.enableLogging) {
                    loggerInstance.warn(`Lock for task ${taskId} was not held or already released`);
                }
            }

            return released;
        } catch (error) {
            loggerInstance.error(`Error releasing lock for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
            this.heldLocks.delete(taskId); // Remove from tracking even on error
            return false;
        }
    }

    /**
     * Release all locks held by this instance
     * Useful during shutdown
     */
    async releaseAll(): Promise<void> {
        const tasks = Array.from(this.heldLocks);
        for (const taskId of tasks) {
            await this.release(taskId);
        }
    }

    /**
     * Check if a lock is currently held (locally tracked)
     */
    isHeld(taskId: string): boolean {
        return this.heldLocks.has(taskId);
    }

    /**
     * Get the count of locks held by this instance
     */
    getHeldLockCount(): number {
        return this.heldLocks.size;
    }

    /**
     * Update the configuration
     */
    updateConfig(config: Partial<DistributedLockConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): DistributedLockConfig {
        return { ...this.config };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Singleton instance for global access
 */
let distributedLockInstance: DistributedLock | null = null;

export function getDistributedLock(config?: Partial<DistributedLockConfig>): DistributedLock {
    if (!distributedLockInstance) {
        distributedLockInstance = new DistributedLock(config);
    } else if (config) {
        distributedLockInstance.updateConfig(config);
    }
    return distributedLockInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetDistributedLock(): void {
    if (distributedLockInstance) {
        distributedLockInstance.releaseAll().catch(() => {});
        distributedLockInstance = null;
    }
}
