/**
 * Unit tests for MemoryCache
 * Tests in-memory cache provider functionality
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryCache } from '../../../core/cache/MemoryCache';

describe('MemoryCache', () => {
    let cache: MemoryCache;

    beforeEach(() => {
        cache = new MemoryCache({
            maxSize: 1000,
            maxMemory: 10 * 1024 * 1024, // 10MB
            defaultTTL: 3600000,
            cleanupInterval: 60000
        });
    });

    afterEach(async () => {
        await cache.clear();
        cache.stopCleanup();
    });

    describe('constructor', () => {
        test('creates cache with default config', () => {
            const defaultCache = new MemoryCache();
            expect(defaultCache).toBeDefined();
            defaultCache.stopCleanup();
        });

        test('creates cache with custom config', () => {
            const customCache = new MemoryCache({
                maxSize: 500,
                defaultTTL: 1000
            });
            expect(customCache).toBeDefined();
            customCache.stopCleanup();
        });
    });

    describe('get() and set()', () => {
        test('returns null for non-existent key', async () => {
            const result = await cache.get('non-existent');
            expect(result).toBeNull();
        });

        test('sets and retrieves value', async () => {
            await cache.set('key', 'value', 3600000);
            const result = await cache.get<string>('key');
            expect(result).toBe('value');
        });

        test('sets and retrieves object', async () => {
            const obj = { name: 'test', value: 123 };
            await cache.set('obj-key', obj, 3600000);
            const result = await cache.get<typeof obj>('obj-key');
            expect(result).toEqual(obj);
        });

        test('sets and retrieves array', async () => {
            const arr = [1, 2, 3, 'four'];
            await cache.set('arr-key', arr, 3600000);
            const result = await cache.get<typeof arr>('arr-key');
            expect(result).toEqual(arr);
        });

        test('expires after TTL', async () => {
            await cache.set('expire-key', 'value', 50); // 50ms TTL
            const immediate = await cache.get('expire-key');
            expect(immediate).toBe('value');

            await new Promise(resolve => setTimeout(resolve, 100));
            const expired = await cache.get('expire-key');
            expect(expired).toBeNull();
        });

        test('overwrites existing key', async () => {
            await cache.set('key', 'original', 3600000);
            await cache.set('key', 'updated', 3600000);
            const result = await cache.get('key');
            expect(result).toBe('updated');
        });
    });

    describe('delete()', () => {
        test('removes single key', async () => {
            await cache.set('key', 'value', 3600000);
            await cache.delete('key');
            const result = await cache.get('key');
            expect(result).toBeNull();
        });

        test('removes multiple keys', async () => {
            await cache.set('key1', 'value1', 3600000);
            await cache.set('key2', 'value2', 3600000);
            await cache.delete(['key1', 'key2']);

            const result1 = await cache.get('key1');
            const result2 = await cache.get('key2');
            expect(result1).toBeNull();
            expect(result2).toBeNull();
        });

        test('handles non-existent key gracefully', async () => {
            // Should not throw and key should remain absent
            await cache.delete('non-existent');
            const result = await cache.get('non-existent');
            expect(result).toBeNull();
        });
    });

    describe('deleteMany()', () => {
        test('removes multiple keys', async () => {
            await cache.set('a', 1, 3600000);
            await cache.set('b', 2, 3600000);
            await cache.set('c', 3, 3600000);

            await cache.deleteMany(['a', 'b']);

            expect(await cache.get('a')).toBeNull();
            expect(await cache.get('b')).toBeNull();
            expect(await cache.get<number>('c')).toBe(3);
        });
    });

    describe('getMany()', () => {
        test('returns array of values', async () => {
            await cache.set('k1', 'v1', 3600000);
            await cache.set('k2', 'v2', 3600000);
            await cache.set('k3', 'v3', 3600000);

            const results = await cache.getMany(['k1', 'k2', 'k3']);

            expect(results).toEqual(['v1', 'v2', 'v3']);
        });

        test('returns null for missing keys', async () => {
            await cache.set('k1', 'v1', 3600000);

            const results = await cache.getMany(['k1', 'missing', 'k3']);

            expect(results[0]).toBe('v1');
            expect(results[1]).toBeNull();
            expect(results[2]).toBeNull();
        });
    });

    describe('setMany()', () => {
        test('sets multiple entries', async () => {
            await cache.setMany([
                { key: 'a', value: 1, ttl: 3600000 },
                { key: 'b', value: 2, ttl: 3600000 },
                { key: 'c', value: 3, ttl: 3600000 }
            ]);

            expect(await cache.get<number>('a')).toBe(1);
            expect(await cache.get<number>('b')).toBe(2);
            expect(await cache.get<number>('c')).toBe(3);
        });
    });

    describe('clear()', () => {
        test('removes all entries', async () => {
            await cache.set('key1', 'value1', 3600000);
            await cache.set('key2', 'value2', 3600000);
            await cache.clear();

            expect(await cache.get('key1')).toBeNull();
            expect(await cache.get('key2')).toBeNull();
        });
    });

    describe('invalidatePattern()', () => {
        test('removes keys matching pattern', async () => {
            await cache.set('prefix:1', 'v1', 3600000);
            await cache.set('prefix:2', 'v2', 3600000);
            await cache.set('other:1', 'o1', 3600000);

            await cache.invalidatePattern('prefix:*');

            expect(await cache.get('prefix:1')).toBeNull();
            expect(await cache.get('prefix:2')).toBeNull();
            expect(await cache.get<string>('other:1')).toBe('o1');
        });

        test('handles complex patterns', async () => {
            await cache.set('component:entity1:type1', 'c1', 3600000);
            await cache.set('component:entity1:type2', 'c2', 3600000);
            await cache.set('component:entity2:type1', 'c3', 3600000);

            await cache.invalidatePattern('component:entity1:*');

            expect(await cache.get('component:entity1:type1')).toBeNull();
            expect(await cache.get('component:entity1:type2')).toBeNull();
            expect(await cache.get<string>('component:entity2:type1')).toBe('c3');
        });
    });

    describe('getStats()', () => {
        test('returns statistics', async () => {
            await cache.set('key', 'value', 3600000);
            await cache.get('key'); // Hit
            await cache.get('missing'); // Miss

            const stats = await cache.getStats();

            expect(stats.hits).toBe(1);
            expect(stats.misses).toBe(1);
            expect(stats.hitRate).toBe(0.5);
            expect(stats.size).toBe(1);
        });

        test('tracks size correctly', async () => {
            await cache.set('key1', 'value1', 3600000);
            await cache.set('key2', 'value2', 3600000);

            const stats = await cache.getStats();
            expect(stats.size).toBe(2);
        });
    });

    describe('ping()', () => {
        test('returns true', async () => {
            const result = await cache.ping();
            expect(result).toBe(true);
        });
    });

    describe('LRU eviction', () => {
        test('evicts least recently used when max size reached', async () => {
            const smallCache = new MemoryCache({
                maxSize: 3,
                defaultTTL: 3600000
            });

            await smallCache.set('a', 1, 3600000);
            await smallCache.set('b', 2, 3600000);
            await smallCache.set('c', 3, 3600000);

            // Access 'a' to make it recently used
            await smallCache.get('a');

            // Add fourth item, should evict 'b' (least recently used)
            await smallCache.set('d', 4, 3600000);

            const stats = await smallCache.getStats();
            expect(stats.size).toBeLessThanOrEqual(3);

            // 'b' was least recently used and should have been evicted
            expect(await smallCache.get('b')).toBeNull();
            // 'a', 'c', 'd' should still be present
            expect(await smallCache.get<number>('a')).toBe(1);
            expect(await smallCache.get<number>('c')).toBe(3);
            expect(await smallCache.get<number>('d')).toBe(4);

            smallCache.stopCleanup();
        });
    });
});
