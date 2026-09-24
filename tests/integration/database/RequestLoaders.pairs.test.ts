/**
 * Relation loaders must fail the batch on SQL/pool errors (not resolve []).
 * Component loads must return only the requested (entity, type) pairs.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../../../database';
import { createRequestLoaders } from '../../../core/RequestLoaders';
import { TestOrder, TestProduct } from '../../fixtures/components';
import { createTestContextWithoutCache, ensureComponentsRegistered } from '../../utils';

describe('request loader error and pair semantics', () => {
    const ctx = createTestContextWithoutCache();
    const orderTypeId = new TestOrder().getTypeID();
    const productTypeId = new TestProduct().getTypeID();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestOrder, TestProduct);
    });

    test('relationsByComponentFk rejects when the query is aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('relation query aborted'));
        const loaders = createRequestLoaders(db, undefined, controller.signal);
        await expect(loaders.relationsByComponentFk.load({
            entityId: '00000000-0000-0000-0000-000000000000',
            componentTypeId: orderTypeId,
            foreignKeyField: 'orderNumber',
        })).rejects.toBeDefined();
    });

    test('relationsByEntityField rejects when the query is aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('relation query aborted'));
        const loaders = createRequestLoaders(db, undefined, controller.signal);
        await expect(loaders.relationsByEntityField.load({
            entityId: '00000000-0000-0000-0000-000000000000',
            relationField: 'orders',
            relatedType: 'TestOrder',
            foreignKey: 'orderNumber',
        })).rejects.toBeDefined();
    });

    test('componentsByEntityType returns only the requested pairs', async () => {
        const a = ctx.tracker.create();
        a.add(TestOrder, { orderNumber: 'a-order', total: 1, status: 'open', createdAt: new Date() });
        a.add(TestProduct, { sku: 'a-sku', name: 'A', price: 1, inStock: true });
        await a.save();

        const b = ctx.tracker.create();
        b.add(TestOrder, { orderNumber: 'b-order', total: 2, status: 'open', createdAt: new Date() });
        b.add(TestProduct, { sku: 'b-sku', name: 'B', price: 2, inStock: true });
        await b.save();

        const loaders = createRequestLoaders(db);
        const [aOrder, bProduct] = await Promise.all([
            loaders.componentsByEntityType.load({ entityId: a.id, typeId: orderTypeId }),
            loaders.componentsByEntityType.load({ entityId: b.id, typeId: productTypeId }),
        ]);

        expect(aOrder?.entityId).toBe(a.id);
        expect(aOrder?.typeId).toBe(orderTypeId);
        expect(aOrder?.data?.orderNumber).toBe('a-order');
        expect(aOrder?.data?.sku).toBeUndefined();

        expect(bProduct?.entityId).toBe(b.id);
        expect(bProduct?.typeId).toBe(productTypeId);
        expect(bProduct?.data?.sku).toBe('b-sku');
        expect(bProduct?.data?.orderNumber).toBeUndefined();
    });
});
