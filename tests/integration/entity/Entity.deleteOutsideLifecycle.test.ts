/**
 * Ticket B4/B5.
 *
 * EntityManager.deleteEntity used to resolve `false` unless the
 * DATABASE_READY lifecycle phase had fired. Standalone scripts
 * (`bun scripts/x.ts` → `getDb()`) never emit that phase, so `entity.delete()`
 * wrote nothing, logged nothing, threw nothing — and returned the same
 * `false` a legitimately-skipped delete returns. Saves in the same script
 * worked, because Entity.save() bypasses EntityManager entirely.
 *
 * These tests pin the delete path to the DB, not to a lifecycle flag, and
 * pin post-delete side effects into the drainable set.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import ApplicationLifecycle from '../../../core/ApplicationLifecycle';
import { pendingSideEffectCount } from '../../../core/entity/pendingOps';
import db from '../../../database';
import { Entity } from '../../../core/Entity';
import EntityManager from '../../../core/EntityManager';
import { TestUser } from '../../fixtures/components';
import { createTestContextWithoutCache, ensureComponentsRegistered } from '../../utils';

describe('Entity delete outside the app lifecycle', () => {
    const ctx = createTestContextWithoutCache();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
    });

    test('soft delete writes even when DATABASE_READY never fired', async () => {
        // A standalone script's world: whatever phase the process is in, the
        // delete must reach the database.
        const phase = ApplicationLifecycle.getCurrentPhase();
        expect(phase).toBeDefined();

        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'script-delete', email: 'sd@example.com', age: 33 });
        await entity.save();

        const result = await entity.delete();
        expect(result).toBe(true);

        const rows = await db.unsafe(`SELECT deleted_at FROM entities WHERE id = $1`, [entity.id]);
        expect(rows.length).toBe(1);
        expect(rows[0].deleted_at).not.toBeNull();
    });

    test('force delete removes the row', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'script-force', email: 'sf@example.com', age: 34 });
        await entity.save();

        expect(await entity.delete(true)).toBe(true);
        const rows = await db.unsafe(`SELECT id FROM entities WHERE id = $1`, [entity.id]);
        expect(rows.length).toBe(0);
    });

    test('EntityManager.deleteEntity delegates to doDelete rather than gating', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'manager-delete', email: 'md@example.com', age: 35 });
        await entity.save();

        expect(await EntityManager.deleteEntity(entity, true)).toBe(true);
        const rows = await db.unsafe(`SELECT id FROM entities WHERE id = $1`, [entity.id]);
        expect(rows.length).toBe(0);
    });

    test('an unpersisted entity still reports false (the one legitimate false)', async () => {
        const fresh = Entity.Create();
        expect(await fresh.delete()).toBe(false);
    });

    test('post-delete side effects are drainable', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'drain-delete', email: 'dd@example.com', age: 36 });
        await entity.save();
        await Entity.drainPendingSideEffects(5_000);

        await entity.delete();
        // The delete's hooks + cache invalidation are tracked, not orphaned —
        // so a script can await the drain instead of guessing with sleep().
        expect(pendingSideEffectCount()).toBeGreaterThan(0);

        await Entity.drainPendingSideEffects(5_000);
        expect(pendingSideEffectCount()).toBe(0);
    });
});
