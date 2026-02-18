/**
 * Unit tests for CacheManager
 * Tests cache configuration and management
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CacheManager } from '../../../core/cache/CacheManager';
import { MemoryCache } from '../../../core/cache/MemoryCache';
import { MultiLevelCache } from '../../../core/cache/MultiLevelCache';

describe('CacheManager', () => {
    let cacheManager: CacheManager;

    beforeEach(async () => {
        cacheManager = CacheManager.getInstance();
        await cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            query: { enabled: false, ttl: 300000, maxSize: 10000 }
        });
    });

    afterEach(async () => {
        await cacheManager.clear();
    });

    describe('getInstance()', () => {
        test('returns singleton instance', () => {
            const instance1 = CacheManager.getInstance();
            const instance2 = CacheManager.getInstance();
            expect(instance1).toBe(instance2);
        });

        test('returns defined instance', () => {
            const instance = CacheManager.getInstance();
            expect(instance).toBeDefined();
        });
    });

    describe('initialize()', () => {
        test('applies configuration', async () => {
            await cacheManager.initialize({
                enabled: true,
                provider: 'memory',
                defaultTTL: 5000
            });

            const config = cacheManager.getConfig();
            expect(config.enabled).toBe(true);
            expect(config.provider).toBe('memory');
            expect(config.defaultTTL).toBe(5000);
        });

        test('can disable cache', async () => {
            await cacheManager.initialize({ enabled: false });
            const config = cacheManager.getConfig();
            expect(config.enabled).toBe(false);
        });
    });

    describe('getConfig()', () => {
        test('returns configuration object', () => {
            const config = cacheManager.getConfig();
            expect(config).toBeDefined();
            expect(typeof config.enabled).toBe('boolean');
        });

        test('returns copy of configuration', () => {
            const config1 = cacheManager.getConfig();
            const config2 = cacheManager.getConfig();
            expect(config1).not.toBe(config2);
            expect(config1).toEqual(config2);
        });
    });

    describe('getProvider()', () => {
        test('returns cache provider', () => {
            const provider = cacheManager.getProvider();
            expect(provider).toBeDefined();
        });
    });

    describe('generic cache operations', () => {
        test('get returns null for missing key', async () => {
            const result = await cacheManager.get('non-existent-key');
            expect(result).toBeNull();
        });

        test('set and get work correctly', async () => {
            await cacheManager.set('test-key', { data: 'value' });
            const result = await cacheManager.get<{ data: string }>('test-key');
            expect(result).toEqual({ data: 'value' });
        });

        test('set respects TTL', async () => {
            await cacheManager.set('test-key', 'value', 100);
            const immediate = await cacheManager.get('test-key');
            expect(immediate).toBe('value');

            // Wait for TTL to expire
            await new Promise(resolve => setTimeout(resolve, 150));
            const expired = await cacheManager.get('test-key');
            expect(expired).toBeNull();
        });

        test('delete removes key', async () => {
            await cacheManager.set('test-key', 'value');
            await cacheManager.delete('test-key');
            const result = await cacheManager.get('test-key');
            expect(result).toBeNull();
        });

        test('clear removes all keys', async () => {
            await cacheManager.set('key1', 'value1');
            await cacheManager.set('key2', 'value2');
            await cacheManager.clear();

            const result1 = await cacheManager.get('key1');
            const result2 = await cacheManager.get('key2');
            expect(result1).toBeNull();
            expect(result2).toBeNull();
        });
    });

    describe('entity cache operations', () => {
        test('getEntity returns null for missing entity', async () => {
            const result = await cacheManager.getEntity('missing-id');
            expect(result).toBeNull();
        });

        test('invalidateEntity removes entity from cache', async () => {
            // Manually set entity cache
            const provider = cacheManager.getProvider();
            await provider.set('entity:test-id', 'test-id', 3600000);

            await cacheManager.invalidateEntity('test-id');
            const result = await cacheManager.getEntity('test-id');
            expect(result).toBeNull();
        });

        test('getEntities returns null for missing entities', async () => {
            const results = await cacheManager.getEntities(['id1', 'id2', 'id3']);
            expect(results.length).toBe(3);
            expect(results.every(r => r === null)).toBe(true);
        });
    });

    describe('component cache operations', () => {
        test('getComponentsByEntity returns null for missing components', async () => {
            const result = await cacheManager.getComponentsByEntity('entity-id');
            expect(result).toBeNull();
        });

        test('invalidateComponent removes specific component', async () => {
            // Manually set component cache
            const provider = cacheManager.getProvider();
            await provider.set('component:entity-id:type-id', { data: 'test' }, 3600000);

            await cacheManager.invalidateComponent('entity-id', 'type-id');
            const result = await cacheManager.getComponentsByEntity('entity-id', 'type-id');
            expect(result).toBeNull();
        });

        test('invalidateComponents removes multiple components', async () => {
            const provider = cacheManager.getProvider();
            await provider.set('component:e1:t1', { data: 'test1' }, 3600000);
            await provider.set('component:e2:t2', { data: 'test2' }, 3600000);

            await cacheManager.invalidateComponents([
                { entityId: 'e1', typeId: 't1' },
                { entityId: 'e2', typeId: 't2' }
            ]);

            const result1 = await provider.get('component:e1:t1');
            const result2 = await provider.get('component:e2:t2');
            expect(result1).toBeNull();
            expect(result2).toBeNull();
        });

        test('getComponents returns null for missing components', async () => {
            const results = await cacheManager.getComponents([
                { entityId: 'e1', typeId: 't1' },
                { entityId: 'e2', typeId: 't2' }
            ]);
            expect(results.length).toBe(2);
            expect(results.every(r => r === null)).toBe(true);
        });
    });

    describe('cache disabled', () => {
        beforeEach(async () => {
            await cacheManager.initialize({ enabled: false });
        });

        test('get returns null when disabled', async () => {
            const result = await cacheManager.get('key');
            expect(result).toBeNull();
        });

        test('set does nothing when disabled', async () => {
            await cacheManager.set('key', 'value');
            // Re-enable to check
            await cacheManager.initialize({ enabled: true, provider: 'memory' });
            const result = await cacheManager.get('key');
            expect(result).toBeNull();
        });

        test('getEntity returns null when disabled', async () => {
            const result = await cacheManager.getEntity('id');
            expect(result).toBeNull();
        });

        test('getComponentsByEntity returns null when disabled', async () => {
            const result = await cacheManager.getComponentsByEntity('id');
            expect(result).toBeNull();
        });
    });

    describe('getStats()', () => {
        test('returns statistics object', async () => {
            const stats = await cacheManager.getStats();
            expect(stats).toBeDefined();
            expect(typeof stats.hits).toBe('number');
            expect(typeof stats.misses).toBe('number');
        });
    });

    describe('ping()', () => {
        test('returns true for healthy cache', async () => {
            const result = await cacheManager.ping();
            expect(result).toBe(true);
        });
    });

    describe('shutdown()', () => {
        test('calls stopCleanup on MemoryCache provider', async () => {
            await cacheManager.initialize({
                enabled: true,
                provider: 'memory',
                defaultTTL: 3600000
            });

            const provider = cacheManager.getProvider() as MemoryCache;
            const stopCleanupSpy = mock(() => {});
            (provider as any).stopCleanup = stopCleanupSpy;

            await cacheManager.shutdown();
            expect(stopCleanupSpy).toHaveBeenCalled();
        });

        test('shutdown does not throw on NoOp provider', async () => {
            await cacheManager.initialize({ enabled: false });
            await expect(cacheManager.shutdown()).resolves.toBeUndefined();
        });
    });

    describe('initialize() cleanup', () => {
        test('shuts down old provider when reinitializing', async () => {
            await cacheManager.initialize({
                enabled: true,
                provider: 'memory',
                defaultTTL: 3600000
            });

            const oldProvider = cacheManager.getProvider() as MemoryCache;
            const stopCleanupSpy = mock(() => {});
            (oldProvider as any).stopCleanup = stopCleanupSpy;

            // Reinitialize with new config
            await cacheManager.initialize({
                enabled: true,
                provider: 'memory',
                defaultTTL: 5000
            });

            expect(stopCleanupSpy).toHaveBeenCalled();
        });
    });

    describe('cross-instance invalidation (pub/sub)', () => {
        test('pub/sub not enabled for memory-only provider', async () => {
            await cacheManager.initialize({
                enabled: true,
                provider: 'memory',
                defaultTTL: 3600000
            });

            // pubSubEnabled is private, so we test indirectly:
            // publishInvalidation should be a no-op (no errors, no side effects)
            await cacheManager.set('test-key', 'value');
            await cacheManager.delete('test-key');
            // If pub/sub were broken for memory provider, this would throw
            const result = await cacheManager.get('test-key');
            expect(result).toBeNull();
        });

        test('invalidateEntity still works without pub/sub', async () => {
            const provider = cacheManager.getProvider();
            await provider.set('entity:abc', 'abc', 3600000);

            await cacheManager.invalidateEntity('abc');
            const result = await provider.get('entity:abc');
            expect(result).toBeNull();
        });

        test('invalidateComponent still works without pub/sub', async () => {
            const provider = cacheManager.getProvider();
            await provider.set('component:e1:t1', { data: 'test' }, 3600000);

            await cacheManager.invalidateComponent('e1', 't1');
            const result = await provider.get('component:e1:t1');
            expect(result).toBeNull();
        });

        test('clear still works without pub/sub', async () => {
            await cacheManager.set('key1', 'v1');
            await cacheManager.set('key2', 'v2');

            await cacheManager.clear();
            expect(await cacheManager.get('key1')).toBeNull();
            expect(await cacheManager.get('key2')).toBeNull();
        });

        test('handleRemoteInvalidation ignores messages from self', async () => {
            // Access private method via any
            const cm = cacheManager as any;
            const myId = cm.instanceId;

            // Simulate receiving our own message — should NOT invalidate
            await cacheManager.set('survive-key', 'should-survive');

            // Call private method directly
            await cm.handleRemoteInvalidation(JSON.stringify({
                instanceId: myId,
                type: 'key',
                keys: ['survive-key']
            }));

            // Key should still exist because self-messages are ignored
            const result = await cacheManager.get('survive-key');
            expect(result).toBe('should-survive');
        });
    });
});
