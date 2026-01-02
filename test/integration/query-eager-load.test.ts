import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import { Component, CompData, ComponentRegistry, BaseComponent, type ComponentDataType } from "@/core/components";
import db from '../../database';

// Test components
@Component
class EagerTestName extends BaseComponent {
    @CompData()
    firstName!: string;

    @CompData()
    lastName!: string;
}

@Component
class EagerTestEmail extends BaseComponent {
    @CompData()
    email!: string;

    @CompData()
    verified!: boolean;
}

@Component
class EagerTestProfile extends BaseComponent {
    @CompData()
    bio!: string;

    @CompData()
    age!: number;

    @CompData()
    createdAt!: Date;
}

describe('Query eagerLoadComponents() Functionality', () => {
    let testEntityIds: string[] = [];

    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();

        console.log('📝 Setting up test data for eagerLoadComponents tests...');

        // Create test entities with components
        for (let i = 0; i < 10; i++) {
            const entity = Entity.Create();
            
            entity
                .add(EagerTestName, {
                    firstName: `EagerFirst${i}`,
                    lastName: `EagerLast${i}`
                })
                .add(EagerTestEmail, {
                    email: `eager${i}@test.com`,
                    verified: i % 2 === 0
                })
                .add(EagerTestProfile, {
                    bio: `Eager bio for user ${i}`,
                    age: 25 + i,
                    createdAt: new Date()
                });

            await entity.save();
            testEntityIds.push(entity.id);
        }

        console.log(`✅ Created ${testEntityIds.length} test entities for eager loading tests`);
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

    it('should have eagerLoadComponents method available on Query', () => {
        const query = new Query();
        expect(typeof query.eagerLoadComponents).toBe('function');
    });

    it('should have eagerLoad alias method available on Query', () => {
        const query = new Query();
        expect(typeof query.eagerLoad).toBe('function');
    });

    it('should eagerly load specified components after query execution', async () => {
        // Query with eagerLoadComponents
        const entities = await new Query()
            .with(EagerTestName)
            .eagerLoadComponents([EagerTestName])
            .take(5)
            .exec();

        expect(entities.length).toBeGreaterThan(0);

        // Component should already be loaded - no DB query needed
        const firstEntity = entities[0]!;
        const name = await firstEntity.get(EagerTestName);
        
        expect(name).toBeDefined();
        expect(name?.firstName).toMatch(/EagerFirst\d+/);
        expect(name?.lastName).toMatch(/EagerLast\d+/);
    });

    it('should allow chaining eagerLoadComponents with other query methods', async () => {
        const entities = await new Query()
            .with(EagerTestName)
            .with(EagerTestEmail)
            .eagerLoadComponents([EagerTestName, EagerTestEmail])
            .take(3)
            .exec();

        expect(entities.length).toBe(3);

        // Both components should be pre-loaded
        for (const entity of entities) {
            const name = await entity.get(EagerTestName);
            const email = await entity.get(EagerTestEmail);

            expect(name).toBeDefined();
            expect(name?.firstName).toBeDefined();
            expect(email).toBeDefined();
            expect(email?.email).toMatch(/eager\d+@test\.com/);
        }
    });

    it('should eagerly load components not in the with() clause', async () => {
        // Query for entities with EagerTestName, but eagerly load EagerTestProfile
        const entities = await new Query()
            .with(EagerTestName)
            .eagerLoadComponents([EagerTestProfile])
            .take(3)
            .exec();

        expect(entities.length).toBe(3);

        // EagerTestProfile should be pre-loaded even though not in with()
        for (const entity of entities) {
            const profile = await entity.get(EagerTestProfile);
            expect(profile).toBeDefined();
            expect(profile?.bio).toMatch(/Eager bio for user \d+/);
            expect(profile?.age).toBeGreaterThanOrEqual(25);
        }
    });

    it('should work with filters and eagerLoadComponents', async () => {
        const entities = await new Query()
            .with(EagerTestEmail, Query.filters(
                Query.filter('verified', Query.filterOp.EQ, true)
            ))
            .eagerLoadComponents([EagerTestEmail, EagerTestName])
            .exec();

        expect(entities.length).toBeGreaterThan(0);

        // All entities should have verified email and components pre-loaded
        for (const entity of entities) {
            const email = await entity.get(EagerTestEmail);
            expect(email?.verified).toBe(true);

            const name = await entity.get(EagerTestName);
            expect(name).toBeDefined();
        }
    });

    it('should work correctly using eagerLoad alias', async () => {
        const entities = await new Query()
            .with(EagerTestName)
            .eagerLoad([EagerTestName, EagerTestEmail])
            .take(2)
            .exec();

        expect(entities.length).toBe(2);

        for (const entity of entities) {
            const name = await entity.get(EagerTestName);
            const email = await entity.get(EagerTestEmail);

            expect(name).toBeDefined();
            expect(email).toBeDefined();
        }
    });

    it('should throw error when eager loading unregistered component', () => {
        class UnregisteredComponent extends BaseComponent {}
        
        const query = new Query().with(EagerTestName);
        
        expect(() => {
            query.eagerLoadComponents([UnregisteredComponent]);
        }).toThrow(/is not registered/);
    });

    it('should handle empty result set with eagerLoadComponents gracefully', async () => {
        const entities = await new Query()
            .with(EagerTestEmail, Query.filters(
                Query.filter('email', Query.filterOp.EQ, 'nonexistent@test.com')
            ))
            .eagerLoadComponents([EagerTestEmail])
            .exec();

        expect(entities.length).toBe(0);
    });

    it('should combine populate() and eagerLoadComponents() correctly', async () => {
        const entities = await new Query()
            .with(EagerTestName)
            .with(EagerTestEmail)
            .populate()
            .eagerLoadComponents([EagerTestProfile]) // Eager load additional component
            .take(3)
            .exec();

        expect(entities.length).toBe(3);

        // All three components should be available
        for (const entity of entities) {
            const name = await entity.get(EagerTestName);
            const email = await entity.get(EagerTestEmail);
            const profile = await entity.get(EagerTestProfile);

            expect(name).toBeDefined();
            expect(email).toBeDefined();
            expect(profile).toBeDefined();
        }
    });
});

