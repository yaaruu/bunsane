/**
 * Integration tests for ArcheTypeQuery projection (Phase 1: opt-in select()).
 *
 * Proves that .select(...fields) loads ONLY the chosen components' data while
 * archetype membership filtering still requires all components. Verified via
 * entity.getInMemory(Comp): defined => loaded, undefined => skipped.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { TestUserWithOrdersArchetype } from '../../fixtures/archetypes/TestUserArchetype';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('ArcheTypeQuery projection (select)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    async function makeUserWithOrder(tag: string) {
        const e = ctx.tracker.create();
        e.add(TestUser, { name: `Proj_${tag}`, email: `proj_${tag}@example.com`, age: 33 });
        e.add(TestOrder, {
            orderNumber: `ORD_${tag}`,
            total: 100,
            status: 'paid',
            createdAt: new Date(),
        });
        await e.save();
        return e;
    }

    test('select() loads only the chosen component, skips the rest', async () => {
        const ent = await makeUserWithOrder('only_user');

        const results = await TestUserWithOrdersArchetype.query()
            .select('user')
            .exec();

        const row = results.find(r => r.id === ent.id);
        expect(row).toBeDefined();

        // Selected component data loaded...
        expect(row!.entity.getInMemory(TestUser)).toBeDefined();
        // ...unselected component NOT loaded (projection win).
        expect(row!.entity.getInMemory(TestOrder)).toBeUndefined();
    });

    test('select() with multiple fields loads exactly those', async () => {
        const ent = await makeUserWithOrder('both');

        const results = await TestUserWithOrdersArchetype.query()
            .select('user', 'order')
            .exec();

        const row = results.find(r => r.id === ent.id);
        expect(row).toBeDefined();
        expect(row!.entity.getInMemory(TestUser)).toBeDefined();
        expect(row!.entity.getInMemory(TestOrder)).toBeDefined();
    });

    test('without select(), all components load (backward compat)', async () => {
        const ent = await makeUserWithOrder('no_select');

        const results = await TestUserWithOrdersArchetype.query().exec();

        const row = results.find(r => r.id === ent.id);
        expect(row).toBeDefined();
        expect(row!.entity.getInMemory(TestUser)).toBeDefined();
        expect(row!.entity.getInMemory(TestOrder)).toBeDefined();
    });

    test('membership still requires all components despite narrow select', async () => {
        // Entity with ONLY TestUser (not a TestUserWithOrders) must NOT match.
        const onlyUser = ctx.tracker.create();
        onlyUser.add(TestUser, { name: 'Proj_lonely', email: 'proj_lonely@example.com', age: 40 });
        await onlyUser.save();

        const matching = await makeUserWithOrder('member');

        const results = await TestUserWithOrdersArchetype.query()
            .select('user')
            .exec();

        expect(results.some(r => r.id === matching.id)).toBe(true);
        expect(results.some(r => r.id === onlyUser.id)).toBe(false);
    });

    test('first() honors projection', async () => {
        const ent = await makeUserWithOrder('first');

        const row = await TestUserWithOrdersArchetype.query()
            .filter('user', 'eq', { email: 'proj_first@example.com' })
            .select('user')
            .first();

        expect(row).toBeDefined();
        expect(row!.id).toBe(ent.id);
        expect(row!.entity.getInMemory(TestUser)).toBeDefined();
        expect(row!.entity.getInMemory(TestOrder)).toBeUndefined();
    });

    test('select() on unknown field throws', () => {
        expect(() =>
            (TestUserWithOrdersArchetype.query() as any).select('nope')
        ).toThrow(/not a component field/);
    });
});
