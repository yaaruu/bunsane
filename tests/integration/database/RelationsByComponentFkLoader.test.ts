/**
 * Coverage for the type-scoped foreign-key relation loader
 * (relationsByComponentFk) that backs @HasMany/@BelongsToMany array relations
 * with a declared foreignKey.
 *
 * Previously those resolvers fired one Query.exec() PER PARENT ROW (N+1). The
 * loader batches all parents sharing a (componentType, fkField) into a single
 * `data->>'fk' = ANY($2)` query. Critically it pins `type_id`, so it must NOT
 * match a different component type that happens to carry the same FK value in
 * some other field — that is the correctness risk this suite guards.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../../../database';
import { createRequestLoaders } from '../../../core/RequestLoaders';
import { TestOrder, TestProduct } from '../../fixtures/components';
import { createTestContextWithoutCache, ensureComponentsRegistered } from '../../utils';

describe('relationsByComponentFk loader', () => {
    const ctx = createTestContextWithoutCache();
    const orderTypeId = new TestOrder().getTypeID();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestOrder, TestProduct);
    });

    test('batches and returns related entities scoped to the component type', async () => {
        const parent = ctx.tracker.create();
        parent.add(TestProduct, { sku: 'p', name: 'parent', price: 1, inStock: true });
        await parent.save();

        // Two TestOrder children referencing parent via orderNumber.
        const child1 = ctx.tracker.create();
        child1.add(TestOrder, { orderNumber: parent.id, total: 10, status: 'open', createdAt: new Date() });
        await child1.save();

        const child2 = ctx.tracker.create();
        child2.add(TestOrder, { orderNumber: parent.id, total: 20, status: 'open', createdAt: new Date() });
        await child2.save();

        // Decoy: a TestProduct whose sku == parent.id. Different component type;
        // must be excluded because the loader pins type_id to TestOrder.
        const decoy = ctx.tracker.create();
        decoy.add(TestProduct, { sku: parent.id, name: 'decoy', price: 5, inStock: true });
        await decoy.save();

        const loaders = createRequestLoaders(db);
        const result = await loaders.relationsByComponentFk.load({
            entityId: parent.id,
            componentTypeId: orderTypeId,
            foreignKeyField: 'orderNumber',
        });

        const ids = result.map(e => e.id).sort();
        expect(ids).toEqual([child1.id, child2.id].sort());
        expect(ids).not.toContain(decoy.id);
    });

    test('returns [] for an entity with no related rows', async () => {
        const loaders = createRequestLoaders(db);
        const result = await loaders.relationsByComponentFk.load({
            entityId: '00000000-0000-0000-0000-000000000000',
            componentTypeId: orderTypeId,
            foreignKeyField: 'orderNumber',
        });
        expect(result).toEqual([]);
    });

    test('resolves multiple parents loaded in the same tick (batched)', async () => {
        const parentA = ctx.tracker.create();
        parentA.add(TestProduct, { sku: 'a', name: 'A', price: 1, inStock: true });
        await parentA.save();
        const parentB = ctx.tracker.create();
        parentB.add(TestProduct, { sku: 'b', name: 'B', price: 1, inStock: true });
        await parentB.save();

        const aChild = ctx.tracker.create();
        aChild.add(TestOrder, { orderNumber: parentA.id, total: 1, status: 'open', createdAt: new Date() });
        await aChild.save();
        const bChild = ctx.tracker.create();
        bChild.add(TestOrder, { orderNumber: parentB.id, total: 1, status: 'open', createdAt: new Date() });
        await bChild.save();

        const loaders = createRequestLoaders(db);
        // Same-tick loads share one batch dispatch.
        const [ra, rb] = await Promise.all([
            loaders.relationsByComponentFk.load({ entityId: parentA.id, componentTypeId: orderTypeId, foreignKeyField: 'orderNumber' }),
            loaders.relationsByComponentFk.load({ entityId: parentB.id, componentTypeId: orderTypeId, foreignKeyField: 'orderNumber' }),
        ]);

        expect(ra.map(e => e.id)).toEqual([aChild.id]);
        expect(rb.map(e => e.id)).toEqual([bChild.id]);
    });
});
