#!/usr/bin/env bun

/**
 * End-to-end integration test for component cache with DataLoader
 * 
 * Tests the complete flow:
 * - Query → Entity → Component resolution via DataLoader → Cache
 * - Entity.save() writes to cache in ComponentData format
 * - DataLoader reads from cache and returns correct data
 * - Cache invalidation properly clears component data
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../core/Entity';
import { BaseArcheType, ArcheTypeField } from '../../core/ArcheType';
import { CacheManager } from '../../core/cache/CacheManager';
import { createRequestLoaders, type ComponentData } from '../../core/RequestLoaders';
import { Component, CompData, BaseComponent, ComponentRegistry } from '../../core/components';
import db from '../../database';

// Test components
@Component
class CacheTestProfile extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    email!: string;
}

@Component
class CacheTestSettings extends BaseComponent {
    @CompData()
    theme!: string;

    @CompData()
    notifications!: boolean;
}

// Test archetype
class CacheTestArcheType extends BaseArcheType {
    @ArcheTypeField(CacheTestProfile)
    profile!: CacheTestProfile;

    @ArcheTypeField(CacheTestSettings)
    settings!: CacheTestSettings;
}

const testArcheType = new CacheTestArcheType();

describe('Cache + DataLoader Integration', () => {
    let cacheManager: CacheManager;
    let entity: Entity;
    let loaders: ReturnType<typeof createRequestLoaders>;

    beforeAll(async () => {
        // Ensure components are registered first (creates partition tables)
        await ComponentRegistry.ensureComponentsRegistered();
        
        // Initialize cache manager with memory provider
        cacheManager = CacheManager.getInstance();
        cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            entity: { enabled: false, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            defaultTTL: 3600000
        });

        // Clear any existing cache
        await cacheManager.getProvider().clear();
    });

    beforeEach(async () => {
        // Create fresh loaders for each test (request-scoped in real app)
        loaders = createRequestLoaders(db, cacheManager);
        
        // Clear cache before each test
        await cacheManager.getProvider().clear();
    });

    afterAll(async () => {
        // Clean up test entity
        if (entity) {
            try {
                await entity.delete();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    test('Entity.save() should write component data to cache in correct format', async () => {
        // Create and save entity with components
        entity = testArcheType.createEntity();
        await entity.set(CacheTestProfile, { name: 'Cache Test', email: 'cache@test.com' });
        await entity.set(CacheTestSettings, { theme: 'dark', notifications: true });
        await entity.save();

        // Wait for async cache operations to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Directly check cache for component data
        const profileTypeId = new CacheTestProfile().getTypeID();
        const cacheKey = `component:${entity.id}:${profileTypeId}`;
        const cachedData = await cacheManager.getProvider().get<ComponentData>(cacheKey);

        // Verify cache data structure matches ComponentData format
        expect(cachedData).toBeDefined();
        if (cachedData) {
            expect(cachedData.entityId).toBe(entity.id);
            expect(cachedData.typeId).toBe(profileTypeId);
            expect(cachedData.data).toBeDefined();
            expect(cachedData.data.name).toBe('Cache Test');
            expect(cachedData.data.email).toBe('cache@test.com');
            expect(cachedData.id).toBeDefined();
            expect(cachedData.createdAt).toBeDefined();
            expect(cachedData.updatedAt).toBeDefined();
            expect(cachedData.deletedAt).toBeNull();
        }
    });

    test('DataLoader should read component from cache on cache hit', async () => {
        // Create and save entity
        entity = testArcheType.createEntity();
        await entity.set(CacheTestProfile, { name: 'Loader Test', email: 'loader@test.com' });
        await entity.save();

        // Wait for cache write
        await new Promise(resolve => setTimeout(resolve, 100));

        // Use DataLoader to fetch component - should hit cache
        const profileTypeId = new CacheTestProfile().getTypeID();
        const result = await loaders.componentsByEntityType.load({
            entityId: entity.id,
            typeId: profileTypeId
        });

        expect(result).toBeDefined();
        if (result) {
            expect(result.entityId).toBe(entity.id);
            expect(result.data.name).toBe('Loader Test');
            expect(result.data.email).toBe('loader@test.com');
        }
    });

    test('Cache invalidation should cause DataLoader to fetch from database', async () => {
        // Create and save entity
        entity = testArcheType.createEntity();
        await entity.set(CacheTestProfile, { name: 'Invalidate Test', email: 'invalidate@test.com' });
        await entity.save();

        // Wait for cache write
        await new Promise(resolve => setTimeout(resolve, 100));

        const profileTypeId = new CacheTestProfile().getTypeID();

        // Verify data is in cache
        const cacheKey = `component:${entity.id}:${profileTypeId}`;
        const beforeInvalidation = await cacheManager.getProvider().get<ComponentData>(cacheKey);
        expect(beforeInvalidation).toBeDefined();

        // Invalidate the cache
        await cacheManager.invalidateComponent(entity.id, profileTypeId);

        // Verify cache is cleared
        const afterInvalidation = await cacheManager.getProvider().get<ComponentData>(cacheKey);
        expect(afterInvalidation).toBeNull();

        // DataLoader should now fetch from database (fresh loaders to avoid DataLoader's own cache)
        const freshLoaders = createRequestLoaders(db, cacheManager);
        const result = await freshLoaders.componentsByEntityType.load({
            entityId: entity.id,
            typeId: profileTypeId
        });

        // Should still get data (from DB) and re-populate cache
        expect(result).toBeDefined();
        if (result) {
            expect(result.data.name).toBe('Invalidate Test');
        }
    });

    test('Component update should invalidate old cache and write new data', async () => {
        // Create and save entity
        entity = testArcheType.createEntity();
        await entity.set(CacheTestProfile, { name: 'Original', email: 'original@test.com' });
        await entity.save();

        const profileTypeId = new CacheTestProfile().getTypeID();
        const cacheKey = `component:${entity.id}:${profileTypeId}`;

        // Poll for cache write completion (setImmediate + async operations can take time)
        const waitForCache = async (expectedName: string, timeoutMs: number = 2000) => {
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                const data = await cacheManager.getProvider().get<ComponentData>(cacheKey);
                if (data?.data?.name === expectedName) {
                    return data;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return await cacheManager.getProvider().get<ComponentData>(cacheKey);
        };

        // Verify original data in cache (poll until available)
        let cachedData = await waitForCache('Original');
        expect(cachedData?.data.name).toBe('Original');

        // Update component
        await entity.set(CacheTestProfile, { name: 'Updated', email: 'updated@test.com' });
        await entity.save();

        // Wait for cache update (poll until available)
        cachedData = await waitForCache('Updated');

        // Verify updated data in cache
        expect(cachedData?.data.name).toBe('Updated');
        expect(cachedData?.data.email).toBe('updated@test.com');
    });

    test('invalidateAllEntityComponents should clear all component caches for entity', async () => {
        // Create and save entity with multiple components
        entity = testArcheType.createEntity();
        await entity.set(CacheTestProfile, { name: 'Multi Test', email: 'multi@test.com' });
        await entity.set(CacheTestSettings, { theme: 'light', notifications: false });
        await entity.save();

        // Wait for cache write
        await new Promise(resolve => setTimeout(resolve, 100));

        const profileTypeId = new CacheTestProfile().getTypeID();
        const settingsTypeId = new CacheTestSettings().getTypeID();

        // Verify both components are in cache
        const profileKey = `component:${entity.id}:${profileTypeId}`;
        const settingsKey = `component:${entity.id}:${settingsTypeId}`;

        let profileCache = await cacheManager.getProvider().get<ComponentData>(profileKey);
        let settingsCache = await cacheManager.getProvider().get<ComponentData>(settingsKey);

        expect(profileCache).toBeDefined();
        expect(settingsCache).toBeDefined();

        // Invalidate all components for entity
        await cacheManager.invalidateAllEntityComponents(entity.id);

        // Verify both caches are cleared
        profileCache = await cacheManager.getProvider().get<ComponentData>(profileKey);
        settingsCache = await cacheManager.getProvider().get<ComponentData>(settingsKey);

        expect(profileCache).toBeNull();
        expect(settingsCache).toBeNull();
    });

    test('DataLoader batching should work with cache', async () => {
        // Create multiple entities
        const entity1 = testArcheType.createEntity();
        await entity1.set(CacheTestProfile, { name: 'Batch 1', email: 'batch1@test.com' });
        await entity1.save();

        const entity2 = testArcheType.createEntity();
        await entity2.set(CacheTestProfile, { name: 'Batch 2', email: 'batch2@test.com' });
        await entity2.save();

        // Wait for cache writes
        await new Promise(resolve => setTimeout(resolve, 100));

        const profileTypeId = new CacheTestProfile().getTypeID();

        // Batch load both components
        const [result1, result2] = await Promise.all([
            loaders.componentsByEntityType.load({ entityId: entity1.id, typeId: profileTypeId }),
            loaders.componentsByEntityType.load({ entityId: entity2.id, typeId: profileTypeId })
        ]);

        expect(result1?.data.name).toBe('Batch 1');
        expect(result2?.data.name).toBe('Batch 2');

        // Cleanup
        await entity1.delete();
        await entity2.delete();
    });
});
