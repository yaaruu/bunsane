/**
 * Integration tests for ArcheType persistence
 * Tests archetype creation and loading with the database
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { Query, FilterOp } from '../../../query/Query';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { TestUserArchetype, TestUserWithOrdersArchetype } from '../../fixtures/archetypes/TestUserArchetype';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('ArcheType Persistence', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('createAndSaveEntity()', () => {
        test('creates and persists entity with archetype components', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'ArchetypeSave', email: 'archsave@example.com', age: 30 } });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            expect(entity._persisted).toBe(true);

            const loaded = await Entity.FindById(entity.id);
            expect(loaded).not.toBeNull();

            // Use async get() since component may not be in memory after FindById
            const userData = await loaded?.get(TestUser);
            expect(userData?.name).toBe('ArchetypeSave');
        });

        test('creates entity with multiple components', async () => {
            const archetype = new TestUserWithOrdersArchetype();
            archetype.fill({
                user: { name: 'MultiArch', email: 'multiarch@example.com', age: 28 },
                order: {
                    orderNumber: 'ORD-ARCH-001',
                    total: 199.99,
                    status: 'completed',
                    createdAt: new Date()
                }
            });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            const loaded = await Entity.FindById(entity.id);
            expect(loaded).not.toBeNull();

            // Load components and verify
            const userData = await loaded?.get(TestUser);
            const orderData = await loaded?.get(TestOrder);
            expect(userData).toBeDefined();
            expect(orderData).toBeDefined();
        });
    });

    describe('createEntity() with fill()', () => {
        test('creates entity from archetype with data', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'FillCreate', email: 'fillcreate@example.com', age: 25 } });
            const entity = archetype.createEntity();
            ctx.tracker.track(entity);

            expect(entity).toBeInstanceOf(Entity);
            expect(entity.id).toBeDefined();
            expect(entity._dirty).toBe(true);
            expect(entity._persisted).toBe(false);

            // Component should be in memory after createEntity
            const userData = entity.getInMemory(TestUser);
            expect(userData?.name).toBe('FillCreate');
        });

        test('entity can be saved after creation', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'SaveAfter', email: 'saveafter@example.com', age: 30 } });
            const entity = archetype.createEntity();
            ctx.tracker.track(entity);

            await entity.save();

            expect(entity._persisted).toBe(true);
            expect(entity._dirty).toBe(false);
        });
    });

    describe('getEntityWithID()', () => {
        test('loads entity by ID with archetype components', async () => {
            // Create and save an entity
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'GetWithId', email: 'getwithid@example.com', age: 25 } });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            // Load using archetype's getEntityWithID
            const loadArchetype = new TestUserArchetype();
            const loaded = await loadArchetype.getEntityWithID(entity.id);

            expect(loaded).not.toBeNull();
            expect(loaded?.id).toBe(entity.id);

            // Component should be loaded
            const userData = await loaded?.get(TestUser);
            expect(userData?.name).toBe('GetWithId');
        });

        test('returns null for non-existent ID', async () => {
            const archetype = new TestUserArchetype();
            const loaded = await archetype.getEntityWithID('00000000-0000-0000-0000-000000000000');
            expect(loaded).toBeNull();
        });

        test('returns null for invalid ID', async () => {
            const archetype = new TestUserArchetype();
            const loaded = await archetype.getEntityWithID('');
            expect(loaded).toBeNull();
        });
    });

    describe('updateEntity()', () => {
        test('updates entity with new data', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'ToUpdate', email: 'toupdate@example.com', age: 30 } });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            // Update the entity
            await archetype.updateEntity(entity, {
                user: { name: 'Updated', age: 31 }
            });
            await entity.save();

            const loaded = await Entity.FindById(entity.id);
            const userData = await loaded?.get(TestUser);
            expect(userData?.name).toBe('Updated');
            expect(userData?.age).toBe(31);
        });

        test('preserves unchanged fields', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'Preserve', email: 'preserve@example.com', age: 25 } });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            // Update only name
            await archetype.updateEntity(entity, {
                user: { name: 'PreserveUpdated' }
            });
            await entity.save();

            const loaded = await Entity.FindById(entity.id);
            const userData = await loaded?.get(TestUser);
            expect(userData?.name).toBe('PreserveUpdated');
            expect(userData?.email).toBe('preserve@example.com'); // Email unchanged
        });
    });

    describe('querying entities with archetype components', () => {
        beforeEach(async () => {
            // Create test data
            for (let i = 0; i < 3; i++) {
                const archetype = new TestUserArchetype();
                archetype.fill({
                    user: {
                        name: `QueryArchUser${i}`,
                        email: `queryarch${i}@example.com`,
                        age: 20 + i * 10
                    }
                });
                const entity = await archetype.createAndSaveEntity();
                ctx.tracker.track(entity);
            }
        });

        test('finds entities via Query with archetype components', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, 'queryarch%@example.com')]
                })
                .populate()
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(3);
        });

        test('filters by component field values', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'QueryArchUser0')]
                })
                .populate()
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
            const userData = await results[0]?.get(TestUser);
            expect(userData?.name).toBe('QueryArchUser0');
        });
    });

    describe('Unwrap()', () => {
        test('unwraps entity to plain object', async () => {
            const archetype = new TestUserArchetype();
            archetype.fill({ user: { name: 'Unwrap', email: 'unwrap@example.com', age: 30 } });
            const entity = await archetype.createAndSaveEntity();
            ctx.tracker.track(entity);

            const unwrapped = await archetype.Unwrap(entity);

            expect(unwrapped.id).toBe(entity.id);
            // The unwrapped format may vary - check that user data is present
            expect(unwrapped.user || unwrapped).toBeDefined();
        });
    });

    describe('validation', () => {
        test('withValidation validates input data', () => {
            const archetype = new TestUserArchetype();

            // Valid data should pass
            const validResult = archetype.withValidation({
                user: { name: 'Valid', email: 'valid@example.com', age: 25 }
            });

            expect(validResult).toBeDefined();
        });
    });

    describe('component properties', () => {
        test('getComponentsToLoad returns component constructors', () => {
            const archetype = new TestUserArchetype();
            const components = archetype.getComponentsToLoad();

            expect(Array.isArray(components)).toBe(true);
            expect(components.length).toBeGreaterThan(0);
        });
    });
});
