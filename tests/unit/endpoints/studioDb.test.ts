/**
 * Studio DB access policy (endpoints/db.ts).
 *
 * Studio is HTTP-reachable admin tooling sharing one pool with user traffic, and
 * before the execution seam it reached Postgres with no timeout, no metric, and
 * no concurrency bound. These tests pin the two properties that migration added,
 * both of which are invisible in a passing manual click-through:
 *
 *  - studio work runs in the `background` lane, so it can never occupy the whole
 *    pool ahead of user requests;
 *  - a capacity failure answers 503, not 500. Studio handlers catch their own
 *    errors, so the mapping in requestRouter never sees them — reporting a
 *    saturated pool as an internal server error is what made the outage hard to
 *    read from the outside.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    STUDIO_DB_TIMEOUT_MS,
    studioDeadline,
    studioExec,
    studioErrorResponse,
} from '../../../endpoints/db';
import {
    DbAdmissionTimeoutError,
    armGateway,
    resetGateway,
    getGatewayStats,
} from '../../../database/gateway';
import { resetDbStats, setPoolMax } from '../../../database/instrumentedDb';

const originalAdmission = process.env.BUNSANE_DB_ADMISSION;

beforeEach(() => {
    resetGateway();
    resetDbStats();
});

afterEach(() => {
    resetGateway();
    resetDbStats();
    if (originalAdmission === undefined) delete process.env.BUNSANE_DB_ADMISSION;
    else process.env.BUNSANE_DB_ADMISSION = originalAdmission;
});

describe('studio error mapping', () => {
    test('admission timeout answers 503 with Retry-After, not 500', async () => {
        const err = new DbAdmissionTimeoutError('background', 1234, 'studio.table.rows');
        const res = studioErrorResponse(err, 'Failed to fetch table data');

        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('1');

        const body = await res.json();
        expect(body.code).toBe('POOL_EXHAUSTED');
        expect(body.retryable).toBe(true);
    });

    test('a pool acquisition failure is also capacity, not a request failure', async () => {
        const err = Object.assign(new Error('connection timeout'), {
            code: 'ERR_POSTGRES_CONNECTION_TIMEOUT',
        });
        const res = studioErrorResponse(err, 'Failed to fetch stats');

        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('POOL_EXHAUSTED');
    });

    test('an ordinary failure stays a 500 and keeps its context', async () => {
        const res = studioErrorResponse(new Error('relation "nope" does not exist'), 'Failed to fetch table data');

        expect(res.status).toBe(500);
        // The context prefix is what tells an operator WHICH handler failed;
        // losing it turns a studio 500 into an unattributable one.
        expect((await res.json()).error).toBe(
            'Failed to fetch table data: relation "nope" does not exist',
        );
    });

    test('a non-Error rejection does not produce "[object Object]"', async () => {
        const res = studioErrorResponse({ weird: true }, 'Failed to fetch entities');
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('Failed to fetch entities: Unknown error');
    });
});

describe('studio budget', () => {
    test('the deadline is absolute and shared, not a per-query timeout', () => {
        const before = Date.now();
        const deadline = studioDeadline();

        expect(deadline).toBeGreaterThanOrEqual(before + STUDIO_DB_TIMEOUT_MS);
        expect(deadline).toBeLessThanOrEqual(Date.now() + STUDIO_DB_TIMEOUT_MS);
    });

    test('defaults well below the 30s pool default', () => {
        // A studio tab holding pool slots for 30s while the API degrades is the
        // shape of the problem; 15s is generous for admin tooling.
        expect(STUDIO_DB_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
        expect(STUDIO_DB_TIMEOUT_MS).toBeGreaterThan(0);
    });

    test('an already-expired deadline fails without reaching the database', async () => {
        armGateway();
        setPoolMax(4);

        // A handler that has already spent its budget must not start another
        // query. `archetypes.ts` loops until it fills a page, so without this
        // the loop would keep issuing statements against a slow database.
        await expect(
            studioExec('studio.test.expired', Date.now() - 1, 'SELECT 1'),
        ).rejects.toThrow();
    });
});

describe('studio lane', () => {
    test('studio queries draw on the background lane', async () => {
        armGateway();
        setPoolMax(4);

        const before = getGatewayStats().admitted.background;
        await studioExec('studio.test.lane', studioDeadline(), 'SELECT 1');
        const after = getGatewayStats();

        expect(after.admitted.background).toBe(before + 1);
        // The point of the lane: user traffic's accounting is untouched.
        expect(after.admitted.request).toBe(0);
    });

    test('the background lane is capped below the admission limit', async () => {
        armGateway();
        setPoolMax(10);

        const stats = getGatewayStats();
        // Admin tooling must never be able to occupy the whole pool.
        expect(stats.backgroundLimit).toBeLessThan(stats.admissionLimit);
    });
});