describe('Entity.LoadComponents Performance Fix', () => {
    let testEntityIds: string[] = [];
    const ENTITY_COUNT = 100;

    beforeAll(async () => {
        await ComponentRegistry.ensureComponentsRegistered();
        console.log(`📝 Creating ${ENTITY_COUNT} entities for LoadComponents performance test...`);

        for (let i = 0; i < ENTITY_COUNT; i++) {
            const entity = Entity.Create();
            entity
                .add(EagerTestName, { firstName: `Perf${i}`, lastName: `Test${i}` })
                .add(EagerTestEmail, { email: `perf${i}@test.com`, verified: true });
            await entity.save();
            testEntityIds.push(entity.id);
        }

        console.log(`✅ Created ${ENTITY_COUNT} entities`);
    });

    afterAll(async () => {
        console.log('🧹 Cleaning up performance test data...');
        for (const id of testEntityIds) {
            await db`DELETE FROM entity_components WHERE entity_id = ${id}`;
            await db`DELETE FROM components WHERE entity_id = ${id}`;
            await db`DELETE FROM entities WHERE id = ${id}`;
        }
        console.log('✅ Cleanup complete');
    });

    it('should load components efficiently with O(n) complexity using Map', async () => {
        const entities = await new Query()
            .with(EagerTestName)
            .take(ENTITY_COUNT)
            .exec();

        expect(entities.length).toBe(ENTITY_COUNT);

        // Get component type IDs
        const nameTypeId = new EagerTestName().getTypeID();
        const emailTypeId = new EagerTestEmail().getTypeID();

        // Measure LoadComponents performance
        const startTime = performance.now();
        await Entity.LoadComponents(entities, [nameTypeId, emailTypeId]);
        const endTime = performance.now();

        const duration = endTime - startTime;
        console.log(`LoadComponents for ${ENTITY_COUNT} entities with 2 components: ${duration.toFixed(2)}ms`);

        // Should complete quickly (< 5 seconds for 100 entities)
        expect(duration).toBeLessThan(5000);

        // Verify components were loaded
        for (const entity of entities) {
            const name = await entity.get(EagerTestName);
            const email = await entity.get(EagerTestEmail);
            expect(name).toBeDefined();
            expect(email).toBeDefined();
        }
    });
});

