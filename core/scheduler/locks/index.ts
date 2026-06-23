/**
 * Lock backend selection + factory.
 *
 * Resolution order: explicit `config.kind` → `BUNSANE_LOCK_BACKEND` env →
 * `'auto'`. `'auto'` resolves to the safest correct default for the deployment.
 *
 * `'auto'` resolves to `'postgres'` (pooler-safe lease): the default lock
 * primitive is now correct behind pgbouncer transaction pooling. The old
 * advisory primitive (silently broken behind a pooler — BUNSANE-1) is opt-in
 * via `'advisory'`, and only safe on a session-pinned connection lane.
 */

import { logger } from "../../Logger";
import type { LockBackend } from "./LockBackend";
import { InProcessLockBackend } from "./InProcessLockBackend";
import { AdvisoryLockBackend } from "./AdvisoryLockBackend";
import { PostgresLeaseLockBackend } from "./PostgresLeaseLockBackend";

const loggerInstance = logger.child({ scope: "LockBackend" });

export type LockBackendKind =
    | "auto"
    | "in-process"
    | "postgres"
    | "redis"
    | "advisory";

export interface LockBackendConfig {
    /** Which backend to use. Default resolves via env then `'auto'`. */
    kind?: LockBackendKind;
    /** Advisory backend only: 32-bit namespace prefix for the advisory key. */
    lockKeyPrefix?: number;
    enableLogging?: boolean;
}

function resolveKind(kind: LockBackendKind | undefined): Exclude<LockBackendKind, "auto"> {
    const requested =
        kind ?? (process.env.BUNSANE_LOCK_BACKEND as LockBackendKind | undefined) ?? "auto";

    if (requested === "auto") {
        // Pooler-safe lease is the correct default behind PgBouncer transaction
        // pooling. Single-instance deploys may opt down to 'in-process'.
        return "postgres";
    }
    return requested;
}

export function createLockBackend(config: LockBackendConfig = {}): LockBackend {
    const kind = resolveKind(config.kind);

    switch (kind) {
        case "in-process":
            return new InProcessLockBackend();
        case "advisory":
            return new AdvisoryLockBackend({
                lockKeyPrefix: config.lockKeyPrefix,
                enableLogging: config.enableLogging,
            });
        case "postgres":
            return new PostgresLeaseLockBackend({
                enableLogging: config.enableLogging,
            });
        case "redis":
            // Implemented in Phase 4.
            loggerInstance.error(
                `Lock backend 'redis' is not implemented yet; falling back to postgres-lease.`
            );
            return new PostgresLeaseLockBackend({
                enableLogging: config.enableLogging,
            });
        default: {
            const exhaustive: never = kind;
            throw new Error(`Unknown lock backend: ${String(exhaustive)}`);
        }
    }
}

export type { LockBackend, LockHandle, AcquireOptions } from "./LockBackend";
export { InProcessLockBackend } from "./InProcessLockBackend";
export { AdvisoryLockBackend, UnsafeAdvisoryPoolingError } from "./AdvisoryLockBackend";
export { PostgresLeaseLockBackend } from "./PostgresLeaseLockBackend";
