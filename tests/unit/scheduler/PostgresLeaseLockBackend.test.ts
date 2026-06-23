/**
 * Tests for PostgresLeaseLockBackend.
 *
 * Crucially, two backend *instances* sharing the same database contend over a
 * real lease row — so cross-"session" contention and stranding are exercisable
 * even on single-connection PGlite (the advisory backend could not be — it
 * needs distinct PG sessions). This closes the BUNSANE-6 lock-untested gap.
 *
 * Requires a database (PostgreSQL or PGlite). The lease table is created lazily
 * on first acquire.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { PostgresLeaseLockBackend } from "../../../core/scheduler/locks/PostgresLeaseLockBackend";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Unique per test run so a persisted lease table can't bleed across runs.
const k = (name: string) => `pglease:${name}:${randomUUID()}`;

describe("PostgresLeaseLockBackend", () => {
    let a: PostgresLeaseLockBackend;
    let b: PostgresLeaseLockBackend;

    beforeAll(() => {
        // Two independent holders pointed at the same DB.
        a = new PostgresLeaseLockBackend();
        b = new PostgresLeaseLockBackend();
    });

    test("acquires a free key", async () => {
        const h = await a.acquire(k("free"));
        expect(h).not.toBeNull();
        expect(typeof h!.token).toBe("string");
    });

    test("a second holder is refused while the lease is live", async () => {
        const key = k("contend");
        const ha = await a.acquire(key, { ttlMs: 30_000 });
        const hb = await b.acquire(key, { ttlMs: 30_000 });
        expect(ha).not.toBeNull();
        expect(hb).toBeNull(); // live foreign lease → no steal
    });

    test("release frees the key for the other holder", async () => {
        const key = k("handoff");
        const ha = (await a.acquire(key, { ttlMs: 30_000 }))!;
        expect(await b.acquire(key)).toBeNull();
        expect(await a.release(ha)).toBe(true);
        const hb = await b.acquire(key);
        expect(hb).not.toBeNull();
    });

    test("an expired lease is stolen; original holder's release is a no-op", async () => {
        const key = k("expire");
        const ha = (await a.acquire(key, { ttlMs: 30 }))!;
        await sleep(60); // lease lapses
        const hb = await b.acquire(key, { ttlMs: 30_000 });
        expect(hb).not.toBeNull(); // stolen
        expect(hb!.token).not.toBe(ha.token);
        // A no longer owns it — release/renew must not clobber B's lease.
        expect(await a.release(ha)).toBe(false);
        expect(await a.renew(ha, 30_000)).toBe(false);
        // B still holds it.
        expect(await a.acquire(key)).toBeNull();
    });

    test("renew extends a live lease and blocks a steal", async () => {
        const key = k("renew");
        const ha = (await a.acquire(key, { ttlMs: 80 }))!;
        expect(await a.renew(ha, 30_000)).toBe(true);
        await sleep(120); // past the ORIGINAL ttl, but renewed
        expect(await b.acquire(key)).toBeNull(); // still live → no steal
        expect(await a.release(ha)).toBe(true);
        expect(await a.renew(ha, 30_000)).toBe(false); // gone after release
    });

    test("distinct keys do not contend", async () => {
        const h1 = await a.acquire(k("dk-a"));
        const h2 = await a.acquire(k("dk-b"));
        expect(h1).not.toBeNull();
        expect(h2).not.toBeNull();
    });
});
