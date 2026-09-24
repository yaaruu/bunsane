/**
 * SEC-17: advisory lock ownership tokens are random per acquisition.
 * The task id remains only the lock key; a forged token must not unlock.
 */
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { AdvisoryLockBackend } from "../../../core/scheduler/locks/AdvisoryLockBackend";
import type { LockHandle } from "../../../core/scheduler/locks/LockBackend";

function mockSql(opts: { failUnlock?: boolean } = {}): { sql: SQL; unlocks: () => number } {
    let unlocks = 0;
    const makeConn = () => {
        let stored: string | null = null;
        const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
            const q = strings.join("?");
            if (q.includes("set_config")) {
                const probe = values[0];
                stored = typeof probe === "string" ? probe : null;
                return Promise.resolve([{}]);
            }
            if (q.includes("current_setting")) {
                return Promise.resolve([{ v: stored }]);
            }
            if (q.includes("pg_try_advisory_lock")) {
                return Promise.resolve([{ locked: true }]);
            }
            if (q.includes("pg_advisory_unlock")) {
                unlocks++;
                if (opts.failUnlock) return Promise.reject(new Error("connection lost"));
                return Promise.resolve([{ unlocked: true }]);
            }
            return Promise.resolve([]);
        };
        return Object.assign(query, { release: () => undefined });
    };
    const sql: SQL = { reserve: () => Promise.resolve(makeConn()) } as unknown as SQL;
    return { sql, unlocks: () => unlocks };
}

describe("advisory lock ownership token", () => {
    test("random token fences release and renew; task id stays the key", async () => {
        const { sql, unlocks } = mockSql();
        const backend = new AdvisoryLockBackend({}, sql);
        const first = await backend.acquire("task-a");
        expect(first).not.toBeNull();
        const held = first as LockHandle;
        expect(held.key).toBe("task-a");
        expect(held.token).toMatch(/^[0-9a-f]{32}$/);

        expect(await backend.acquire("task-a")).toBeNull();

        const forged: LockHandle = { ...held, token: "0".repeat(32) };
        expect(await backend.release(forged)).toBe(false);
        expect(await backend.renew(forged, 1_000)).toBe(false);
        expect(unlocks()).toBe(0);

        expect(await backend.renew(held, 1_000)).toBe(true);
        expect(await backend.release(held)).toBe(true);
        expect(unlocks()).toBe(1);

        const again = await backend.acquire("task-a");
        expect(again).not.toBeNull();
        const second = again as LockHandle;
        expect(second.key).toBe("task-a");
        expect(second.token).not.toBe(held.token);
        expect(await backend.release(second)).toBe(true);
    });

    test("a failed unlock does not wedge the key for later acquires", async () => {
        const { sql } = mockSql({ failUnlock: true });
        const backend = new AdvisoryLockBackend({}, sql);
        const first = await backend.acquire("task-b");
        expect(first).not.toBeNull();
        expect(await backend.release(first as LockHandle)).toBe(false);
        expect(await backend.acquire("task-b")).not.toBeNull();
    });
});
