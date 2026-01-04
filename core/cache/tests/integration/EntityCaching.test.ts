import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../../Entity';
import { CacheManager } from '../../CacheManager';
import { logger } from '../../../Logger';
import db from '../../../../database';
import { Component, CompData, BaseComponent, ComponentRegistry } from '../../../components';
import EntityManager from '../../../EntityManager';

// Test component
@Component
class TestComponent extends BaseComponent {
    @CompData()
    value!: string;
}

describe('Entity Caching Integration', () => {
    let cacheManager: CacheManager;
    let originalConfig: any;

    beforeEach(async () => {
        // Set database ready for testing
        (EntityManager as any).dbReady = true;

        // Initialize cache with memory provider for testing
        cacheManager = CacheManager.getInstance();
        originalConfig = cacheManager.getConfig();
        cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            query: { enabled: false, ttl: 300000 }
        });

        // Clear any existing data
        await cacheManager.getProvider().clear();
    });

    afterEach(async () => {
        // Restore original config
        cacheManager.initialize(originalConfig);
        await cacheManager.getProvider().clear();
    });

    describe('Entity Save Caching', () => {
        it('should cache entity existence on save with write-through strategy', async () => {
            const entity = new Entity();
            entity.add(TestComponent, { value: 'test' });

            const saved = await entity.save();
            expect(saved).toBe(true);

            // Check if entity existence is cached (returns ID if exists)
            const cachedEntityId = await cacheManager.getEntity(entity.id);
            expect(cachedEntityId).toBe(entity.id);
        });

        it('should invalidate entity cache with write-invalidate strategy', async () => {
            // Switch to write-invalidate
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-invalidate'
            });

            const entity = new Entity();
            entity.add(TestComponent, { value: 'test' });

            // Pre-cache the entity
            await cacheManager.setEntityWriteThrough(entity);

            const saved = await entity.save();
            expect(saved).toBe(true);

            // Check if entity cache was invalidated (should return null)
            const cachedEntityId = await cacheManager.getEntity(entity.id);
            expect(cachedEntityId).toBeNull();
        });
    });

    describe('Entity Delete Caching', () => {
        it('should invalidate entity and component caches on delete', async () => {
            const entity = new Entity();
            entity.add(TestComponent, { value: 'test' });

            // Save and cache
            await entity.save();
            await cacheManager.setEntityWriteThrough(entity);

            // Verify cached
            let cachedEntityId = await cacheManager.getEntity(entity.id);
            expect(cachedEntityId).toBe(entity.id);

            // Delete entity
            const deleted = await entity.delete();
            expect(deleted).toBe(true);

            // Check if caches are invalidated
            cachedEntityId = await cacheManager.getEntity(entity.id);
            expect(cachedEntityId).toBeNull();
        });
    });

    describe('Cache Failure Handling', () => {
        it('should not fail entity operations when cache is unavailable', async () => {
            // Disable cache
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                enabled: false
            });

            const entity = new Entity();
            entity.add(TestComponent, { value: 'test' });

            // Should still work without cache
            const saved = await entity.save();
            expect(saved).toBe(true);
        });
    });
});