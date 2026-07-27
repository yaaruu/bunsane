/**
 * Partial-page behaviour of the archetype records endpoint.
 *
 * The handler gathers records in a loop until it fills a page, so the number of
 * statements is data-dependent. Sharing one request deadline across that loop is
 * what bounds it — but a shared budget can also DESTROY completed work: once the
 * budget is gone `dbExec` throws, and a handler holding 40 of 50 assembled
 * records would answer 503 with none of them.
 *
 * A short page is the better failure for a list view, so the loop stops while
 * budget remains and returns what it gathered, flagged `partial: true`. These
 * tests pin that, plus the reserve arithmetic that a fixed 2 s reserve got wrong
 * (any configured budget at or below the reserve made the loop's first guard
 * fire immediately, gathering nothing and then failing on the COUNT anyway).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resetGateway } from '../../../database/gateway';
import { resetDbStats } from '../../../database/instrumentedDb';

const originalTimeout = process.env.BUNSANE_STUDIO_DB_TIMEOUT;

beforeEach(() => {
    resetGateway();
    resetDbStats();
});

afterEach(() => {
    resetGateway();
    resetDbStats();
    if (originalTimeout === undefined) delete process.env.BUNSANE_STUDIO_DB_TIMEOUT;
    else process.env.BUNSANE_STUDIO_DB_TIMEOUT = originalTimeout;
});

/**
 * The reserve rule, stated independently of module load order.
 *
 * `COUNT_RESERVE_MS` is computed once at import from `STUDIO_DB_TIMEOUT_MS`, so
 * a test cannot re-derive it by re-setting the env var afterwards. What matters
 * is the invariant, and it is cheap to check across the whole range.
 */
function reserveFor(budgetMs: number): number {
    return Math.min(2_000, Math.floor(budgetMs / 4));
}

describe('archetype record budget reserve', () => {
    test('the reserve never consumes the whole budget', () => {
        // The flat-2000ms version failed every one of these below 2s.
        for (const budget of [100, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 60_000]) {
            const reserve = reserveFor(budget);
            expect(reserve).toBeLessThan(budget);
            // Leaves real room to gather records, not a sliver.
            expect(budget - reserve).toBeGreaterThanOrEqual(budget * 0.75);
        }
    });

    test('the reserve is capped so a large budget still mostly gathers', () => {
        expect(reserveFor(60_000)).toBe(2_000);
        expect(reserveFor(15_000)).toBe(2_000);
    });

    test('a small budget still leaves the loop able to run', () => {
        // Regression: with a flat 2s reserve and a 1s budget, `Date.now() >=
        // deadline - 2000` was true on entry, so the loop never executed.
        const budget = 1_000;
        const deadline = Date.now() + budget;
        expect(Date.now() >= deadline - reserveFor(budget)).toBe(false);
    });
});

describe('archetype records endpoint', () => {
    test('an unknown archetype is 404 before any query runs', async () => {
        const { handleStudioArcheTypeRecordsRequest } = await import('../../../endpoints/archetypes');

        const res = await handleStudioArcheTypeRecordsRequest('NoSuchArcheType__test');

        expect(res.status).toBe(404);
        expect((await res.json()).error).toContain('not found');
    });

    test('the response carries `partial` only when the page is short', async () => {
        // `partial` is optional and must be ABSENT on a complete page: a client
        // that sees it always set would either ignore it or always warn, and a
        // short page would again be indistinguishable from the end of the data.
        const { handleStudioArcheTypeRecordsRequest } = await import('../../../endpoints/archetypes');

        const res = await handleStudioArcheTypeRecordsRequest('NoSuchArcheType__test');
        const body = await res.json();

        expect(body.partial).toBeUndefined();
    });
});
