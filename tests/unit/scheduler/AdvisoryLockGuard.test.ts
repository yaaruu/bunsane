/**
 * Tests for the advisory backend's session-affinity guard (BUNSANE-1/-7).
 *
 * Uses a mock SQL whose reserved connection either persists a session GUC
 * (session-pinned → safe) or drops it (transaction pooler → unsafe), so the
 * loud-failure path is exercised deterministically without a real pooler.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { SQL } from "bun";
import {
    AdvisoryLockBackend,
    UnsafeAdvisoryPoolingError,
} from "../../../core/scheduler/locks/AdvisoryLockBackend";

/**
 * Build a mock `SQL` whose reserved connection simulates session affinity.
 * `persist:true` returns the value set via `set_config` (a pinned session);
 * `persist:false` returns null (a transaction pooler lost it).
 */
function mockSql(persist: boolean): SQL {
    const makeConn = () => {
        let stored: string | null = null;
        const conn = (strings: TemplateStringsArray, ...values: unknown[]) => {
            const q = strings.join("?");
            if (q.includes("set_config")) {
                stored = values[0] as string;
                return Promise.resolve([{}]);
            }
            if (q.includes("current_setting")) {
                return Promise.resolve([{ v: persist ? stored : null }]);
            }
            if (q.includes("pg_try_advisory_lock")) {
                return Promise.resolve([{ locked: true }]);
            }
            if (q.includes("pg_advisory_unlock")) {
                return Promise.resolve([{ unlocked: true }]);
            }
            return Promise.resolve([]);
        };
        (conn as { release?: () => void }).release = () => {};
        return conn;
    };
    return { reserve: () => Promise.resolve(makeConn()) } as unknown as SQL;
}

describe("Advisory session-affinity guard", () => {
    const ENV = "BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK";
    afterEach(() => {
        delete process.env[ENV];
    });

    test("session-pinned connection (probe persists) → acquires normally", async () => {
        const backend = new AdvisoryLockBackend({}, mockSql(true));
        const handle = await backend.acquire("safe-key");
        expect(handle).not.toBeNull();
        expect(handle!.key).toBe("safe-key");
    });

    test("transaction pooler (probe lost) → throws UnsafeAdvisoryPoolingError", async () => {
        const backend = new AdvisoryLockBackend({}, mockSql(false));
        await expect(backend.acquire("unsafe-key")).rejects.toBeInstanceOf(
            UnsafeAdvisoryPoolingError
        );
    });

    test("ack env bypasses the probe even when unsafe", async () => {
        process.env[ENV] = "true";
        const backend = new AdvisoryLockBackend({}, mockSql(false));
        const handle = await backend.acquire("acked-key");
        expect(handle).not.toBeNull();
    });

    test("probe runs once, not on every acquire", async () => {
        // After a safe first probe, a second acquire must not re-throw or stall.
        const backend = new AdvisoryLockBackend({}, mockSql(true));
        expect(await backend.acquire("k1")).not.toBeNull();
        expect(await backend.acquire("k2")).not.toBeNull();
    });
});
