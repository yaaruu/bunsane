/**
 * Regression coverage for the read-path AbortSignal gap.
 *
 * Commit d1dde84 threaded an AbortSignal through Entity.save / doDelete so a
 * wall-clock timeout could cancel in-flight writes and avoid leaking the
 * backend into `idle in transaction`. The matching READ path
 * (Entity._loadComponent / get / reload) was missed: it issued
 *   SELECT id, data FROM components WHERE entity_id = $1 AND type_id = $2 ...
 * via a tagged template with no signal, so a read running on a caller's
 * transaction could not be cancelled and held the backend open on timeout.
 *
 * These tests prove the read now honours an AbortSignal while staying
 * backwards compatible when no signal is supplied.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { TestUser } from '../../fixtures/components';
import { createTestContextWithoutCache, ensureComponentsRegistered } from '../../utils';

describe('Entity read-path AbortSignal', () => {
    const ctx = createTestContextWithoutCache();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
    });

    test('get() with an already-aborted signal cancels the read (returns null, no query)', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'abort-read', email: 'ar@example.com', age: 7 });
        await entity.save();

        // Fresh instance with no in-memory components forces the DB read path.
        const fresh = Entity.CreateWithId(entity.id);
        const controller = new AbortController();
        controller.abort(new Error('simulated request timeout'));

        const data = await fresh.get(TestUser, { signal: controller.signal });
        // runWithSignal short-circuits before awaiting the query; _loadComponent
        // swallows the abort and returns null rather than hanging on the read.
        expect(data).toBeNull();
    });

    test('get() with no signal still loads from DB (backwards compatible)', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'no-signal-read', email: 'nsr@example.com', age: 8 });
        await entity.save();

        const fresh = Entity.CreateWithId(entity.id);
        const data = await fresh.get(TestUser);
        expect(data?.name).toBe('no-signal-read');
    });

    test('get() with a live (non-aborted) signal loads normally', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'live-signal', email: 'ls@example.com', age: 9 });
        await entity.save();

        const fresh = Entity.CreateWithId(entity.id);
        const controller = new AbortController();
        const data = await fresh.get(TestUser, { signal: controller.signal });
        expect(data?.name).toBe('live-signal');
    });

    test('reload() with an already-aborted signal rejects (cancellable)', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'reload-abort', email: 'rla@example.com', age: 10 });
        await entity.save();

        const fresh = Entity.CreateWithId(entity.id);
        const controller = new AbortController();
        controller.abort(new Error('simulated request timeout'));

        await expect(fresh.reload({ signal: controller.signal })).rejects.toBeDefined();
    });
});
