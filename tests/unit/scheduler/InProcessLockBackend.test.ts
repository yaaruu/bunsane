/**
 * Unit tests for InProcessLockBackend.
 *
 * Unlike the old `enabled:false` no-op (which faked success and never
 * exercised contention), this backend genuinely refuses a second holder and
 * honours lease expiry — making it a faithful single-process test double for
 * lock-guarded logic (BUNSANE-6). No database required.
 */
import { describe, test, expect } from "bun:test";
import { InProcessLockBackend } from "../../../core/scheduler/locks/InProcessLockBackend";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("InProcessLockBackend", () => {
    test("acquire returns a handle for a free key", async () => {
        const backend = new InProcessLockBackend();
        const handle = await backend.acquire("k");
        expect(handle).not.toBeNull();
        expect(handle!.key).toBe("k");
        expect(typeof handle!.token).toBe("string");
        expect(handle!.expiresAt).toBeGreaterThan(0);
    });

    test("second acquire of a held key is refused (real contention)", async () => {
        const backend = new InProcessLockBackend();
        const first = await backend.acquire("dup");
        const second = await backend.acquire("dup");
        expect(first).not.toBeNull();
        expect(second).toBeNull();
        expect(backend.liveCount()).toBe(1);
    });

    test("release frees the key for re-acquire", async () => {
        const backend = new InProcessLockBackend();
        const h = (await backend.acquire("rel"))!;
        expect(await backend.release(h)).toBe(true);
        expect(backend.liveCount()).toBe(0);
        const again = await backend.acquire("rel");
        expect(again).not.toBeNull();
    });

    test("release with a stale handle returns false (lost-lease signal)", async () => {
        const backend = new InProcessLockBackend();
        const h = (await backend.acquire("stale"))!;
        await backend.release(h);
        // Someone else now owns it.
        await backend.acquire("stale");
        // Old holder tries to release — must not clobber the new owner.
        expect(await backend.release(h)).toBe(false);
        expect(backend.liveCount()).toBe(1);
    });

    test("distinct keys do not contend", async () => {
        const backend = new InProcessLockBackend();
        expect(await backend.acquire("a")).not.toBeNull();
        expect(await backend.acquire("b")).not.toBeNull();
        expect(backend.liveCount()).toBe(2);
    });

    test("renew extends an owned lease; fails after release", async () => {
        const backend = new InProcessLockBackend();
        const h = (await backend.acquire("renew", { ttlMs: 1000 }))!;
        expect(await backend.renew(h, 5000)).toBe(true);
        await backend.release(h);
        expect(await backend.renew(h, 5000)).toBe(false);
    });

    test("an expired lease can be stolen by a new acquirer", async () => {
        const backend = new InProcessLockBackend();
        const h = (await backend.acquire("lease", { ttlMs: 20 }))!;
        await sleep(40); // lease lapses
        const stolen = await backend.acquire("lease", { ttlMs: 1000 });
        expect(stolen).not.toBeNull();
        expect(stolen!.token).not.toBe(h.token);
        // Original holder can no longer renew or release the stolen lease.
        expect(await backend.renew(h, 1000)).toBe(false);
        expect(await backend.release(h)).toBe(false);
    });

    test("dispose clears all leases", async () => {
        const backend = new InProcessLockBackend();
        await backend.acquire("x");
        await backend.acquire("y");
        await backend.dispose();
        expect(backend.liveCount()).toBe(0);
    });
});
