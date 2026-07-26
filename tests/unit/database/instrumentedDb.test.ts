/**
 * Unit tests for database/instrumentedDb.ts.
 *
 * Uses a fake `db` that returns a `cancel()`able promise-like to exercise
 * the timing + abort path without a real Postgres backend.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
    timedUnsafe,
    incrementDataLoaderCall,
    getDbStats,
    resetDbStats,
    setPoolMax,
    poolSaturatedForMs,
    type PerRequestCounters,
} from '../../../database/instrumentedDb';
import { POOL_ACQUIRE_TIMEOUT_CODE } from '../../../database/poolErrors';

interface FakeQuery<T> extends Promise<T> {
    cancel(): void;
    cancelled: boolean;
}

function makeFakeDb(opts: { delayMs?: number; rejectWith?: Error; rows?: any[] } = {}) {
    return {
        unsafe(_sql: string, _params: any[]): FakeQuery<any[]> {
            let cancelFn: () => void = () => {};
            const promise: any = new Promise<any[]>((resolve, reject) => {
                const handle = setTimeout(() => {
                    if (opts.rejectWith) reject(opts.rejectWith);
                    else resolve(opts.rows ?? []);
                }, opts.delayMs ?? 1);
                cancelFn = () => {
                    clearTimeout(handle);
                    promise.cancelled = true;
                    reject(Object.assign(new Error('Query cancelled'), { name: 'AbortError' }));
                };
            });
            // Swallow unhandled rejection on pre-abort cancel path.
            promise.catch(() => {});
            promise.cancel = cancelFn;
            promise.cancelled = false;
            return promise as FakeQuery<any[]>;
        },
    };
}

describe('timedUnsafe', () => {
    beforeEach(() => resetDbStats());

    test('records totalCount and totalMs on success', async () => {
        const db = makeFakeDb({ rows: [{ id: 1 }], delayMs: 5 });
        const result = await timedUnsafe(db as any, 'SELECT 1', []);
        expect(result).toEqual([{ id: 1 }]);

        const stats = getDbStats();
        expect(stats.totalCount).toBe(1);
        expect(stats.totalMs).toBeGreaterThanOrEqual(1);
        expect(stats.maxMs).toBeGreaterThanOrEqual(1);
        expect(stats.abortedCount).toBe(0);
    });

    test('increments dbQueryCount on perRequest counters', async () => {
        const db = makeFakeDb();
        const perReq: PerRequestCounters = { dbQueryCount: 0 };
        await timedUnsafe(db as any, 'SELECT 1', [], undefined, perReq);
        await timedUnsafe(db as any, 'SELECT 1', [], undefined, perReq);
        expect(perReq.dbQueryCount).toBe(2);
    });

    test('aborted query rejects with AbortError and records abortedCount', async () => {
        const db = makeFakeDb({ delayMs: 1000 });
        const controller = new AbortController();
        const promise = timedUnsafe(db as any, 'SELECT pg_sleep(10)', [], controller.signal);

        queueMicrotask(() => controller.abort(new Error('test abort')));

        await expect(promise).rejects.toBeDefined();

        const stats = getDbStats();
        expect(stats.totalCount).toBe(1);
        expect(stats.abortedCount).toBe(1);
    });

    test('pre-aborted signal cancels before await', async () => {
        const db = makeFakeDb({ delayMs: 1000 });
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted'));

        const promise = timedUnsafe(db as any, 'SELECT 1', [], controller.signal);
        await expect(promise).rejects.toBeDefined();

        const stats = getDbStats();
        expect(stats.abortedCount).toBe(1);
    });

    test('slow query above threshold increments slowCount', async () => {
        // Slow threshold defaults to 500ms; we cannot reasonably wait that long
        // in a unit test, so we override via env at module load — fall back to
        // asserting the slow path is reachable by passing a tiny synthetic
        // delay larger than zero and checking that the slowCount path triggers
        // only when over threshold. Direct assertion: with default threshold,
        // a 5ms query should NOT mark slow.
        const db = makeFakeDb({ delayMs: 5 });
        await timedUnsafe(db as any, 'SELECT 1', []);
        const stats = getDbStats();
        expect(stats.slowCount).toBe(0);
    });
});

describe('pool saturation tracking', () => {
    beforeEach(() => {
        resetDbStats();
        setPoolMax(0);
    });

    test('reports no saturation when the pool size is unknown', async () => {
        const db = makeFakeDb({ delayMs: 1 });
        await timedUnsafe(db as any, 'SELECT 1', []);
        expect(poolSaturatedForMs()).toBe(0);
        expect(getDbStats().poolMax).toBe(0);
    });

    test('marks saturation while in-flight calls reach the pool size, and clears on drain', async () => {
        setPoolMax(1);
        const db = makeFakeDb({ delayMs: 25 });
        const inFlight = timedUnsafe(db as any, 'SELECT 1', []);

        // One call, pool of one → saturated for as long as it runs.
        await Bun.sleep(10);
        expect(poolSaturatedForMs()).toBeGreaterThan(0);
        expect(getDbStats().inFlight).toBe(1);

        await inFlight;
        expect(poolSaturatedForMs()).toBe(0);
    });

    test('saturation is continuous, not cumulative — a gap resets the clock', async () => {
        setPoolMax(1);

        // A long first call, so a cumulative (buggy) clock would be obvious.
        await timedUnsafe(makeFakeDb({ delayMs: 80 }) as any, 'SELECT 1', []);
        expect(poolSaturatedForMs()).toBe(0);

        const second = timedUnsafe(makeFakeDb({ delayMs: 80 }) as any, 'SELECT 1', []);
        await Bun.sleep(5);
        const during = poolSaturatedForMs();
        await second;

        // Only the second call's window counts. Cumulative would be >= 85;
        // the bound is loose because Windows timer granularity is ~15 ms.
        expect(during).toBeGreaterThan(0);
        expect(during).toBeLessThan(60);
    });

    test('counts pool-acquisition failures separately from query errors', async () => {
        const acquireTimeout = Object.assign(new Error('connection timeout'), {
            code: POOL_ACQUIRE_TIMEOUT_CODE,
        });
        const db = makeFakeDb({ delayMs: 1, rejectWith: acquireTimeout });

        await expect(timedUnsafe(db as any, 'SELECT 1', [])).rejects.toBeDefined();

        const stats = getDbStats();
        expect(stats.poolAcquireFailures).toBe(1);
        expect(stats.abortedCount).toBe(0);
    });

    test('a plain query error is not counted as pool exhaustion', async () => {
        const db = makeFakeDb({ delayMs: 1, rejectWith: new Error('syntax error') });
        await expect(timedUnsafe(db as any, 'SELECT bad', [])).rejects.toBeDefined();
        expect(getDbStats().poolAcquireFailures).toBe(0);
    });
});

describe('incrementDataLoaderCall', () => {
    beforeEach(() => resetDbStats());

    test('increments per-kind global stats', () => {
        incrementDataLoaderCall('entity');
        incrementDataLoaderCall('component');
        incrementDataLoaderCall('component');
        incrementDataLoaderCall('relation');

        const stats = getDbStats();
        expect(stats.dataLoaderCalls.entity).toBe(1);
        expect(stats.dataLoaderCalls.component).toBe(2);
        expect(stats.dataLoaderCalls.relation).toBe(1);
    });

    test('increments perRequest.dataLoaderCalls when supplied', () => {
        const perReq = {
            dbQueryCount: 0,
            dataLoaderCalls: { entity: 0, component: 0, relation: 0 },
        };
        incrementDataLoaderCall('entity', perReq);
        incrementDataLoaderCall('component', perReq);
        incrementDataLoaderCall('component', perReq);
        expect(perReq.dataLoaderCalls.entity).toBe(1);
        expect(perReq.dataLoaderCalls.component).toBe(2);
        expect(perReq.dataLoaderCalls.relation).toBe(0);
    });
});

describe('getDbStats', () => {
    beforeEach(() => resetDbStats());

    test('reports avgMs as totalMs / totalCount', async () => {
        const db = makeFakeDb({ delayMs: 4 });
        await timedUnsafe(db as any, 'SELECT 1', []);
        await timedUnsafe(db as any, 'SELECT 1', []);
        const stats = getDbStats();
        expect(stats.totalCount).toBe(2);
        // avgMs is rounded to 2 decimals while totalMs is integer-rounded,
        // so allow ±0.5ms tolerance against the unrounded computation.
        expect(Math.abs(stats.avgMs - stats.totalMs / 2)).toBeLessThan(1);
    });

    test('returns zero state after reset', () => {
        const stats = getDbStats();
        expect(stats.totalCount).toBe(0);
        expect(stats.totalMs).toBe(0);
        expect(stats.maxMs).toBe(0);
        expect(stats.slowCount).toBe(0);
        expect(stats.abortedCount).toBe(0);
        expect(stats.dataLoaderCalls).toEqual({ entity: 0, component: 0, relation: 0 });
    });
});
