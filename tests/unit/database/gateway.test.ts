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
    armGateway,
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
    // Admission is inert until armed (boot DDL runs unbounded), so every test
    // that exercises it has to arm first — same as App does after migrations.
    armGateway();
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

    test('is inert until armed, so boot DDL is never serialized behind it', async () => {
        resetGateway(); // disarms — the state a process is in during migrations
        expect(getGatewayStats().armed).toBe(false);

        const gate = gatedConn();
        const all = [1, 2, 3, 4, 5].map(() => dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }));
        await Bun.sleep(20);
        expect(gate.started()).toBe(5); // no bound applied
        gate.releaseAll();
        await Promise.all(all);
    });

    test('a pool-size change is deferred until the queues are idle, never applied mid-flight', async () => {
        const gate = gatedConn();
        const held = dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 });
        await Bun.sleep(10);
        expect(getGatewayStats().admissionAvailable).toBe(1);

        // Rebuilding here would strand this permit's release on an orphaned queue
        // and let new callers acquire against fresh full capacity.
        setPoolMax(10);
        expect(getGatewayStats().admissionLimit).toBe(2);
        expect(getGatewayStats().admissionAvailable).toBe(1);

        gate.releaseAll();
        await held;

        // Idle now, so the new size takes effect — deferred, not ignored.
        expect(getGatewayStats().admissionLimit).toBe(9); // poolMax 10 − headroom 1
        expect(getGatewayStats().admissionAvailable).toBe(9);
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

    test('opts.conn is used, so an open handle gets a savepoint not a second connection', async () => {
        // Acquiring a second pooled connection from inside a transaction is how a
        // migrated write path would deadlock against itself.
        let sawHandle: unknown = null;
        const handle = {
            transaction: (cb: (trx: any) => any) => {
                sawHandle = 'used';
                return cb({ marker: 'savepoint' });
            },
        };

        const trxSeen = await dbTransaction(async (trx: any) => trx.marker, {
            conn: handle,
            timeoutMs: 1_000,
        });

        expect(sawHandle).toBe('used');
        expect(trxSeen).toBe('savepoint');
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

/**
 * Per-lane budgets — the knob that decides whether the seam SHEDS or just queues.
 *
 * Measured on real PG 17 (20 concurrent 2 s statements, admissionLimit 3): at an
 * 800 ms budget 17 of 20 were rejected before reaching the server and drain was
 * 2063 ms; at the shipped 30 s default nothing was rejected, all 20 executed, and
 * drain was 14056 ms — worse than admission-off, because admission caps
 * concurrency below poolMax. Since no framework call site passes `timeoutMs`,
 * the lane default is the ONLY thing that can produce the first row in
 * production.
 */
describe('per-lane deadlines', () => {
    const saved = {
        request: process.env.DB_REQUEST_TIMEOUT,
        background: process.env.DB_BACKGROUND_TIMEOUT,
        query: process.env.DB_QUERY_TIMEOUT,
    };

    afterEach(() => {
        for (const [key, value] of [
            ['DB_REQUEST_TIMEOUT', saved.request],
            ['DB_BACKGROUND_TIMEOUT', saved.background],
            ['DB_QUERY_TIMEOUT', saved.query],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetGateway();
    });

    test('lanes fall back to the global default when unset', () => {
        delete process.env.DB_REQUEST_TIMEOUT;
        delete process.env.DB_BACKGROUND_TIMEOUT;
        process.env.DB_QUERY_TIMEOUT = '12345';
        resetGateway();

        const budgets = getGatewayStats().laneBudgetMs;
        expect(budgets.request).toBe(12345);
        expect(budgets.background).toBe(12345);
        expect(budgets.health).toBe(12345);
    });

    test('each lane can be shortened independently', () => {
        process.env.DB_QUERY_TIMEOUT = '30000';
        process.env.DB_REQUEST_TIMEOUT = '2000';
        process.env.DB_BACKGROUND_TIMEOUT = '90000';
        resetGateway();

        const budgets = getGatewayStats().laneBudgetMs;
        expect(budgets.request).toBe(2000);
        expect(budgets.background).toBe(90000);
        // health has no override by design: admit() exempts it, so a health
        // budget would bound only the query and never the queue.
        expect(budgets.health).toBe(30000);
    });

    test('a garbage value is ignored rather than silently becoming zero', () => {
        process.env.DB_QUERY_TIMEOUT = '30000';
        process.env.DB_REQUEST_TIMEOUT = 'soon';
        resetGateway();
        expect(getGatewayStats().laneBudgetMs.request).toBe(30000);

        process.env.DB_REQUEST_TIMEOUT = '0';
        resetGateway();
        expect(getGatewayStats().laneBudgetMs.request).toBe(30000);
    });

    test('the request-lane default actually rejects a queued caller', async () => {
        // No timeoutMs anywhere — the whole point is that call sites do not pass
        // one, so the lane default has to be what bounds the wait.
        process.env.DB_REQUEST_TIMEOUT = '60';
        resetGateway();
        armGateway();

        // The holders take an explicit budget: they must occupy the permits, not
        // expire against the 60 ms lane default themselves.
        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);

        const err = await dbExec('SELECT 1', [], { conn: instantConn }).then(() => null, (e) => e);
        expect(isAdmissionTimeout(err)).toBe(true);

        gate.releaseAll();
        await Promise.all(held);
    });

    test('a per-call timeoutMs still wins over the lane default', async () => {
        process.env.DB_REQUEST_TIMEOUT = '60';
        resetGateway();
        armGateway();

        const gate = gatedConn();
        const held = [
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
            dbExec('SELECT 1', [], { conn: gate.conn, timeoutMs: 5_000 }),
        ];
        await Bun.sleep(20);

        // Generous per-call budget: this caller must still be waiting when the
        // 60 ms lane default would already have rejected it.
        const queued = dbExec('SELECT 1', [], { conn: instantConn, timeoutMs: 5_000 })
            .then(() => 'admitted', () => 'rejected');
        await Bun.sleep(150);
        gate.releaseAll();

        expect(await queued).toBe('admitted');
        await Promise.all(held);
    });
});

/**
 * The unarmed path — admission's silent failure mode.
 *
 * `armGateway()` is called only by App.start(), so anything using the framework
 * database without booting an App gets no admission and no indication of it.
 */
describe('unarmed traffic is counted', () => {
    test('queries before arming are counted and reported', async () => {
        resetGateway();               // clears `armed`
        expect(getGatewayStats().armed).toBe(false);
        expect(getGatewayStats().unarmedCalls).toBe(0);

        await dbExec('SELECT 1', [], { conn: instantConn });
        await dbExec('SELECT 1', [], { conn: instantConn });

        const stats = getGatewayStats();
        expect(stats.armed).toBe(false);
        expect(stats.unarmedCalls).toBe(2);
    });

    test('arming stops the counter from growing', async () => {
        resetGateway();
        await dbExec('SELECT 1', [], { conn: instantConn });
        expect(getGatewayStats().unarmedCalls).toBe(1);

        armGateway();
        await dbExec('SELECT 1', [], { conn: instantConn });

        const stats = getGatewayStats();
        expect(stats.armed).toBe(true);
        expect(stats.unarmedCalls).toBe(1);   // unchanged: the second call was admitted
    });
});
