/**
 * Integration tests for Entity persistence
 * Tests entity CRUD operations with the database
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { Query } from '../../../query/Query';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('Entity Persistence', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('save()', () => {
        test('persists new entity to database', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'John Doe', email: 'john@example.com', age: 30 });

            await entity.save();

            expect(entity._persisted).toBe(true);
            expect((entity as any)._dirty).toBe(false);
        });

        test('persists multiple components', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Jane', email: 'jane@example.com', age: 25 });
            entity.add(TestProduct, { sku: 'SKU001', name: 'Test Product', price: 49.99, inStock: true });

            await entity.save();

            expect(entity._persisted).toBe(true);
        });

        test('updates existing entity', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Original', email: 'original@example.com', age: 20 });
            await entity.save();

            // Update the entity
            await entity.set(TestUser, { name: 'Updated', age: 21 });
            await entity.save();

            // Verify update by loading from database using Query with component
            const results = await new Query().findById(entity.id).with(TestUser).exec();
            const loaded = results[0];
            const user = await loaded?.get(TestUser);
            expect(user?.name).toBe('Updated');
            expect(user?.age).toBe(21);
        });

        test('saves entity with Date field', async () => {
            const date = new Date('2024-06-15T10:30:00Z');
            const entity = ctx.tracker.create();
            entity.add(TestOrder, {
                orderNumber: 'ORD-001',
                total: 150.00,
                status: 'pending',
                createdAt: date
            });

            await entity.save();

            // Load with Query specifying component
            const results = await new Query().findById(entity.id).with(TestOrder).exec();
            const loaded = results[0];
            const order = await loaded?.get(TestOrder);
            expect(order?.createdAt.toISOString()).toBe(date.toISOString());
        });
    });

    describe('FindById()', () => {
        test('loads entity by ID', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'FindMe', email: 'findme@example.com', age: 40 });
            await entity.save();

            const loaded = await Entity.FindById(entity.id);

            expect(loaded).not.toBeNull();
            expect(loaded?.id).toBe(entity.id);
        });

        test('returns null for non-existent ID', async () => {
            const loaded = await Entity.FindById('00000000-0000-0000-0000-000000000000');
            expect(loaded).toBeNull();
        });

        test('loads entity and components can be fetched via get()', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Multi', email: 'multi@example.com', age: 30 });
            entity.add(TestProduct, { sku: 'MULTI', name: 'Multi Product', price: 10, inStock: true });
            await entity.save();

            const loaded = await Entity.FindById(entity.id);

            // Use get() to load components from database
            const userData = await loaded?.get(TestUser);
            const productData = await loaded?.get(TestProduct);
            expect(userData).toBeDefined();
            expect(productData).toBeDefined();
        });

        test('returns null for empty string ID', async () => {
            const loaded = await Entity.FindById('');
            expect(loaded).toBeNull();
        });
    });

    describe('Query with components', () => {
        test('loads entity with components into memory', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'QueryLoad', email: 'queryload@example.com', age: 35 });
            await entity.save();

            // Use Query with .with() and .populate() to load component into memory
            const results = await new Query().findById(entity.id).with(TestUser).populate().exec();
            const loaded = results[0];

            // After Query.with().populate(), component should be in memory
            expect(loaded?.hasInMemory(TestUser)).toBe(true);
            const userData = loaded?.getInMemory(TestUser);
            expect(userData?.name).toBe('QueryLoad');
        });

        test('loads multiple components into memory', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'MultiQuery', email: 'multiquery@example.com', age: 25 });
            entity.add(TestProduct, { sku: 'MQ001', name: 'Multi Query Product', price: 99.99, inStock: true });
            await entity.save();

            const results = await new Query()
                .findById(entity.id)
                .with(TestUser)
                .with(TestProduct)
                .populate()
                .exec();
            const loaded = results[0];

            expect(loaded?.hasInMemory(TestUser)).toBe(true);
            expect(loaded?.hasInMemory(TestProduct)).toBe(true);
        });
    });

    describe('delete()', () => {
        test('soft deletes entity', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'ToDelete', email: 'delete@example.com', age: 25 });
            await entity.save();

            await entity.delete();

            const loaded = await Entity.FindById(entity.id);
            expect(loaded).toBeNull();
        });

        test('hard deletes entity with force flag', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'HardDelete', email: 'hard@example.com', age: 30 });
            await entity.save();

            await entity.delete(true);

            const loaded = await Entity.FindById(entity.id);
            expect(loaded).toBeNull();
        });

        test('returns false for non-persisted entity', async () => {
            const entity = new Entity();
            const result = await entity.delete();
            expect(result).toBe(false);
        });
    });

    describe('get()', () => {
        test('loads component from database', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'LoadTest', email: 'load@example.com', age: 35 });
            await entity.save();

            // Create a fresh entity with same ID to simulate loading
            const freshEntity = new Entity(entity.id);
            freshEntity.setPersisted(true);
            ctx.tracker.track(freshEntity);

            const userData = await freshEntity.get(TestUser);

            expect(userData).not.toBeNull();
            expect(userData?.name).toBe('LoadTest');
            expect(userData?.email).toBe('load@example.com');
        });

        test('returns null for non-existent component', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'NoProduct', email: 'noproduct@example.com', age: 20 });
            await entity.save();

            const productData = await entity.get(TestProduct);
            expect(productData).toBeNull();
        });

        test('caches component after loading', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'CacheTest', email: 'cache@example.com', age: 30 });
            await entity.save();

            const freshEntity = new Entity(entity.id);
            freshEntity.setPersisted(true);
            ctx.tracker.track(freshEntity);

            // First call loads from DB
            await freshEntity.get(TestUser);
            // Second call should use cache
            expect(freshEntity.hasInMemory(TestUser)).toBe(true);
        });
    });

    describe('getInstanceOf()', () => {
        test('returns component instance', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Instance', email: 'instance@example.com', age: 28 });
            await entity.save();

            const user = await entity.getInstanceOf(TestUser);

            expect(user).not.toBeNull();
            expect(user).toBeInstanceOf(TestUser);
            expect(user?.name).toBe('Instance');
        });
    });

    describe('LoadMultiple()', () => {
        test('loads multiple entities at once', async () => {
            const entity1 = ctx.tracker.create();
            entity1.add(TestUser, { name: 'User1', email: 'user1@example.com', age: 20 });
            await entity1.save();

            const entity2 = ctx.tracker.create();
            entity2.add(TestUser, { name: 'User2', email: 'user2@example.com', age: 25 });
            await entity2.save();

            const loaded = await Entity.LoadMultiple([entity1.id, entity2.id]);

            expect(loaded.length).toBe(2);
        });

        test('returns empty array for empty input', async () => {
            const loaded = await Entity.LoadMultiple([]);
            expect(loaded).toEqual([]);
        });

        test('filters out invalid IDs', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Valid', email: 'valid@example.com', age: 30 });
            await entity.save();

            const loaded = await Entity.LoadMultiple([entity.id, '', '  ']);
            expect(loaded.length).toBe(1);
        });
    });

    describe('Clone()', () => {
        test('creates deep clone of entity', async () => {
            const original = ctx.tracker.create();
            original.add(TestUser, { name: 'Original', email: 'original@example.com', age: 30 });
            await original.save();

            const clone = Entity.Clone(original);
            ctx.tracker.track(clone);

            expect(clone.id).not.toBe(original.id);
            expect(clone._persisted).toBe(false);
            expect(clone.getInMemory(TestUser)?.name).toBe('Original');
        });

        test('cloned entity can be saved independently', async () => {
            const original = ctx.tracker.create();
            original.add(TestUser, { name: 'ToClone', email: 'clone@example.com', age: 25 });
            await original.save();

            const clone = Entity.Clone(original);
            ctx.tracker.track(clone);
            await clone.save();

            expect(clone._persisted).toBe(true);

            const loadedClone = await Entity.FindById(clone.id);
            expect(loadedClone).not.toBeNull();
        });
    });

    describe('component removal', () => {
        test('remove() deletes component on save', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Remove', email: 'remove@example.com', age: 30 });
            entity.add(TestProduct, { sku: 'REM', name: 'Remove Product', price: 10, inStock: true });
            await entity.save();

            entity.remove(TestProduct);
            await entity.save();

            // Load entity - only query with TestUser since TestProduct was removed
            // If we query with both, the entity won't be returned (requires both components)
            const results = await new Query().findById(entity.id).with(TestUser).populate().exec();
            const loaded = results[0];

            expect(loaded).toBeDefined();
            expect(loaded?.hasInMemory(TestUser)).toBe(true);

            // Verify TestProduct was actually removed from database
            const productData = await loaded?.get(TestProduct);
            expect(productData).toBeNull();
        });
    });

    describe('serialize / deserialize roundtrip', () => {
        test('entity can be serialized and deserialized', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Serialize', email: 'serialize@example.com', age: 35 });
            await entity.save();

            const serialized = entity.serialize();
            const deserialized = Entity.deserialize(serialized);

            expect(deserialized.id).toBe(entity.id);
            expect(deserialized.getInMemory(TestUser)?.name).toBe('Serialize');
        });
    });
});
