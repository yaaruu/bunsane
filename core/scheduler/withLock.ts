/**
 * withLock — run a function while holding a distributed lock.
 *
 * Thin convenience wrapper over the shared {@link DistributedLock} singleton.
 * Acquires the lock for `key`, runs `fn`, and always releases it — even if `fn`
 * throws. Only one holder of a given `key` runs `fn` at a time, across every
 * process pointed at the same lock store (backend-dependent: see DistributedLock).
 *
 * Two layers of exclusion:
 *  - Across processes: the configured {@link LockBackend} (postgres-lease by
 *    default — pooler-safe).
 *  - Within a process: an in-memory `Set`, so concurrent same-key callers
 *    sharing this process are mutually exclusive without a backend round trip.
 *
 * Lease heartbeat: lease backends expire a lock after `leaseTtlMs`. For `fn`
 * that outlives the lease, withLock renews it every ~ttl/3 while `fn` runs. If
 * a renewal ever fails, the lease was lost (stolen) mid-execution — this is
 * logged as ERROR and counted (see {@link DistributedLock.getLostLeaseCount}).
 *
 * Contention is NOT silent by default-of-last-resort: the return type forces a
 * `.acquired` check, and callers can opt into a thrown {@link
 * LockUnavailableError} (`throwOnContention`) or an `onContended` callback so a
 * dropped critical section can never be ignored by accident (BUNSANE-2).
 *
 * @example
 * const res = await withLock("rebuild-search-index", async () => {
 *   await rebuildIndex();
 *   return "done";
 * });
 * if (!res.acquired) {
 *   // another instance is already rebuilding — skip
 * }
 *
 * @example  // fail loudly instead of returning {acquired:false}
 * await withLock("k", fn, { throwOnContention: true }); // throws LockUnavailableError
 */
import { getDistributedLock } from "./DistributedLock";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "withLock" });

/** Thrown by {@link withLock} on contention when `throwOnContention` is set. */
export class LockUnavailableError extends Error {
    constructor(public readonly key: string) {
        super(
            `Lock unavailable for key "${key}" — another holder is executing the critical section`
        );
        this.name = "LockUnavailableError";
    }
}

export interface WithLockOptions {
    /** Max ms to wait for the lock before giving up. 0 (default) = try once. */
    wait?: number;
    /** Poll interval while waiting, in ms. Default 100. */
    retryInterval?: number;
    /**
     * Throw {@link LockUnavailableError} on contention instead of returning
     * `{acquired:false}`. Use when skipping the work silently would lose it.
     * @default false
     */
    throwOnContention?: boolean;
    /**
     * Invoked when the lock could not be acquired (after `wait` elapses).
     * Runs before the contention return/throw — use it to record/forward the
     * dropped work explicitly. Errors thrown here propagate to the caller.
     */
    onContended?: (key: string) => void | Promise<void>;
    /**
     * Lease lifetime in ms for this lock. Drives both the acquired lease TTL
     * and the heartbeat cadence (~ttl/3). Defaults to the DistributedLock
     * configured lease TTL.
     */
    leaseTtlMs?: number;
}

export type LockOutcome<T> =
    | { acquired: false; result?: undefined }
    | { acquired: true; result: T };

/** In-process holders, keyed by lock key (see "Within a process" above). */
const localHeld = new Set<string>();

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

export async function withLock<T>(
    key: string,
    fn: () => Promise<T> | T,
    options: WithLockOptions = {}
): Promise<LockOutcome<T>> {
    const { wait = 0, retryInterval = 100, throwOnContention = false, onContended } =
        options;
    const deadline = wait > 0 ? Date.now() + wait : 0;

    const contended = async (): Promise<LockOutcome<T>> => {
        if (onContended) await onContended(key);
        if (throwOnContention) throw new LockUnavailableError(key);
        return { acquired: false };
    };

    // In-process gate. The has-check that exits the loop and the subsequent
    // add() run without an await between them, so this is atomic on JS's single
    // thread — concurrent same-key callers cannot both pass.
    while (localHeld.has(key)) {
        if (!deadline || Date.now() >= deadline) {
            return contended();
        }
        await sleep(retryInterval);
    }
    localHeld.add(key);

    try {
        const lock = getDistributedLock();
        const ttlMs = options.leaseTtlMs ?? lock.getLeaseTtlMs();

        let acquired = (await lock.tryAcquire(key, ttlMs)).acquired;
        while (!acquired && deadline && Date.now() < deadline) {
            await sleep(retryInterval);
            acquired = (await lock.tryAcquire(key, ttlMs)).acquired;
        }

        if (!acquired) {
            return contended();
        }

        // Heartbeat: keep the lease alive for the duration of fn. Interval is
        // ttl/3 (≥1s) so a renewal lands well before expiry. unref so a stray
        // timer never keeps the process alive during shutdown.
        const heartbeatMs = Math.max(1000, Math.floor(ttlMs / 3));
        const heartbeat = setInterval(() => {
            lock.renew(key).then(
                (ok) => {
                    if (!ok) {
                        // DistributedLock.renew already logged ERROR + counted;
                        // stop pinging a lease we no longer own.
                        clearInterval(heartbeat);
                        loggerInstance.error(
                            `Lost lease for "${key}" mid-execution — critical section no longer protected`
                        );
                    }
                },
                () => {
                    /* transient renew error already logged; retry next tick */
                }
            );
        }, heartbeatMs);
        (heartbeat as { unref?: () => void }).unref?.();

        try {
            return { acquired: true, result: await fn() };
        } finally {
            clearInterval(heartbeat);
            await lock.release(key);
        }
    } finally {
        localHeld.delete(key);
    }
}
