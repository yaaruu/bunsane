/**
 * The DB execution seam (database/gateway.ts).
 *
 * The properties under test are the ones whose absence caused, or would cause,
 * an outage:
 *
 *  - admission bounds concurrency, and the WAIT is bounded by the same deadline
 *    as the query (two independent 30 s clocks is how a request stalls for a
 *    minute before failing);
 *  - a transaction takes ONE permit and statements inside it are exempt —
 *    per-statement admission deadlocks a transaction that already owns its
 *    connection, presenting exactly like the wedge this work came from;
 *  - background work cannot starve the request lane;
 *  - the health lane is never admitted, so a liveness probe cannot queue behind
 *    saturated work and report "wedged" when the truth is "busy".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    dbExec,
    dbTransaction,
    getGatewayStats,
    resetGateway,
    inAdmittedScope,
    isAdmissionTimeout,
    DbAdmissionTimeoutError,
    DbStatementTimeoutError,
} from '../../../database/gateway';
import { resetDbStats, setPoolMax } from '../../../database/instrumentedDb';

const originalEnv = {
    admission: process.env.BUNSANE_DB_ADMISSION,
    headroom: process.env.DB_ADMISSION_HEADROOM,
};

/**
 * A fake connection whose queries resolve only when released.
 *
 * Mirrors `makeFakeDb` in instrumentedDb.test.ts: the query object needs a
 * `cancel()` and a pre-attached `.catch()`, because `runWithSignal` calls
 * `q.cancel?.()` on abort and then attaches its own handler. Without them an
 * aborted query left a rejection nobody owned, which under `bun test` silently
 * took down the whole runner — no failure, no summary, exit 0.
 */
function gatedConn() {
    const releases: Array<() => void> = [];
    let started = 0;
    return {
        started: () => started,
        releaseAll: () => { for (const r of releases) r(); releases.length = 0; },
        conn: {
            unsafe: () => {
                started++;
                let rejectFn: (err: Error) => void = () => {};
                const promise: any = new Promise<any[]>((resolve, reject) => {
                    rejectFn = reject;
                    releases.push(() => resolve([]));
                });
                promise.catch(() => { /* swallow post-abort settle */ });
                promise.cancelled = false;
                promise.cancel = () => {
                    promise.cancelled = true;
                    rejectFn(Object.assign(new Error('Query cancelled'), { name: 'AbortError' }));
                };
                return promise;
            },
        },
    };
}

const instantConn = { unsafe: () => Promise.resolve([{ ok: 1 }]) };

beforeEach(() => {
    resetDbStats();
    // Pool of 3 → admission limit 2 (headroom 1), background limit 1.
    setPoolMax(3);
    process.env.DB_ADMISSION_HEADROOM = '1';
    delete process.env.BUNSANE_DB_ADMISSION;
    resetGateway();
});

afterEach(() => {
    if (originalEnv.admission === undefined) delete process.env.BUNSANE_DB_ADMISSION;
    else process.env.BUNSANE_DB_ADMISSION = originalEnv.admission;
    if (originalEnv.headroom === undefined) delete process.env.DB_ADMISSION_HEADROOM;
    else process.env.DB_ADMISSION_HEADROOM = originalEnv.headroom;
    resetGateway();
    setPoolMax(0);
});

describe('admission capacity', () => {
    test('derives the limit from the pool, below it by the headroom', () => {
        const stats = getGatewayStats();
        expect(stats.admissionLimit).toBe(2);   // poolMax 3 − headroom 1
        expect(stats.backgroundLimit).toBe(1);  // half of the admission limit
        expect(stats.enabled).toBe(true);
    });

    test('bounds concurrency: the third caller waits for a permit', async () => {
        const gate = gatedConn();
        const a = dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 });
        const b = dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 });
        await Bun.sleep(20);
        const c = dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 });
        await Bun.sleep(20);

        expect(gate.started()).toBe(2);
        expect(getGatewayStats().queueDepth.request).toBe(1);

        gate.releaseAll();
        await Promise.all([a, b]);
        await Bun.sleep(10);
        gate.releaseAll();
        await c;
        expect(gate.started()).toBe(3);
    });

    test('the wait for capacity shares the caller deadline and fails loudly', async () => {
        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);

        const t0 = performance.now();
        const err = await dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 120 })
            .then(() => null, (e) => e);
        const waited = performance.now() - t0;

        expect(err).toBeInstanceOf(DbAdmissionTimeoutError);
        expect(isAdmissionTimeout(err)).toBe(true);
        // Bounded by the caller's own budget, not by a separate pool clock.
        expect(waited).toBeLessThan(1_000);
        expect(getGatewayStats().rejected.request).toBe(1);

        gate.releaseAll();
        await Promise.all(held);
    });

    test('a permit is never lost to a caller that already gave up', async () => {
        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(10);

        // This one expires while queued; its slot must not be handed to a ghost.
        await dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 60 }).catch(() => {});

        gate.releaseAll();
        await Promise.all(held);

        // Full capacity must be usable again.
        await Promise.all([
            dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 500 }),
            dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 500 }),
        ]);
        expect(getGatewayStats().admissionAvailable).toBe(2);
    });

    test('BUNSANE_DB_ADMISSION=off is a pure passthrough', async () => {
        process.env.BUNSANE_DB_ADMISSION = 'off';
        resetGateway();
        const gate = gatedConn();
        const all = [1, 2, 3, 4, 5].map(() => dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }));
        await Bun.sleep(20);
        expect(gate.started()).toBe(5);
        gate.releaseAll();
        await Promise.all(all);
    });
});

