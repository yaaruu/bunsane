/**
 * Bare `entity.get()` (no request loaders) must use the shared component
 * cache the same way the DataLoader path does: serve cached rows, tombstone
 * confirmed absences, and let a later save overwrite the tombstone.
 *
 * Before: this path went straight to SQL on every call, so any code running
 * outside a GraphQL request scope (auth role checks, schedulers, reconcile
 * sweeps) paid a round trip per component per call regardless of cache.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import db from '../../../database';
import { Entity } from '../../../core/Entity';
import { CacheManager, COMPONENT_TOMBSTONE } from '../../../core/cache/CacheManager';
import { ComponentRegistry } from '../../../core/components';
import { drainPendingCacheOps } from '../../../core/entity/pendingOps';
import { loadComponent } from '../../../core/entity/componentAccess';
import { TestUser, TestProduct } from '../../fixtures/components';
import { EntityTracker, ensureComponentsRegistered } from '../../utils';
import EntityManager from '../../../core/EntityManager';

describe('bare entity.get() uses the component cache', () => {
    const tracker = new EntityTracker();
    let cacheManager: CacheManager;
    let userTypeId: string;
    let productTypeId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
        userTypeId = ComponentRegistry.getComponentId('TestUser')!;
        productTypeId = ComponentRegistry.getComponentId('TestProduct')!;
    });

    beforeEach(async () => {
        (EntityManager as any).dbReady = true;
        cacheManager = CacheManager.getInstance();
        await cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000, negativeCacheEnabled: true, negativeCacheTtl: 60_000 },
            query: { enabled: false, ttl: 300000, maxSize: 10000 },
        });
        await cacheManager.getProvider().clear();
    });

    afterEach(async () => {
        await drainPendingCacheOps();
        await tracker.cleanup();
    });

    async function seed(): Promise<string> {
        const e = tracker.create();
        e.add(TestUser, { name: 'cache-seed', email: 'c@e.com', age: 7 });
        await e.save();
        await Entity.drainPendingSideEffects();
        await cacheManager.getProvider().clear();
        return e.id;
    }

    test('miss populates the cache; later reads are served from it', async () => {
        const id = await seed();

        const fresh = await Entity.FindById(id);
        const first = await fresh!.get(TestUser);
        expect(first?.name).toBe('cache-seed');
        await drainPendingCacheOps();

        const [cached] = await cacheManager.getComponents([{ entityId: id, typeId: userTypeId }]);
        expect(cached).not.toBeNull();
        expect((cached as any).data.name).toBe('cache-seed');

        // Change the row behind the cache's back. A cached read must not see it.
        await db`UPDATE components SET data = jsonb_set(data, '{name}', '"db-changed"') WHERE entity_id = ${id}::uuid AND type_id = ${userTypeId}`;

        const again = await Entity.FindById(id);
        const second = await again!.get(TestUser);
        expect(second?.name).toBe('cache-seed');
    });

    test('confirmed absence is tombstoned; a later save overwrites it', async () => {
        const id = await seed();

        const fresh = await Entity.FindById(id);
        expect(await fresh!.get(TestProduct)).toBeNull();
        await drainPendingCacheOps();

        const [cached] = await cacheManager.getComponents([{ entityId: id, typeId: productTypeId }]);
        expect(cached).toBe(COMPONENT_TOMBSTONE);

        // Tombstone hit: no row appears even if inserted behind the cache's back.
        const probe = await Entity.FindById(id);
        expect(await probe!.get(TestProduct)).toBeNull();

        // A real save writes through and replaces the tombstone.
        const writer = await Entity.FindById(id);
        writer!.add(TestProduct, { sku: 'sku-1', name: 'p', price: 1, description: 'd', inStock: true } as any);
        await writer!.save();
        await Entity.drainPendingSideEffects();
        await drainPendingCacheOps();

        const [after] = await cacheManager.getComponents([{ entityId: id, typeId: productTypeId }]);
        expect(after).not.toBe(COMPONENT_TOMBSTONE);

        const reader = await Entity.FindById(id);
        expect(await reader!.get(TestProduct)).not.toBeNull();
    });

    test('inside an explicit transaction the cache is bypassed', async () => {
        const id = await seed();

        // Prime a tombstone for TestProduct.
        const fresh = await Entity.FindById(id);
        expect(await fresh!.get(TestProduct)).toBeNull();
        await drainPendingCacheOps();

        // Insert the row inside a trx and read it back through the same trx:
        // must see the row despite the tombstone (trx reads never consult the
        // cache). Everything stays on the trx connection — PGlite has one.
        await db.begin(async (trx: any) => {
            await trx`INSERT INTO components (id, entity_id, type_id, data, created_at, updated_at)
                      VALUES (gen_random_uuid(), ${id}::uuid, ${productTypeId}, ${{ sku: 's', name: 'trx', price: 2, inStock: true }}, now(), now())`;
            const comp = await loadComponent(fresh!, TestProduct, { trx });
            expect(comp).not.toBeNull();
            expect((comp as any).name).toBe('trx');
        });
    });
});
