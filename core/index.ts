/**
 * Public `bunsane/core` entry point.
 *
 * Application code should import the authoring set from the package root
 * (`import { App, Entity, Query, withLock } from "bunsane"`). This subpath
 * re-exports cross-cutting primitives for callers that already use `bunsane/core`.
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
