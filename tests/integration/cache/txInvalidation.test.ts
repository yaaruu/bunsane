/**
 * Integration tests for transaction-aware cache invalidation.
 *
 * Proves that component writes performed via comp.save(trx, id) inside the
 * transaction() wrapper bust the component cache on commit — using the same
 * CacheManager.invalidateEntityComponents path entity.save() uses — while a
 * comp.save() OUTSIDE the wrapper leaves cache untouched (no regression).
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { CacheManager } from '../../../core/cache/CacheManager';
import { transaction } from '../../../core/cache/txInvalidation';
import { getMetadataStorage } from '../../../core/metadata';
import { getDb } from '../../../database';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('transaction-aware cache invalidation', () => {
    const ctx = createTestContext();
    const cm = () => CacheManager.getInstance();

    const userTypeId = () => getMetadataStorage().getComponentId('TestUser');
    const orderTypeId = () => getMetadataStorage().getComponentId('TestOrder');

    async function present(entityId: string, typeId: string): Promise<boolean> {
        const res = await cm().getComponents([{ entityId, typeId }]);
        return res[0] != null;
    }

    /** Create + persist an entity, return it with its in-memory TestUser instance. */
    async function makeUser(tag: string) {
        const e = ctx.tracker.create();
        e.add(TestUser, { name: `Tx_${tag}`, email: `tx_${tag}@example.com`, age: 42 });
        await e.save();
        return e;
    }

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    test('auto-track: comp.save(trx) inside transaction() busts cache on commit', async () => {
        const e = await makeUser('auto');
        const comp = e.getInMemory(TestUser)!;
        expect(comp).toBeDefined();

        // Warm the component cache deterministically.
        await cm().setComponentsBatchWriteThrough([
            { entityId: e.id, typeId: userTypeId(), component: comp },
        ]);
        expect(await present(e.id, userTypeId())).toBe(true);

        // Mutate via comp.save inside the wrapper.
        await transaction(async (trx) => {
            await comp.save(trx, e.id);
        });

        // Cache key busted after commit.
        expect(await present(e.id, userTypeId())).toBe(false);
    });

    test('no-op outside wrapper: bare comp.save() leaves cache intact', async () => {
        const e = await makeUser('bare');
        const comp = e.getInMemory(TestUser)!;

        await cm().setComponentsBatchWriteThrough([
            { entityId: e.id, typeId: userTypeId(), component: comp },
        ]);
        expect(await present(e.id, userTypeId())).toBe(true);

        // Save against top-level db (auto-commit) — NOT inside transaction().
        await comp.save(getDb(), e.id);

        // Untracked → cache untouched.
        expect(await present(e.id, userTypeId())).toBe(true);
    });

    test('explicit markDirty busts a component not directly saved', async () => {
        const e = await makeUser('mark');
        const comp = e.getInMemory(TestUser)!;

        // Warm BOTH a user key and a (fake) order key for this entity.
        await cm().setComponentsBatchWriteThrough([
            { entityId: e.id, typeId: userTypeId(), component: comp },
        ]);
        // Seed an order cache entry by reusing the user component shape under the order typeId.
        await cm().invalidateEntityComponents(e.id, [orderTypeId()]); // ensure clean
        await cm().setComponentsBatchWriteThrough([
            { entityId: e.id, typeId: orderTypeId(), component: comp },
        ]);
        expect(await present(e.id, orderTypeId())).toBe(true);

        await transaction(async (_trx, tx) => {
            tx.markDirty(e.id, TestOrder); // explicit, no save
        });

        expect(await present(e.id, orderTypeId())).toBe(false);
    });

    test('onCommit runs after commit with cache already flushed', async () => {
        const e = await makeUser('hook');
        const comp = e.getInMemory(TestUser)!;

        await cm().setComponentsBatchWriteThrough([
            { entityId: e.id, typeId: userTypeId(), component: comp },
        ]);

        let ran = false;
        let cacheGoneWhenHookRan: boolean | null = null;

        await transaction(async (trx, tx) => {
            await comp.save(trx, e.id);
            tx.onCommit(async () => {
                ran = true;
                cacheGoneWhenHookRan = !(await present(e.id, userTypeId()));
            });
        });

        expect(ran).toBe(true);
        // cacheGoneWhenHookRan is assigned inside the onCommit closure, which
        // TS control-flow can't observe — it stays narrowed to its `null` init.
        // Compare explicitly so the assertion type-checks without weakening it.
        expect(cacheGoneWhenHookRan === true).toBe(true);
    });

    test('transaction() returns the callback result', async () => {
        const out = await transaction(async () => 'done');
        expect(out).toBe('done');
    });
});
