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

export {
    withLock,
    LockUnavailableError,
    type WithLockOptions,
    type LockOutcome,
} from './withLock';

export {
    createLockBackend,
    InProcessLockBackend,
    AdvisoryLockBackend,
    PostgresLeaseLockBackend,
    UnsafeAdvisoryPoolingError,
    type LockBackend,
    type LockBackendKind,
    type LockHandle,
    type AcquireOptions,
} from './locks';
