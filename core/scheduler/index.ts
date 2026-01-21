/**
 * Scheduler Module
 *
 * Provides distributed task scheduling capabilities for multi-instance deployments.
 * Uses PostgreSQL advisory locks to ensure only one instance executes a task at a time.
 */

export {
    DistributedLock,
    getDistributedLock,
    resetDistributedLock,
    DEFAULT_LOCK_CONFIG,
    type DistributedLockConfig,
    type LockResult,
} from './DistributedLock';
