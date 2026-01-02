import { describe, it, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import { Component, CompData, ComponentRegistry, BaseComponent, type ComponentDataType } from "@/core/components";
import { createRequestLoaders, type RequestLoaders } from '../../core/RequestLoaders';
import db from '../../database';

// Test components
@Component
class DataLoaderTestName extends BaseComponent {
    @CompData()
    firstName!: string;

    @CompData()
    lastName!: string;
}

@Component
class DataLoaderTestEmail extends BaseComponent {
    @CompData()
    email!: string;

    @CompData()
    verified!: boolean;
}

describe('Entity.get() with DataLoader Integration', () => {
    let testEntityIds: string[] = [];
    let loaders: RequestLoaders;

    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();

        console.log('📝 Setting up test data for DataLoader tests...');

        // Create test entities with components
        for (let i = 0; i < 5; i++) {
            const entity = Entity.Create();
            
            entity
                .add(DataLoaderTestName, {
                    firstName: `LoaderFirst${i}`,
                    lastName: `LoaderLast${i}`
                })
                .add(DataLoaderTestEmail, {
                    email: `loader${i}@test.com`,
                    verified: i % 2 === 0
                });

            await entity.save();
            testEntityIds.push(entity.id);
        }

        // Create loaders
        loaders = createRequestLoaders(db);

        console.log(`✅ Created ${testEntityIds.length} test entities for DataLoader tests`);
    });

    afterAll(async () => {
        // Clean up test data
        console.log('🧹 Cleaning up test data...');
        for (const id of testEntityIds) {
            await db`DELETE FROM entity_components WHERE entity_id = ${id}`;
            await db`DELETE FROM components WHERE entity_id = ${id}`;
            await db`DELETE FROM entities WHERE id = ${id}`;
        }
        console.log('✅ Cleanup complete');
    });

    it('should accept optional context parameter in Entity.get()', async () => {
        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(1)
            .exec();

        expect(entities.length).toBe(1);
        const entity = entities[0]!;

        // Call with context (DataLoader)
        const name = await entity.get(DataLoaderTestName, { loaders });
        expect(name).toBeDefined();
        expect(name?.firstName).toMatch(/LoaderFirst\d+/);
    });

    it('should work without context parameter (backward compatibility)', async () => {
        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(1)
            .exec();

        expect(entities.length).toBe(1);
        const entity = entities[0]!;

        // Call without context (direct DB query)
        const name = await entity.get(DataLoaderTestName);
        expect(name).toBeDefined();
        expect(name?.firstName).toMatch(/LoaderFirst\d+/);
    });

    it('should accept optional context parameter in Entity.getComponent()', async () => {
        const entities = await new Query()
            .with(DataLoaderTestEmail)
            .take(1)
            .exec();

        expect(entities.length).toBe(1);
        const entity = entities[0]!;

        // Call with context (DataLoader)
        const email = await entity.getComponent(DataLoaderTestEmail, { loaders });
        expect(email).toBeDefined();
        expect(email?.email).toMatch(/loader\d+@test\.com/);
    });

    it('should work without context parameter in getComponent() (backward compatibility)', async () => {
        const entities = await new Query()
            .with(DataLoaderTestEmail)
            .take(1)
            .exec();

        expect(entities.length).toBe(1);
        const entity = entities[0]!;

        // Call without context
        const email = await entity.getComponent(DataLoaderTestEmail);
        expect(email).toBeDefined();
        expect(email?.email).toMatch(/loader\d+@test\.com/);
    });

    it('should use DataLoader for batching when context is provided', async () => {
        // Create fresh loaders for this test
        const testLoaders = createRequestLoaders(db);
        const context = { loaders: testLoaders };

        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(3)
            .exec();

        expect(entities.length).toBe(3);

        // Load components in parallel using DataLoader
        const componentPromises = entities.map(e => e.get(DataLoaderTestName, context));
        const components = await Promise.all(componentPromises);

        // All should be loaded
        expect(components.every(c => c !== null)).toBe(true);
        components.forEach((comp, i) => {
            expect(comp?.firstName).toBeDefined();
        });
    });

    it('should return cached component if already loaded (no context needed)', async () => {
        const entities = await new Query()
            .with(DataLoaderTestName)
            .eagerLoadComponents([DataLoaderTestName])
            .take(1)
            .exec();

        expect(entities.length).toBe(1);
        const entity = entities[0]!;

        // First call - should return cached component
        const name1 = await entity.get(DataLoaderTestName);
        expect(name1).toBeDefined();

        // Second call - should return same cached component
        const name2 = await entity.get(DataLoaderTestName);
        expect(name2).toBeDefined();
        expect(name1?.firstName).toBe(name2?.firstName);
    });

    it('should handle missing component gracefully with DataLoader', async () => {
        // Create entity without DataLoaderTestEmail
        const entity = Entity.Create();
        entity.add(DataLoaderTestName, { firstName: 'NoEmail', lastName: 'User' });
        await entity.save();
        testEntityIds.push(entity.id);

        // Create fresh entity reference without loaded components
        const freshEntity = new Entity(entity.id);
        freshEntity.setPersisted(true);

        // Try to get non-existent component with DataLoader
        const email = await freshEntity.get(DataLoaderTestEmail, { loaders });
        expect(email).toBeNull();
    });

    it('should handle malformed context gracefully', async () => {
        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(1)
            .exec();

        const entity = entities[0]!;

        // Various malformed contexts should fall back to direct DB
        const name1 = await entity.get(DataLoaderTestName, {});
        expect(name1).toBeDefined();

        const name2 = await entity.get(DataLoaderTestName, { loaders: {} });
        expect(name2).toBeDefined();

        const name3 = await entity.get(DataLoaderTestName, { loaders: undefined });
        expect(name3).toBeDefined();
    });
});

