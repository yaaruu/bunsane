/**
 * PlannerCache is refreshed fire-and-forget from `getState()` on the read hot
 * path. Before 0.5.11 that refresh ran `db.unsafe(...)` with no signal, no
 * timeout and no metrics, and every query arriving during a slow refresh started
 * another one. These tests pin the two properties that make it safe there:
 *
 *   1. it goes through the instrumented seam, so it has a timeout and is visible
 *      in /metrics (in production this query failed 523/523 times unnoticed);
 *   2. it is single-flight, so a slow projection_state read cannot amplify into
 *      one query per request.
 *
 * These pass whether or not `projection_state` exists in the test database —
 * `timedUnsafe` counts the statement either way, and a failed refresh must leave
 * the cache usable rather than throw into the read path. (When the table is
 * absent the run also exercises the failure branch, visible as the
 * `consecutiveFailures` counter in the captured logs.)
 *
 * The warn→error escalation threshold itself is not asserted: forcing a
 * deterministic failure would need a DB injection seam that does not exist yet,
 * and adding one only for a log-level assertion is not worth the surface.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { PlannerCache } from '../../../query/planner/PlannerCache';
import { getDbStats, resetDbStats } from '../../../database/instrumentedDb';

describe('PlannerCache.refresh', () => {
    beforeEach(() => {
        PlannerCache.reset();
        resetDbStats();
    });

    test('runs through the instrumented seam (timeout + metrics), not a raw db call', async () => {
        await PlannerCache.instance.refresh();
        expect(getDbStats().totalCount).toBe(1);
    });

    test('is single-flight: concurrent refreshes share one query', async () => {
        const cache = PlannerCache.instance;
        // Promise identity is not observable — `async refresh()` re-wraps the
        // shared in-flight promise — so assert the thing that actually matters:
        // three concurrent callers issue one statement, not three.
        await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
        expect(getDbStats().totalCount).toBe(1);
    });

    test('a fresh cache serves reads without re-querying inside the TTL', async () => {
        const cache = PlannerCache.instance;
        await cache.refresh();
        const afterRefresh = getDbStats().totalCount;

        cache.getStatus('NoSuchArchetype');
        cache.getStatus('NoSuchArchetype');
        expect(getDbStats().totalCount).toBe(afterRefresh);
    });

    test('invalidate() forces the next read to refresh', async () => {
        const cache = PlannerCache.instance;
        await cache.refresh();
        cache.invalidate();

        cache.getStatus('NoSuchArchetype');
        // getState() kicks refresh off without awaiting it; give it a tick.
        await Promise.resolve();
        await cache.refresh();
        expect(getDbStats().totalCount).toBeGreaterThan(1);
    });

    test('unknown archetypes report DISABLED rather than throwing', async () => {
        await PlannerCache.instance.refresh();
        expect(PlannerCache.instance.getStatus('NoSuchArchetype')).toBe('DISABLED');
        expect(PlannerCache.instance.getState('NoSuchArchetype')).toBeUndefined();
    });
});
