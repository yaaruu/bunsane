/**
 * withLock — run a function while holding a PostgreSQL advisory lock.
 *
 * Thin convenience wrapper over the shared {@link DistributedLock} singleton.
 * Acquires the lock for `key`, runs `fn`, and always releases it — even if
 * `fn` throws. Only one holder of a given `key` runs `fn` at a time, across
 * every process pointed at the same database. When the lock is unavailable the
 * call returns `{ acquired: false }` without running `fn` (unless `wait` is
 * set, in which case it polls until the lock frees or the deadline passes).
 *
 * Two layers of exclusion:
 *  - Across processes: PostgreSQL `pg_advisory_lock`, owned by the singleton's
 *    pinned connection (one PG session per instance).
 *  - Within a process: an in-memory `Set`. PostgreSQL advisory locks are
 *    *reentrant per session*, so two concurrent callers sharing this instance's
 *    session would both win the pg lock — the Set makes same-process contention
 *    exclusive too.
 *
 * Notes:
 *  - Not reentrant. Calling `withLock(key, …)` for a key already held by this
 *    process returns `{ acquired: false }` (or waits, then gives up).
 *  - Shares the scheduler's singleton + PG session. Keys live under the same
 *    namespace prefix as scheduler task ids — pick keys unlikely to collide.
 *  - Honors the singleton's `enabled` config: if distributed locking was
 *    disabled (`getDistributedLock({ enabled: false })`), `tryAcquire` always
 *    reports success and no real lock is taken.
 *
 * @example
 * const res = await withLock("rebuild-search-index", async () => {
 *   await rebuildIndex();
 *   return "done";
 * });
 * if (!res.acquired) {
 *   // another instance is already rebuilding — skip
 * } else {
 *   console.log(res.result); // "done"
 * }
 */
import { getDistributedLock } from "./DistributedLock";

export interface WithLockOptions {
    /** Max ms to wait for the lock before giving up. 0 (default) = try once. */
    wait?: number;
    /** Poll interval while waiting, in ms. Default 100. */
    retryInterval?: number;
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
    const { wait = 0, retryInterval = 100 } = options;
    const deadline = wait > 0 ? Date.now() + wait : 0;

    // In-process gate. The has-check that exits the loop and the subsequent
    // add() run without an await between them, so this is atomic on JS's single
    // thread — concurrent same-key callers cannot both pass.
    while (localHeld.has(key)) {
        if (!deadline || Date.now() >= deadline) {
            return { acquired: false };
        }
        await sleep(retryInterval);
    }
    localHeld.add(key);

    try {
        const lock = getDistributedLock();

        let acquired = (await lock.tryAcquire(key)).acquired;
        while (!acquired && deadline && Date.now() < deadline) {
            await sleep(retryInterval);
            acquired = (await lock.tryAcquire(key)).acquired;
        }

        if (!acquired) {
            return { acquired: false };
        }

        try {
            return { acquired: true, result: await fn() };
        } finally {
            await lock.release(key);
        }
    } finally {
        localHeld.delete(key);
    }
}