describe('lane isolation', () => {
    test('background cannot take more than its share', async () => {
        const gate = gatedConn();
        const bg = [
            dbExec('SELECT 1', [], { conn: gate.conn, lane: 'background', timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, lane: 'background', timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);

        // Background limit is 1, so only one of the two is running.
        expect(gate.started()).toBe(1);
        expect(getGatewayStats().queueDepth.background).toBe(1);

        // …and the request lane still has capacity while background waits.
        await dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 500 });

        gate.releaseAll();
        await Bun.sleep(10);
        gate.releaseAll();
        await Promise.all(bg);
    });

    test('the health lane is never admitted, so a probe cannot queue behind saturation', async () => {
        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);
        expect(getGatewayStats().admissionAvailable).toBe(0);

        // Would time out if it needed a permit; must succeed immediately.
        const probe = await dbExec('SELECT 1', [], { conn: instantConn, lane: 'health', timeoutMs: 100 });
        expect(probe).toEqual([{ ok: 1 }]);

        gate.releaseAll();
        await Promise.all(held);
    });
});

describe('transactions hold one permit for their duration', () => {
    test('statements inside a transaction are exempt — no nested-acquire deadlock', async () => {
        // Saturate everything except one permit, then run a transaction that
        // issues MORE statements than the whole admission limit. Per-statement
        // admission would deadlock here; this must complete.
        const gate = gatedConn();
        const held = dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 });
        await Bun.sleep(10);

        const seen: boolean[] = [];
        const result = await dbTransaction(async () => {
            for (let i = 0; i < 5; i++) {
                seen.push(inAdmittedScope());
                await dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 500 });
            }
            return 'committed';
        }, { timeoutMs: 2_000 });

        expect(result).toBe('committed');
        expect(seen).toEqual([true, true, true, true, true]);

        gate.releaseAll();
        await held;
    });

    test('the transaction permit is released on failure', async () => {
        await expect(dbTransaction(async () => {
            throw new Error('rollback please');
        }, { timeoutMs: 1_000 })).rejects.toThrow('rollback please');

        expect(getGatewayStats().admissionAvailable).toBe(2);
        expect(inAdmittedScope()).toBe(false);
    });

    test('exemption does not leak outside the transaction scope', async () => {
        await dbTransaction(async () => {
            expect(inAdmittedScope()).toBe(true);
        }, { timeoutMs: 1_000 });
        expect(inAdmittedScope()).toBe(false);
    });
});

describe('deadlines cover the query too', () => {
    /**
     * `dbExec`'s statement timer is `unref()`'d on purpose — at high QPS
     * thousands are live at once and they must not hold the event loop open. A
     * real query keeps the loop alive by itself, through its socket, so the
     * timer always gets a chance to fire.
     *
     * A FAKE query has no socket. With nothing else pending, Bun never fires an
     * unref'd timer and the test hangs instead of timing out (this is the same
     * trap that made the admission timer hang before it was left ref'd). So hold
     * something ref'd for the duration, standing in for the socket a real query
     * would have.
     */
    let keepLoopAlive: ReturnType<typeof setInterval> | undefined;
    beforeEach(() => { keepLoopAlive = setInterval(() => {}, 50); });
    afterEach(() => { if (keepLoopAlive) clearInterval(keepLoopAlive); });

    test('a statement that outlives the remaining budget is aborted', async () => {
        const gate = gatedConn();
        const err = await dbExec('SELECT pg_sleep(30)', [], { conn: gate.conn, timeoutMs: 80 })
            .then(() => null, (e) => e);
        // The deadline reason must survive, not be replaced by the driver's
        // "Query cancelled" — the caller is usually logging this.
        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(String((err as Error).message)).toContain('timeout');
        expect((err as { cause?: unknown }).cause).toBeDefined();
        gate.releaseAll();
        // The permit must come back even though the query was abandoned.
        expect(getGatewayStats().admissionAvailable).toBe(2);
    });

    test('a caller signal aborts both the wait and the query', async () => {
        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);

        const controller = new AbortController();
        const queued = dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 5_000, signal: controller.signal })
            .then(() => null, (e) => e);
        await Bun.sleep(20);
        controller.abort(new Error('client gone'));

        expect(await queued).toBeDefined();
        gate.releaseAll();
        await Promise.all(held);
    });
});
