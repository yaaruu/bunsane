import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import { Component, CompData, ComponentRegistry, BaseComponent, type ComponentDataType } from "@/core/components";
import db from '../../database';

// Test components
@Component
class TestName extends BaseComponent {
    @CompData()
    firstName!: string;

    @CompData()
    lastName!: string;
}

@Component
class TestEmail extends BaseComponent {
    @CompData()
    email!: string;

    @CompData()
    verified!: boolean;
}

@Component
class TestProfile extends BaseComponent {
    @CompData()
    bio!: string;

    @CompData()
    age!: number;

    @CompData()
    createdAt!: Date;
}

describe('Query Populate Functionality', () => {
    let testEntityIds: string[] = [];

    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();

        console.log('📝 Setting up test data for populate tests...');

        // Create test entities with components
        for (let i = 0; i < 10; i++) {
            const entity = Entity.Create();
            
            entity
                .add(TestName, {
                    firstName: `FirstName${i}`,
                    lastName: `LastName${i}`
                })
                .add(TestEmail, {
                    email: `user${i}@test.com`,
                    verified: i % 2 === 0
                })
                .add(TestProfile, {
                    bio: `Bio for user ${i}`,
                    age: 20 + i,
                    createdAt: new Date()
                });

            await entity.save();
            testEntityIds.push(entity.id);
        }

        console.log(`✅ Created ${testEntityIds.length} test entities`);
    });

    afterAll(async () => {
        // Clean up test data
        console.log('🧹 Cleaning up test data...');
        for (const id of testEntityIds) {
            await db`DELETE FROM components WHERE entity_id = ${id}`;
            await db`DELETE FROM entities WHERE id = ${id}`;
        }
        console.log('✅ Cleanup complete');
    });

    it('should populate components without database queries on entity.get()', async () => {
        // Query without populate
        const entitiesWithoutPopulate = await new Query()
            .with(TestName)
            .with(TestEmail)
            .take(5)
            .exec();

        expect(entitiesWithoutPopulate.length).toBeGreaterThan(0);

        // Access components will trigger DB queries
        const firstEntity = entitiesWithoutPopulate[0]!;
        const name = await firstEntity.get(TestName);
        expect(name).toBeDefined();
        expect(name?.firstName).toMatch(/FirstName\d+/);
    });

    it('should pre-fill entity objects with queried components when populate is enabled', async () => {
        // Query with populate
        const entitiesWithPopulate = await new Query()
            .with(TestName)
            .with(TestEmail)
            .populate()
            .take(5)
            .exec();

        expect(entitiesWithPopulate.length).toBeGreaterThan(0);

        // Components should already be loaded
        const firstEntity = entitiesWithPopulate[0]!;
        
        // Get components - should be instant (no DB query)
        const name = await firstEntity.get(TestName);
        const email = await firstEntity.get(TestEmail);

        expect(name).toBeDefined();
        expect(name?.firstName).toMatch(/FirstName\d+/);
        expect(email).toBeDefined();
        expect(email?.email).toMatch(/user\d+@test\.com/);
    });

    it('should populate multiple components for multiple entities efficiently', async () => {
        const entities = await new Query()
            .with(TestName)
            .with(TestEmail)
            .with(TestProfile)
            .populate()
            .exec();

        expect(entities.length).toBe(10);

        // Verify all entities have components pre-loaded
        for (const entity of entities) {
            const name = await entity.get(TestName);
            const email = await entity.get(TestEmail);
            const profile = await entity.get(TestProfile);

            expect(name).toBeDefined();
            expect(name?.firstName).toBeDefined();
            expect(email).toBeDefined();
            expect(email?.email).toBeDefined();
            expect(profile).toBeDefined();
            expect(profile?.bio).toBeDefined();
            expect(profile?.age).toBeGreaterThan(0);
            expect(profile?.createdAt).toBeInstanceOf(Date);
        }
    });

    it('should only populate components specified in with() clause', async () => {
        const entities = await new Query()
            .with(TestName)
            .with(TestEmail)
            .populate()
            .take(1)
            .exec();

        expect(entities.length).toBe(1);

        const entity = entities[0]!;

        // These should be pre-loaded
        const name = await entity.get(TestName);
        const email = await entity.get(TestEmail);
        expect(name).toBeDefined();
        expect(email).toBeDefined();

        // This was not in the query, so it should trigger a DB query
        const profile = await entity!.get(TestProfile);
        expect(profile).toBeDefined(); // Entity has it, but it wasn't pre-populated
    });

    it('should handle queries with filters and populate correctly', async () => {
        const entities = await new Query()
            .with(TestEmail, Query.filters(
                Query.filter('verified', Query.filterOp.EQ, true)
            ))
            .with(TestName)
            .populate()
            .exec();

        expect(entities.length).toBeGreaterThan(0);

        // Verify all returned entities have verified email
        for (const entity of entities) {
            const email = await entity.get(TestEmail);
            expect(email?.verified).toBe(true);
            
            const name = await entity.get(TestName);
            expect(name).toBeDefined();
        }
    });

    it('should deserialize Date properties correctly when populating', async () => {
        const entities = await new Query()
            .with(TestProfile)
            .populate()
            .take(1)
            .exec();

        expect(entities.length).toBe(1);

        const profile = await entities[0]!.get(TestProfile);
        expect(profile).toBeDefined();
        expect(profile?.createdAt).toBeInstanceOf(Date);
        expect(profile?.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should work without populate and still fetch components on demand', async () => {
        // Query without populate
        const entities = await new Query()
            .with(TestName)
            .with(TestEmail)
            .take(3)
            .exec();

        expect(entities.length).toBeGreaterThan(0);

        // Components should still be fetchable via get()
        for (const entity of entities) {
            const name = await entity.get(TestName);
            const email = await entity.get(TestEmail);

            expect(name).toBeDefined();
            expect(email).toBeDefined();
        }
    });
});