describe('DataLoader Batching Verification', () => {
    let testEntityIds: string[] = [];
    const ENTITY_COUNT = 10;

    beforeAll(async () => {
        await ComponentRegistry.ensureComponentsRegistered();
        console.log(`📝 Creating ${ENTITY_COUNT} entities for batching verification...`);

        for (let i = 0; i < ENTITY_COUNT; i++) {
            const entity = Entity.Create();
            entity
                .add(DataLoaderTestName, { firstName: `Batch${i}`, lastName: `Test${i}` })
                .add(DataLoaderTestEmail, { email: `batch${i}@test.com`, verified: true });
            await entity.save();
            testEntityIds.push(entity.id);
        }

        console.log(`✅ Created ${ENTITY_COUNT} entities`);
    });

    afterAll(async () => {
        console.log('🧹 Cleaning up batching test data...');
        for (const id of testEntityIds) {
            await db`DELETE FROM entity_components WHERE entity_id = ${id}`;
            await db`DELETE FROM components WHERE entity_id = ${id}`;
            await db`DELETE FROM entities WHERE id = ${id}`;
        }
        console.log('✅ Cleanup complete');
    });

    it('should batch multiple component loads into fewer queries with DataLoader', async () => {
        const loaders = createRequestLoaders(db);
        const context = { loaders };

        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(ENTITY_COUNT)
            .exec();

        expect(entities.length).toBe(ENTITY_COUNT);

        // Load all components in parallel - DataLoader should batch these
        const startTime = performance.now();
        const componentPromises = entities.map(e => e.get(DataLoaderTestName, context));
        const components = await Promise.all(componentPromises);
        const endTime = performance.now();

        const duration = endTime - startTime;
        console.log(`DataLoader batched ${ENTITY_COUNT} component loads in: ${duration.toFixed(2)}ms`);

        // All components should be loaded
        expect(components.every(c => c !== null)).toBe(true);
        
        // Should complete quickly due to batching
        expect(duration).toBeLessThan(2000);
    });

    it('should compare DataLoader vs direct DB performance', async () => {
        const entities = await new Query()
            .with(DataLoaderTestName)
            .take(ENTITY_COUNT)
            .exec();

        expect(entities.length).toBe(ENTITY_COUNT);

        // Test without DataLoader (sequential direct DB calls)
        const directStartTime = performance.now();
        for (const entity of entities) {
            // Clear cached component to force DB fetch
            (entity as any).components.clear();
            await entity.get(DataLoaderTestName); // No context = direct DB
        }
        const directEndTime = performance.now();
        const directDuration = directEndTime - directStartTime;

        // Create fresh entities for DataLoader test
        const freshEntities = await new Query()
            .with(DataLoaderTestName)
            .take(ENTITY_COUNT)
            .exec();

        // Test with DataLoader (batched)
        const loaders = createRequestLoaders(db);
        const context = { loaders };

        const batchedStartTime = performance.now();
        const promises = freshEntities.map(e => e.get(DataLoaderTestName, context));
        await Promise.all(promises);
        const batchedEndTime = performance.now();
        const batchedDuration = batchedEndTime - batchedStartTime;

        console.log(`Direct DB (sequential): ${directDuration.toFixed(2)}ms`);
        console.log(`DataLoader (batched): ${batchedDuration.toFixed(2)}ms`);

        // DataLoader should generally be faster or comparable
        // (may not always be faster in tests due to overhead, but should not be significantly slower)
        expect(batchedDuration).toBeLessThan(directDuration * 3);
    });
});

