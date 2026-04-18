/**
 * Integration tests for Entity.save timeout and cancellation behavior.
 *
 * Regression coverage for the production incident where Entity.save's wall-
 * clock timeout rejected the outer Promise but left the underlying Bun SQL
 * transaction mid-flight. Under pgbouncer transaction-mode pooling this
 * leaked backend PostgreSQL sessions into `idle in transaction` state,
 * exhausting the pool.
 *
 * These tests prove the invariants the fix must uphold:
 *   1. An aborted save leaves no partial rows — Bun SQL's transaction callback
 *      throws, auto-ROLLBACK fires, backend connection is released.
 *   2. The connection pool stays healthy after repeated aborts — subsequent
 *      saves on fresh entities still succeed.
 *   3. A save with no abort still commits normally.
 *
 * The wall-clock DB_QUERY_TIMEOUT path is module-cached at import time so it
 * is not exercised here directly. Manual verification on a real Postgres +
 * pgbouncer stack (with query_wait_timeout short enough to fire) should
 * confirm pg_stat_activity shows no `idle in transaction` backends after
 * this test suite runs. See the handoff doc (2026-04-18) for the repro steps.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import db from '../../../database';
import { TestUser } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('Entity.save timeout and cancellation', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
    });

    test('aborted doSave does not leave partial rows (transaction rolls back)', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'aborted', email: 'a@example.com', age: 1 });

        const controller = new AbortController();
        // Abort immediately — the first in-flight query will be cancelled,
        // the transaction callback throws, Bun SQL issues ROLLBACK.
        queueMicrotask(() => controller.abort(new Error('simulated save timeout')));

        const result = db.transaction(async (trx) => {
            await entity.doSave(trx, controller.signal);
        });

        await expect(result).rejects.toBeDefined();

        // Entity must NOT exist — rollback invariant.
        const rows = await db`SELECT id FROM entities WHERE id = ${entity.id}`;
        expect(rows.length).toBe(0);
    });

    test('connection pool stays healthy after multiple aborted saves', async () => {
        // Repeatedly abort saves — if connections leaked, subsequent saves
        // would eventually block on pool acquire.
        for (let i = 0; i < 8; i++) {
            const entity = Entity.Create();
            entity.add(TestUser, { name: `aborted-${i}`, email: `a${i}@e.com`, age: i });

            const controller = new AbortController();
            queueMicrotask(() => controller.abort(new Error('simulated timeout')));

            await db.transaction(async (trx) => {
                await entity.doSave(trx, controller.signal);
            }).catch(() => { /* expected */ });
        }

        // A fresh save must still succeed on the pool that serviced the aborts.
        const healthy = ctx.tracker.create();
        healthy.add(TestUser, { name: 'healthy', email: 'h@e.com', age: 99 });
        await healthy.save();

        expect(healthy._persisted).toBe(true);

        const rows = await db`SELECT id FROM entities WHERE id = ${healthy.id}`;
        expect(rows.length).toBe(1);
    });

    test('doSave without signal behaves normally (backwards compatible)', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'no-signal', email: 'n@e.com', age: 5 });

        await db.transaction(async (trx) => {
            await entity.doSave(trx); // no signal passed
        });

        const rows = await db`SELECT id FROM entities WHERE id = ${entity.id}`;
        expect(rows.length).toBe(1);
    });

    test('save() resolves even if post-commit cache work is slow (fire-and-forget)', async () => {
        // Cache handler is queued via queueMicrotask; save() must resolve as
        // soon as the DB transaction commits. We assert save resolves quickly
        // even though handleCacheAfterSave is awaited separately.
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'fast', email: 'f@e.com', age: 10 });

        const start = performance.now();
        await entity.save();
        const elapsed = performance.now() - start;

        expect(entity._persisted).toBe(true);
        // Generous bound — if cache were blocking save, timings under load
        // could stretch past the budget. This just guards gross regressions.
        expect(elapsed).toBeLessThan(5000);
    });
});
