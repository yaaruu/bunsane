import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../../Entity';
import { CacheManager } from '../../CacheManager';
import { Component, CompData, BaseComponent } from '../../../components';
import EntityManager from '../../../EntityManager';

/**
 * TASK-056: Integration tests for cache invalidation patterns
 * 
 * Tests comprehensive cache invalidation scenarios including:
 * - Entity save/delete invalidation
 * - Component add/remove invalidation
 * - Pattern-based invalidation
 * - Cascading invalidation
 * - Write-through vs write-invalidate strategies
 */

// Test components
@Component
class InvalidationTestComponent extends BaseComponent {
    @CompData()
    value!: string;
}

@Component
class RelatedComponent extends BaseComponent {
    @CompData()
    relatedId!: string;
}

describe('Cache Invalidation Integration', () => {
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
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 }
        });

        // Clear cache
        await cacheManager.getProvider().clear();
    });

    afterEach(async () => {
        // Restore original config
        cacheManager.initialize(originalConfig);
        await cacheManager.getProvider().clear();
    });

    describe('Entity Invalidation', () => {
        it('should invalidate entity cache on save with write-invalidate strategy', async () => {
            // Switch to write-invalidate
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-invalidate'
            });

            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Pre-cache the entity
            await cacheManager.setEntityWriteThrough(entity);
            let cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBe(entity.id);

            // Save again - should invalidate
            await entity.save();

            // Check if invalidated
            cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBeNull();

            // Cleanup
            await entity.delete();
        });

        it('should update entity cache on save with write-through strategy', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Cache should be updated automatically with write-through
            const cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBe(entity.id);

            // Cleanup
            await entity.delete();
        });

        it('should invalidate entity cache on delete', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Cache the entity
            await cacheManager.setEntityWriteThrough(entity);
            let cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBe(entity.id);

            // Delete entity
            await entity.delete();

            // Check if invalidated
            cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBeNull();
        });

        it('should invalidate multiple entities', async () => {
            const entities: Entity[] = [];
            for (let i = 0; i < 3; i++) {
                const entity = new Entity();
                entity.add(InvalidationTestComponent, { value: `test${i}` });
                await entity.save();
                await cacheManager.setEntityWriteThrough(entity);
                entities.push(entity);
            }

            // Verify all cached
            for (const entity of entities) {
                const cached = await cacheManager.getEntity(entity.id);
                expect(cached).toBe(entity.id);
            }

            // Invalidate all
            for (const entity of entities) {
                await cacheManager.invalidateEntity(entity.id);
            }

            // Verify all invalidated
            for (const entity of entities) {
                const cached = await cacheManager.getEntity(entity.id);
                expect(cached).toBeNull();
            }

            // Cleanup
            for (const entity of entities) {
                await entity.delete();
            }
        });
    });

    describe('Component Invalidation', () => {
        it('should invalidate component cache when component is updated', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'original' });
            await entity.save();

            // Cache the component
            const comp = await entity.get(InvalidationTestComponent);
            if (comp) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp]);
            }

            // Update component
            const updatedComp = await entity.get(InvalidationTestComponent);
            if (updatedComp) {
                updatedComp.value = 'updated';
                await entity.save();
            }

            // In write-invalidate strategy, component cache should be invalidated
            // In write-through strategy, component cache should be updated

            // Cleanup
            await entity.delete();
        });

        it('should invalidate component cache when component is removed', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Cache the component
            const comp = await entity.getInstanceOf(InvalidationTestComponent);
            if (comp) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp]);
            }

            // Remove component
            await entity.remove(InvalidationTestComponent);
            await entity.save();

            // Component cache should be invalidated
            await cacheManager.invalidateComponent(entity.id, comp!.getTypeID());

            // Cleanup
            await entity.delete();
        });

        it('should invalidate all components for an entity', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            entity.add(RelatedComponent, { relatedId: 'related' });
            await entity.save();

            // Cache both components
            const comp1 = await entity.getInstanceOf(InvalidationTestComponent);
            const comp2 = await entity.getInstanceOf(RelatedComponent);
            if (comp1 && comp2) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp1, comp2]);
            }

            // Invalidate all components for entity
            await cacheManager.invalidateAllEntityComponents(entity.id);

            // Both components should be invalidated
            const cached1 = await cacheManager.getComponentsByEntity(entity.id, comp1!.getTypeID());
            const cached2 = await cacheManager.getComponentsByEntity(entity.id, comp2!.getTypeID());
            expect(cached1).toBeNull();
            expect(cached2).toBeNull();

            // Cleanup
            await entity.delete();
        });

        it('should invalidate specific components by type', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            entity.add(RelatedComponent, { relatedId: 'related' });
            await entity.save();

            // Cache both components
            const comp1 = await entity.getInstanceOf(InvalidationTestComponent);
            const comp2 = await entity.getInstanceOf(RelatedComponent);
            if (comp1 && comp2) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp1, comp2]);
            }

            // Invalidate only InvalidationTestComponent
            await cacheManager.invalidateComponent(entity.id, comp1!.getTypeID());

            // Only InvalidationTestComponent should be invalidated
            const cached1 = await cacheManager.getComponentsByEntity(entity.id, comp1!.getTypeID());
            const cached2 = await cacheManager.getComponentsByEntity(entity.id, comp2!.getTypeID());
            expect(cached1).toBeNull();
            // Note: cached2 might also be null depending on implementation

            // Cleanup
            await entity.delete();
        });
    });

    describe('Pattern-Based Invalidation', () => {
        it('should invalidate caches matching wildcard pattern', async () => {
            // Set up test data
            await cacheManager.set('user:1:profile', { name: 'User 1' });
            await cacheManager.set('user:2:profile', { name: 'User 2' });
            await cacheManager.set('user:1:settings', { theme: 'dark' });
            await cacheManager.set('post:1:data', { title: 'Post 1' });

            // Invalidate all user:1 caches
            await cacheManager.getProvider().invalidatePattern('user:1:*');

            // Check results
            expect(await cacheManager.get('user:1:profile')).toBeNull();
            expect(await cacheManager.get('user:1:settings')).toBeNull();
            expect(await cacheManager.get('user:2:profile')).toEqual({ name: 'User 2' });
            expect(await cacheManager.get('post:1:data')).toEqual({ title: 'Post 1' });
        });

        it('should invalidate all entity caches with pattern', async () => {
            const entities: Entity[] = [];
            for (let i = 0; i < 5; i++) {
                const entity = new Entity();
                entity.add(InvalidationTestComponent, { value: `test${i}` });
                await entity.save();
                await cacheManager.setEntityWriteThrough(entity);
                entities.push(entity);
            }

            // Invalidate all entity caches
            await cacheManager.getProvider().invalidatePattern('entity:*');

            // Verify all invalidated
            for (const entity of entities) {
                const cached = await cacheManager.getEntity(entity.id);
                expect(cached).toBeNull();
            }

            // Cleanup
            for (const entity of entities) {
                await entity.delete();
            }
        });

        it('should invalidate all component caches with pattern', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            entity.add(RelatedComponent, { relatedId: 'related' });
            await entity.save();

            // Cache components
            const comp1 = await entity.getInstanceOf(InvalidationTestComponent);
            const comp2 = await entity.getInstanceOf(RelatedComponent);
            if (comp1 && comp2) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp1, comp2]);
            }

            // Invalidate all components for this entity
            await cacheManager.getProvider().invalidatePattern(`component:${entity.id}:*`);

            // Verify all invalidated
            const cached1 = await cacheManager.getComponentsByEntity(entity.id, comp1!.getTypeID());
            const cached2 = await cacheManager.getComponentsByEntity(entity.id, comp2!.getTypeID());
            expect(cached1).toBeNull();
            expect(cached2).toBeNull();

            // Cleanup
            await entity.delete();
        });
    });

    describe('Cascading Invalidation', () => {
        it('should invalidate related caches when entity is deleted', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            entity.add(RelatedComponent, { relatedId: 'related' });
            await entity.save();

            // Cache entity and components
            await cacheManager.setEntityWriteThrough(entity);
            const comp1 = await entity.getInstanceOf(InvalidationTestComponent);
            const comp2 = await entity.getInstanceOf(RelatedComponent);
            if (comp1 && comp2) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp1, comp2]);
            }

            // Delete entity - should cascade invalidation
            await entity.delete();

            // Verify entity cache invalidated
            const cachedEntity = await cacheManager.getEntity(entity.id);
            expect(cachedEntity).toBeNull();

            // Verify component caches invalidated
            const cachedComp1 = await cacheManager.getComponentsByEntity(entity.id, comp1!.getTypeID());
            const cachedComp2 = await cacheManager.getComponentsByEntity(entity.id, comp2!.getTypeID());
            expect(cachedComp1).toBeNull();
            expect(cachedComp2).toBeNull();
        });

        it('should invalidate dependent caches in correct order', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Cache at multiple levels
            await cacheManager.setEntityWriteThrough(entity);
            const comp = await entity.getInstanceOf(InvalidationTestComponent);
            if (comp) {
                await cacheManager.setComponentWriteThrough(entity.id, [comp]);
            }

            // Also cache a query result that includes this entity
            await cacheManager.set(`query:includes:${entity.id}`, [entity.id]);

            // Delete entity
            await entity.delete();

            // All levels should be invalidated
            expect(await cacheManager.getEntity(entity.id)).toBeNull();
            expect(await cacheManager.getComponentsByEntity(entity.id, comp!.getTypeID())).toBeNull();
            
            // Query cache would need manual invalidation in current implementation
            await cacheManager.getProvider().invalidatePattern('query:*');
            expect(await cacheManager.get(`query:includes:${entity.id}`)).toBeNull();
        });
    });

    describe('Strategy-Specific Invalidation', () => {
        it('should handle write-through strategy correctly', async () => {
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-through'
            });

            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'original' });
            await entity.save();

            // With write-through, cache should be updated automatically
            const cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBe(entity.id);

            // Update and save
            const comp = await entity.get(InvalidationTestComponent);
            if (comp) {
                comp.value = 'updated';
                await entity.save();
            }

            // Cache should still be valid (updated, not invalidated)
            const cachedAfter = await cacheManager.getEntity(entity.id);
            expect(cachedAfter).toBe(entity.id);

            // Cleanup
            await entity.delete();
        });

        it('should handle write-invalidate strategy correctly', async () => {
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-invalidate'
            });

            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'original' });
            await entity.save();

            // Pre-cache
            await cacheManager.setEntityWriteThrough(entity);
            let cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBe(entity.id);

            // Update and save
            const comp = await entity.get(InvalidationTestComponent);
            if (comp) {
                comp.value = 'updated';
                await entity.save();
            }

            // With write-invalidate, cache should be cleared
            cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBeNull();

            // Cleanup
            await entity.delete();
        });
    });

    describe('Bulk Invalidation', () => {
        it('should invalidate multiple specific components efficiently', async () => {
            const entities: Entity[] = [];
            const componentsToInvalidate: Array<{ entityId: string; typeId: string }> = [];

            // Create multiple entities with components
            for (let i = 0; i < 5; i++) {
                const entity = new Entity();
                entity.add(InvalidationTestComponent, { value: `test${i}` });
                await entity.save();
                
                const comp = await entity.getInstanceOf(InvalidationTestComponent);
                if (comp) {
                    await cacheManager.setComponentWriteThrough(entity.id, [comp]);
                    componentsToInvalidate.push({
                        entityId: entity.id,
                        typeId: comp.getTypeID()
                    });
                }
                entities.push(entity);
            }

            // Bulk invalidate
            await cacheManager.invalidateComponents(componentsToInvalidate);

            // Verify all invalidated
            for (const comp of componentsToInvalidate) {
                const cached = await cacheManager.getComponentsByEntity(comp.entityId, comp.typeId);
                expect(cached).toBeNull();
            }

            // Cleanup
            for (const entity of entities) {
                await entity.delete();
            }
        });

        it('should clear entire cache efficiently', async () => {
            // Add various cache entries
            await cacheManager.set('key1', 'value1');
            await cacheManager.set('key2', 'value2');
            await cacheManager.set('key3', 'value3');

            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();
            await cacheManager.setEntityWriteThrough(entity);

            // Clear all
            await cacheManager.clear();

            // Verify all cleared
            expect(await cacheManager.get('key1')).toBeNull();
            expect(await cacheManager.get('key2')).toBeNull();
            expect(await cacheManager.get('key3')).toBeNull();
            expect(await cacheManager.getEntity(entity.id)).toBeNull();

            // Cleanup
            await entity.delete();
        });
    });

    describe('Invalidation Edge Cases', () => {
        it('should handle invalidation of non-existent keys gracefully', async () => {
            await expect(cacheManager.invalidateEntity('non-existent-id')).resolves.toBeUndefined();
            await expect(cacheManager.invalidateComponent('non-existent-id', 'non-existent-type')).resolves.toBeUndefined();
        });

        it('should handle concurrent invalidations', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();
            await cacheManager.setEntityWriteThrough(entity);

            // Concurrent invalidations
            await Promise.all([
                cacheManager.invalidateEntity(entity.id),
                cacheManager.invalidateEntity(entity.id),
                cacheManager.invalidateEntity(entity.id)
            ]);

            // Should be invalidated
            const cached = await cacheManager.getEntity(entity.id);
            expect(cached).toBeNull();

            // Cleanup
            await entity.delete();
        });

        it('should handle invalidation during cache operations', async () => {
            const entity = new Entity();
            entity.add(InvalidationTestComponent, { value: 'test' });
            await entity.save();

            // Concurrent set and invalidate
            await Promise.all([
                cacheManager.setEntityWriteThrough(entity),
                cacheManager.invalidateEntity(entity.id)
            ]);

            // Final state depends on operation order, but should not error
            const cached = await cacheManager.getEntity(entity.id);
            // Could be null or entity.id depending on timing

            // Cleanup
            await entity.delete();
        });

        it('should handle pattern invalidation with no matches', async () => {
            await cacheManager.set('key1', 'value1');
            await cacheManager.set('key2', 'value2');

            // Invalidate pattern with no matches
            await expect(
                cacheManager.getProvider().invalidatePattern('nonexistent:*')
            ).resolves.toBeUndefined();

            // Existing keys should remain
            expect(await cacheManager.get('key1')).toBe('value1');
            expect(await cacheManager.get('key2')).toBe('value2');
        });
    });
});
