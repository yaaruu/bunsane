/**
 * Public `bunsane/core` entry point.
 *
 * Subpath imports (`bunsane/core/App`, `bunsane/core/middleware`, …) remain the
 * primary surface; this barrel re-exports cross-cutting primitives intended to
 * be imported as `bunsane/core`.
 */

export {
    withLock,
    type WithLockOptions,
    type LockOutcome,
    DistributedLock,
    getDistributedLock,
    resetDistributedLock,
    DEFAULT_LOCK_CONFIG,
    type DistributedLockConfig,
    type LockResult,
} from "./scheduler";
