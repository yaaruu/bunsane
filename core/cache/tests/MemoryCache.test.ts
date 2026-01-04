import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryCache } from '../MemoryCache';

describe('MemoryCache', () => {
    let cache: MemoryCache;

    beforeEach(() => {
        cache = new MemoryCache({
            maxSize: 100,
            maxMemory: 1024 * 1024, // 1MB
            defaultTTL: 5000, // 5 seconds
            cleanupInterval: 1000 // 1 second for testing
        });
    });

    afterEach(async () => {
        cache.stopCleanup();
        await cache.clear();
    });

    describe('Basic Operations', () => {
        it('should set and get a value', async () => {
            await cache.set('key1', 'value1');
            const result = await cache.get('key1');
            expect(result).toBe('value1');
        });

        it('should return null for non-existent key', async () => {
            const result = await cache.get('nonexistent');
            expect(result).toBeNull();
        });

        it('should delete a key', async () => {
            await cache.set('key1', 'value1');
            await cache.delete('key1');
            const result = await cache.get('key1');
            expect(result).toBeNull();
        });

        it('should clear all keys', async () => {
            await cache.set('key1', 'value1');
            await cache.set('key2', 'value2');
            await cache.clear();
            expect(await cache.get('key1')).toBeNull();
            expect(await cache.get('key2')).toBeNull();
        });
    });

    describe('TTL Support', () => {
        it('should expire keys after TTL', async () => {
            await cache.set('key1', 'value1', 100); // 100ms TTL
            expect(await cache.get('key1')).toBe('value1');

            await new Promise(resolve => setTimeout(resolve, 150));
            expect(await cache.get('key1')).toBeNull();
        });

        it('should use default TTL when not specified', async () => {
            const fastCache = new MemoryCache({
                maxSize: 100,
                maxMemory: 1024 * 1024,
                defaultTTL: 1000, // 1 second
                cleanupInterval: 200 // 200ms cleanup
            });

            await fastCache.set('key1', 'value1'); // Uses default 1 second TTL
            expect(await fastCache.get('key1')).toBe('value1');

            // Wait for cleanup
            await new Promise(resolve => setTimeout(resolve, 1200));
            expect(await fastCache.get('key1')).toBeNull();

            fastCache.stopCleanup();
        });

        it('should not expire keys without TTL', async () => {
            const cacheNoTTL = new MemoryCache({ defaultTTL: 0 });
            await cacheNoTTL.set('key1', 'value1');
            expect(await cacheNoTTL.get('key1')).toBe('value1');

            cacheNoTTL.stopCleanup();
        });
    });

    describe('Batch Operations', () => {
        it('should get multiple keys', async () => {
            await cache.set('key1', 'value1');
            await cache.set('key2', 'value2');
            await cache.set('key3', 'value3');

            const results = await cache.getMany(['key1', 'key2', 'key3', 'nonexistent']);
            expect(results).toEqual(['value1', 'value2', 'value3', null]);
        });

        it('should set multiple entries', async () => {
            const entries = [
                { key: 'key1', value: 'value1', ttl: 1000 },
                { key: 'key2', value: 'value2' },
                { key: 'key3', value: 'value3', ttl: 2000 }
            ];

            await cache.setMany(entries);

            expect(await cache.get('key1')).toBe('value1');
            expect(await cache.get('key2')).toBe('value2');
            expect(await cache.get('key3')).toBe('value3');
        });

        it('should delete multiple keys', async () => {
            await cache.set('key1', 'value1');
            await cache.set('key2', 'value2');
            await cache.set('key3', 'value3');

            await cache.deleteMany(['key1', 'key3']);

            expect(await cache.get('key1')).toBeNull();
            expect(await cache.get('key2')).toBe('value2');
            expect(await cache.get('key3')).toBeNull();
        });
    });

    describe('Pattern Invalidation', () => {
        it('should invalidate keys matching pattern', async () => {
            await cache.set('user:1', 'user1');
            await cache.set('user:2', 'user2');
            await cache.set('post:1', 'post1');

            await cache.invalidatePattern('user:*');

            expect(await cache.get('user:1')).toBeNull();
            expect(await cache.get('user:2')).toBeNull();
            expect(await cache.get('post:1')).toBe('post1');
        });

        it('should handle complex patterns', async () => {
            await cache.set('cache:v1:user:1', 'user1');
            await cache.set('cache:v1:user:2', 'user2');
            await cache.set('cache:v2:user:1', 'user1v2');

            await cache.invalidatePattern('cache:v1:*');

            expect(await cache.get('cache:v1:user:1')).toBeNull();
            expect(await cache.get('cache:v1:user:2')).toBeNull();
            expect(await cache.get('cache:v2:user:1')).toBe('user1v2');
        });
    });

    describe('Statistics', () => {
        it('should track hits and misses', async () => {
            await cache.set('key1', 'value1');

            await cache.get('key1'); // hit
            await cache.get('key1'); // hit
            await cache.get('nonexistent'); // miss

            const stats = await cache.getStats();
            expect(stats.hits).toBe(2);
            expect(stats.misses).toBe(1);
            expect(stats.hitRate).toBe(2/3);
            expect(stats.size).toBe(1);
        });

        it('should calculate hit rate correctly', async () => {
            const stats = await cache.getStats();
            expect(stats.hitRate).toBe(0); // No requests yet

            await cache.get('nonexistent'); // miss
            const stats2 = await cache.getStats();
            expect(stats2.hitRate).toBe(0);
        });
    });

    describe('Health Check', () => {
        it('should always return true for ping', async () => {
            const result = await cache.ping();
            expect(result).toBe(true);
        });
    });

    describe('LRU Eviction', () => {
        it('should evict least recently used entries when max size exceeded', async () => {
            const smallCache = new MemoryCache({ maxSize: 3 });

            await smallCache.set('key1', 'value1');
            await smallCache.set('key2', 'value2');
            await smallCache.set('key3', 'value3');

            // Access key1 to make it most recently used
            await smallCache.get('key1');

            // Add a new key, should evict key2 (least recently used)
            await smallCache.set('key4', 'value4');

            expect(await smallCache.get('key1')).toBe('value1');
            expect(await smallCache.get('key2')).toBeNull(); // Should be evicted
            expect(await smallCache.get('key3')).toBe('value3');
            expect(await smallCache.get('key4')).toBe('value4');

            smallCache.stopCleanup();
        });
    });

    describe('Memory Estimation', () => {
        it('should estimate memory usage', async () => {
            await cache.set('string', 'hello world');
            await cache.set('number', 42);
            await cache.set('boolean', true);
            await cache.set('array', [1, 2, 3]);
            await cache.set('object', { key: 'value' });

            const stats = await cache.getStats();
            expect(stats.memoryUsage).toBeGreaterThan(0);
            expect(typeof stats.memoryUsage).toBe('number');
        });
    });
});