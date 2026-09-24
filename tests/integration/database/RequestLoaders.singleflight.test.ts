/**
 * Component-miss singleflight must not share a leader's abort with other
 * requests, and a read after a write/clear must not join a flight that
 * started before that write.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../../../database';
import { dbTransaction } from '../../../database/gateway';
import { createRequestLoaders } from '../../../core/RequestLoaders';
import { TestProduct } from '../../fixtures/components';
import { createTestContextWithoutCache, ensureComponentsRegistered } from '../../utils';
import type { PerRequestCounters } from '../../../database/instrumentedDb';

describe('component miss singleflight isolation', () => {
    const ctx = createTestContextWithoutCache();
    const productTypeId = new TestProduct().getTypeID();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestProduct);
    });

    async function holdConnection(): Promise<() => Promise<void>> {
        const { promise: release, resolve: releaseHold } = Promise.withResolvers<void>();
        const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
        const done = dbTransaction(async (tx) => {
            await tx.unsafe('SELECT 1');
            markHeld();
            await release;
        }, { lane: 'request', label: 'test.hold-connection' });
        await held;
        return async () => {
            releaseHold();
            await done;
        };
    }

    test('a joiner still loads when the leader request aborts', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestProduct, { sku: 'flight-sku', name: 'Flight', price: 3, inStock: true });
        await entity.save();

        const release = await holdConnection();
        const leaderCtrl = new AbortController();
        const leader = createRequestLoaders(db, undefined, leaderCtrl.signal);
        const joiner = createRequestLoaders(db);
        const key = { entityId: entity.id, typeId: productTypeId };

        const leaderLoad = leader.componentsByEntityType.load(key);
        const joinerLoad = joiner.componentsByEntityType.load(key);
        await new Promise((resolve) => setImmediate(resolve));
        leaderCtrl.abort(new Error('leader disconnected'));
        const settled = Promise.allSettled([leaderLoad, joinerLoad]);
        await release();
        const [leaderResult, joinerResult] = await settled;

        expect(leaderResult.status).toBe('rejected');
        expect(joinerResult.status).toBe('fulfilled');
        if (joinerResult.status === 'fulfilled') {
            expect(joinerResult.value?.entityId).toBe(entity.id);
            expect(joinerResult.value?.data?.sku).toBe('flight-sku');
        }
    });

    test('a read after clear does not join a flight started before the write', async () => {
        const entity = ctx.tracker.create();
        entity.add(TestProduct, { sku: 'before', name: 'Before', price: 1, inStock: true });
        await entity.save();

        const release = await holdConnection();
        const firstCounters: PerRequestCounters = { dbQueryCount: 0 };
        const secondCounters: PerRequestCounters = { dbQueryCount: 0 };
        const first = createRequestLoaders(db, undefined, undefined, firstCounters);
        const second = createRequestLoaders(db, undefined, undefined, secondCounters);
        const key = { entityId: entity.id, typeId: productTypeId };

        const firstLoad = first.componentsByEntityType.load(key);
        await new Promise((resolve) => setImmediate(resolve));
        first.componentsByEntityType.clear(key);
        const secondLoad = second.componentsByEntityType.load(key);
        const settled = Promise.all([firstLoad, secondLoad]);
        await release();
        const [before, after] = await settled;

        expect(before?.data?.sku).toBe('before');
        expect(after?.data?.sku).toBe('before');
        expect(firstCounters.dbQueryCount).toBeGreaterThan(0);
        expect(secondCounters.dbQueryCount).toBeGreaterThan(0);
    });
});
