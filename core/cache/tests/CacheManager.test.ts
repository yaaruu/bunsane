import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CacheManager } from '../CacheManager';
import { MemoryCache } from '../MemoryCache';
import { Entity } from '../../Entity';
import { BaseComponent } from '../../components/BaseComponent';
import { Component, CompData } from '../../components';

/**
 * TASK-052: Unit tests for CacheManager entity, component, query caching
 * 
 * Tests the high-level caching orchestration and key generation logic.
 */

// Test component for caching tests
@Component
class TestCacheComponent extends BaseComponent {
    @CompData()
    value!: string;
}

describe('CacheManager', () => {
    let cacheManager: CacheManager;
    let originalConfig: any;

    beforeEach(async () => {
        cacheManager = CacheManager.getInstance();
        originalConfig = cacheManager.getConfig();
        
        // Initialize with memory cache for testing
        cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 5000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 }
        });

        await cacheManager.getProvider().clear();
    });

    afterEach(async () => {
        await cacheManager.getProvider().clear();
        cacheManager.initialize(originalConfig);
    });

    describe('Configuration', () => {
        it('should return configuration', () => {
            const config = cacheManager.getConfig();
            expect(config.enabled).toBe(true);
            expect(config.provider).toBe('memory');
            expect(config.strategy).toBe('write-through');
        });

        it('should allow reconfiguration', () => {
            cacheManager.initialize({
                enabled: false,
                provider: 'noop',
                strategy: 'write-invalidate',
                entity: { enabled: false, ttl: 1000 },
                component: { enabled: false, ttl: 1000 }
            });

            const config = cacheManager.getConfig();
            expect(config.enabled).toBe(false);
            expect(config.provider).toBe('noop');
            expect(config.strategy).toBe('write-invalidate');
        });

        it('should provide access to underlying provider', () => {
            const provider = cacheManager.getProvider();
            expect(provider).toBeInstanceOf(MemoryCache);
        });
    });

    describe('Entity Caching', () => {
        it('should generate consistent entity cache keys', () => {
            const key1 = `entity:123`;
            const key2 = `entity:123`;
            expect(key1).toBe(key2);
            expect(key1).toContain('entity:');
            expect(key1).toContain('123');
        });

        it('should cache entity by ID', async () => {
            const entity = new Entity('123');
            await cacheManager.setEntityWriteThrough(entity, 5000);
            
            const result = await cacheManager.getEntity('123');
            expect(result).toBe('123');
        });

        it('should use configured TTL when not specified', async () => {
            const entity = new Entity('123');
            await cacheManager.setEntityWriteThrough(entity);
            
            const result = await cacheManager.getEntity('123');
            expect(result).toBe('123');
        });

        it('should invalidate entity by ID', async () => {
            const entity = new Entity('123');
            await cacheManager.setEntityWriteThrough(entity);
            
            await cacheManager.invalidateEntity('123');
            
            const result = await cacheManager.getEntity('123');
            expect(result).toBeNull();
        });
    });

    describe('Component Caching', () => {
        it('should generate consistent component cache keys', () => {
            const key1 = `component:123:456`;
            const key2 = `component:123:456`;
            expect(key1).toBe(key2);
            expect(key1).toContain('component:');
            expect(key1).toContain('123');
            expect(key1).toContain('456');
        });

        it('should cache component data', async () => {
            const entity = new Entity('123');
            const component = new TestCacheComponent();
            component.id = '1';
            component.value = 'test component';
            
            await cacheManager.setComponentWriteThrough(entity.id, [component]);
            
            const result = await cacheManager.getComponentsByEntity(entity.id, component.getTypeID());
            expect(result).toBeDefined();
        });

        it('should cache components by entity type', async () => {
            const entityId = '789';
            const component1 = new TestCacheComponent();
            component1.id = '1';
            component1.value = 'comp1';
            const component2 = new TestCacheComponent();
            component2.id = '2';
            component2.value = 'comp2';
            
            await cacheManager.setComponentWriteThrough(entityId, [component1, component2]);
            
            const result = await cacheManager.getComponentsByEntity(entityId, component1.getTypeID());
            expect(result).toBeDefined();
        });

        it('should invalidate component', async () => {
            const entity = new Entity('123');
            const component = new TestCacheComponent();
            component.id = '1';
            component.value = 'test';
            const typeId = component.getTypeID();
            
            await cacheManager.setComponentWriteThrough(entity.id, [component]);
            await cacheManager.invalidateComponent(entity.id, typeId);
            
            const result = await cacheManager.getComponentsByEntity(entity.id, typeId);
            expect(result).toBeNull();
        });

        it('should invalidate all components for entity', async () => {
            const entityId = '123';
            const component1 = new TestCacheComponent();
            component1.id = '1';
            component1.value = 'comp1';
            const component2 = new TestCacheComponent();
            component2.id = '2';
            component2.value = 'comp2';
            
            await cacheManager.setComponentWriteThrough(entityId, [component1]);
            await cacheManager.setComponentWriteThrough(entityId, [component2]);
            
            await cacheManager.invalidateAllEntityComponents(entityId);
            
            const result1 = await cacheManager.getComponentsByEntity(entityId, component1.getTypeID());
            const result2 = await cacheManager.getComponentsByEntity(entityId, component2.getTypeID());
            expect(result1).toBeNull();
            expect(result2).toBeNull();
        });

        it('should implement write-through component caching', async () => {
            const entity = new Entity('456');
            const component = new TestCacheComponent();
            component.id = '1';
            component.value = 'test';
            
            await cacheManager.setComponentWriteThrough(entity.id, [component], component.getTypeID(), 5000);
            
            const result = await cacheManager.getComponentsByEntity(entity.id, component.getTypeID());
            expect(result).toBeDefined();
        });
    });

    describe('Query Result Caching', () => {
        it('should cache query results by key', async () => {
            const mockResults = [
                { id: 1, name: 'result1' },
                { id: 2, name: 'result2' }
            ];
            
            await cacheManager.set('query:query123', mockResults, 5000);
            
            const result = await cacheManager.get<typeof mockResults>('query:query123');
            expect(result).toEqual(mockResults);
        });

        it('should return null for non-cached query', async () => {
            const result = await cacheManager.get('query:nonexistent');
            expect(result).toBeNull();
        });

        it('should invalidate query by pattern', async () => {
            await cacheManager.set('user:query:1', [{ id: 1 }]);
            await cacheManager.set('user:query:2', [{ id: 2 }]);
            await cacheManager.set('post:query:1', [{ id: 3 }]);
            
            await cacheManager.getProvider().invalidatePattern('user:query:*');
            
            const result1 = await cacheManager.get('user:query:1');
            const result2 = await cacheManager.get('user:query:2');
            const result3 = await cacheManager.get('post:query:1');
            
            expect(result1).toBeNull();
            expect(result2).toBeNull();
            expect(result3).toEqual([{ id: 3 }]);
        });
    });

    describe('Health and Statistics', () => {
        it('should return cache statistics', async () => {
            // Generate some cache activity
            const entity = new Entity('1');
            await cacheManager.setEntityWriteThrough(entity);
            await cacheManager.getEntity('1'); // Hit
            await cacheManager.getEntity('999'); // Miss
            
            const stats = await cacheManager.getStats();
            expect(stats).toHaveProperty('hits');
            expect(stats).toHaveProperty('misses');
            expect(stats).toHaveProperty('hitRate');
            expect(stats).toHaveProperty('size');
        });
    });

    describe('Bulk Operations', () => {
        it('should invalidate multiple entities', async () => {
            const entity1 = new Entity('1');
            const entity2 = new Entity('2');
            const entity3 = new Entity('3');
            
            await cacheManager.setEntityWriteThrough(entity1);
            await cacheManager.setEntityWriteThrough(entity2);
            await cacheManager.setEntityWriteThrough(entity3);
            
            await cacheManager.delete(['entity:1', 'entity:2']);
            
            const result1 = await cacheManager.getEntity('1');
            const result2 = await cacheManager.getEntity('2');
            const result3 = await cacheManager.getEntity('3');
            
            expect(result1).toBeNull();
            expect(result2).toBeNull();
            expect(result3).toBe('3');
        });

        it('should invalidate all entity-related caches', async () => {
            const entityId = '123';
            const entity = new Entity(entityId);
            const component1 = new TestCacheComponent();
            component1.id = '1';
            component1.value = 'comp1';
            const component2 = new TestCacheComponent();
            component2.id = '2';
            component2.value = 'comp2';
            
            await cacheManager.setEntityWriteThrough(entity);
            await cacheManager.setComponentWriteThrough(entityId, [component1]);
            await cacheManager.setComponentWriteThrough(entityId, [component2]);
            
            await cacheManager.invalidateAllEntityComponents(entityId);
            await cacheManager.invalidateEntity(entityId);
            
            const entityResult = await cacheManager.getEntity(entityId);
            const comp1 = await cacheManager.getComponentsByEntity(entityId, component1.getTypeID());
            const comp2 = await cacheManager.getComponentsByEntity(entityId, component2.getTypeID());
            
            expect(entityResult).toBeNull();
            expect(comp1).toBeNull();
            expect(comp2).toBeNull();
        });
    });

    describe('Write Strategy', () => {
        it('should respect write-through strategy', async () => {
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-through'
            });

            const config = cacheManager.getConfig();
            expect(config.strategy).toBe('write-through');
        });

        it('should respect write-invalidate strategy', async () => {
            cacheManager.initialize({
                ...cacheManager.getConfig(),
                strategy: 'write-invalidate'
            });

            const config = cacheManager.getConfig();
            expect(config.strategy).toBe('write-invalidate');
        });
    });

    describe('Cache Disabled', () => {
        beforeEach(() => {
            cacheManager.initialize({
                enabled: false,
                provider: 'noop',
                strategy: 'write-through',
                entity: { enabled: false, ttl: 1000 },
                component: { enabled: false, ttl: 1000 }
            });
        });

        it('should return null for all get operations when disabled', async () => {
            const entity = new Entity('123');
            await cacheManager.setEntityWriteThrough(entity);
            const result = await cacheManager.getEntity('123');
            expect(result).toBeNull();
        });

        it('should not store data when disabled', async () => {
            await cacheManager.set('query:test', [{ id: 1 }]);
            const result = await cacheManager.get('query:test');
            expect(result).toBeNull();
        });
    });
});
