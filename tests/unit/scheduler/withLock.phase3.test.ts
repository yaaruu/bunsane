/**
 * Phase 3 tests for withLock — loud contention (BUNSANE-2) + lease heartbeat.
 *
 * Requires a database (PostgreSQL or PGlite).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "crypto";
import { resetDistributedLock, getDistributedLock } from "../../../core/scheduler/DistributedLock";
import { withLock, LockUnavailableError } from "../../../core/scheduler/withLock";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const k = (n: string) => `wl3:${n}:${randomUUID()}`;

describe("withLock contention (BUNSANE-2)", () => {
    beforeEach(() => resetDistributedLock());
    afterEach(async () => {
        await getDistributedLock().releaseAll();
        resetDistributedLock();
    });

    // Hold `key` via a gated in-flight withLock until `release()` is called.
    async function holdKey(
        key: string
    ): Promise<{ release: () => void; settled: Promise<unknown> }> {
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));
        const settled = withLock(key, async () => {
            await gate;
            return "holder";
        });
        await sleep(15); // let the holder enter the critical section
        return { release, settled };
    }

    test("throwOnContention throws LockUnavailableError instead of silent skip", async () => {
        const key = k("throw");
        const { release, settled } = await holdKey(key);

        await expect(
            withLock(key, () => "second", { throwOnContention: true })
        ).rejects.toBeInstanceOf(LockUnavailableError);

        release();
        await settled;
    });

    test("onContended fires on contention; default still returns acquired:false", async () => {
        const key = k("oncontended");
        const { release, settled } = await holdKey(key);

        const calls: string[] = [];
        const res = await withLock(key, () => "second", {
            onContended: (k) => {
                calls.push(k);
            },
        });

        expect(calls).toEqual([key]);
        expect(res.acquired).toBe(false);

        release();
        await settled;
    });

    test("onContended runs before throwOnContention throws", async () => {
        const key = k("both");
        const { release, settled } = await holdKey(key);

        let called = false;
        await expect(
            withLock(key, () => "x", {
                onContended: () => {
                    called = true;
                },
                throwOnContention: true,
            })
        ).rejects.toBeInstanceOf(LockUnavailableError);
        expect(called).toBe(true);

        release();
        await settled;
    });

    test("free lock is unaffected by contention options", async () => {
        const res = await withLock(k("free"), () => 7, { throwOnContention: true });
        expect(res.acquired).toBe(true);
        expect(res.result).toBe(7);
    });
});

describe("withLock heartbeat", () => {
    beforeEach(() => resetDistributedLock());
    afterEach(async () => {
        await getDistributedLock().releaseAll();
        resetDistributedLock();
    });

    test("renews the lease while fn runs longer than the heartbeat interval", async () => {
        // ttl 1500 → heartbeat at max(1000, 500) = 1000ms.
        const lock = getDistributedLock({ leaseTtlMs: 1500 });
        let renews = 0;
        const orig = lock.renew.bind(lock);
        (lock as { renew: (k: string) => Promise<boolean> }).renew = async (key) => {
            renews++;
            return orig(key);
        };

        const res = await withLock(k("hb"), async () => {
            await sleep(1300); // crosses one heartbeat tick at ~1000ms
            return "done";
        });

        expect(res.acquired).toBe(true);
        expect(res.result).toBe("done");
        expect(renews).toBeGreaterThanOrEqual(1);
        expect(lock.getLostLeaseCount()).toBe(0); // never lost the lease
    });
});
