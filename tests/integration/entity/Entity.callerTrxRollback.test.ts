/**
 * Entity.save(trx) inside a caller-owned transaction that later rolls back.
 *
 * The save's statements succeed, so the instance is flagged clean — but the
 * enclosing transaction then rolls back. The flags must return to "unsaved" so
 * a retry writes again, and post-commit side effects (hooks, cache) must wait
 * for the caller's commit and never run for a rolled-back save.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db, { getDb } from '../../../database';
import EntityHookManager from '../../../core/EntityHookManager';
import type { EntityCreatedEvent } from '../../../core/events/EntityLifecycleEvents';
import { drainPendingSideEffects } from '../../../core/entity/pendingOps';
import { TestUser, TestProduct } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

class Abort extends Error {}
async function rolledBack(fn: (trx: Bun.SQL) => Promise<void>): Promise<void> {
    const attempt = db.transaction(async (trx) => {
        await fn(trx);
        throw new Abort('caller rolls back');
    });
    await expect(attempt).rejects.toBeInstanceOf(Abort);
}

async function componentNames(entityId: string): Promise<string[]> {
    const rows = await db`SELECT name FROM components WHERE entity_id = ${entityId} AND deleted_at IS NULL ORDER BY name`;
    return rows.map((r: { name: string }) => r.name);
}

describe('Entity.save with a caller transaction that rolls back', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
    });

    test('a new entity saved in a rolled-back transaction is written by the retry', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'rb-new', email: 'rb-new@example.com', age: 1 });

        await rolledBack((trx) => entity.save(trx).then(() => undefined));
        expect(await componentNames(entity.id)).toEqual([]);

        await entity.save();
        expect((await db`SELECT id FROM entities WHERE id = ${entity.id}`).length).toBe(1);
        expect(await componentNames(entity.id)).toEqual(['TestUser']);
    });

    test('an update in a rolled-back transaction is written by the retry', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'rb-before', email: 'rb-upd@example.com', age: 2 });
        await entity.save();

        await entity.set(TestUser, { name: 'rb-after' });
        await rolledBack((trx) => entity.save(trx).then(() => undefined));

        await entity.save();
        const rows = await db`SELECT data->>'name' AS name FROM components WHERE entity_id = ${entity.id} AND name = 'TestUser'`;
        expect(rows[0].name).toBe('rb-after');
    });

    test('a removal in a rolled-back transaction is applied by the retry', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'rb-rm', email: 'rb-rm@example.com', age: 3 });
        entity.add(TestProduct, { sku: 'rb-rm-sku', name: 'rb-rm-product', price: 1, inStock: true });
        await entity.save();

        entity.remove(TestProduct);
        await rolledBack((trx) => entity.save(trx).then(() => undefined));
        expect(await componentNames(entity.id)).toEqual(['TestProduct', 'TestUser']);

        await entity.save();
        expect(await componentNames(entity.id)).toEqual(['TestUser']);
    });

    test('two saves of one entity in the same transaction commit once, then roll back together', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'rb-twice', email: 'rb-twice@example.com', age: 4 });

        await rolledBack(async (trx) => {
            await entity.save(trx);
            await entity.set(TestUser, { age: 5 }, { trx });
            await entity.save(trx); // update, not a second INSERT
        });

        await entity.save();
        const rows = await db`SELECT (data->>'age')::int AS age FROM components WHERE entity_id = ${entity.id} AND name = 'TestUser'`;
        expect(rows.map((r: { age: number }) => r.age)).toEqual([5]);
    });

    test('entity.created hooks wait for the caller commit and skip a rollback', async () => {
        const seen: string[] = [];
        const hookId = EntityHookManager.registerEntityHook<EntityCreatedEvent>('entity.created', (event) => {
            seen.push(event.getEntity().id);
        });
        try {
            const dropped = ctx.tracker.create();
            dropped.add(TestUser, { name: 'rb-hook-dropped', email: 'rb-hd@example.com', age: 6 });
            await rolledBack((trx) => dropped.save(trx).then(() => undefined));

            const kept = ctx.tracker.create();
            kept.add(TestUser, { name: 'rb-hook-kept', email: 'rb-hk@example.com', age: 7 });
            await getDb().transaction(async (trx) => {
                await kept.save(trx);
                await drainPendingSideEffects();
                expect(seen).not.toContain(kept.id); // not committed yet
            });
            await drainPendingSideEffects();

            expect(seen).toContain(kept.id);
            expect(seen).not.toContain(dropped.id);
        } finally {
            EntityHookManager.removeHook(hookId);
        }
    });

    test('a save inside a rolled-back savepoint of a committed transaction is retried and fires no hook', async () => {
        const seen: string[] = [];
        const hookId = EntityHookManager.registerEntityHook<EntityCreatedEvent>('entity.created', (event) => {
            seen.push(event.getEntity().id);
        });
        try {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'rb-sp', email: 'rb-sp@example.com', age: 8 });
            await db.transaction(async (trx) => {
                await expect(trx.savepoint(async (sp) => {
                    await entity.save(sp);
                    throw new Abort('savepoint rolls back');
                })).rejects.toBeInstanceOf(Abort);
            });
            await drainPendingSideEffects();
            expect(seen).not.toContain(entity.id);
            expect(await componentNames(entity.id)).toEqual([]);

            await entity.save();
            await drainPendingSideEffects();
            expect(await componentNames(entity.id)).toEqual(['TestUser']);
            expect(seen).toContain(entity.id);
        } finally {
            EntityHookManager.removeHook(hookId);
        }
    });
});
