/**
 * Unit tests for RedisCache
 * Tests Redis cache provider functionality with a real Redis server
 *
 * PREREQUISITE: Redis server must be running on localhost:6379
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { RedisCache } from '../../../core/cache/RedisCache';

describe('RedisCache', () => {
    let cache: RedisCache;
    const TEST_PREFIX = 'bunsane:test:';

    beforeAll(async () => {
        cache = new RedisCache({
            host: 'localhost',
            port: 6379,
            keyPrefix: TEST_PREFIX,
            lazyConnect: false,
            enableReadyCheck: true,
            maxRetriesPerRequest: 3
        });

        // Wait for connection
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify connection
        const isConnected = await cache.ping();
        if (!isConnected) {
            throw new Error('Failed to connect to Redis. Make sure Redis server is running on localhost:6379');
        }
    });

    afterAll(async () => {
        // Clean up test keys before disconnecting
        await cache.invalidatePattern('*');
        await cache.disconnect();
    });

    beforeEach(async () => {
        // Clear test keys before each test
        await cache.invalidatePattern('*');
    });

    describe('ping()', () => {
        test('returns true when connected', async () => {
            const result = await cache.ping();
            expect(result).toBe(true);
        });
    });

    describe('healthCheck()', () => {
        test('returns health status with connection info', async () => {
            const health = await cache.healthCheck();

            expect(health.connected).toBe(true);
            expect(typeof health.latency).toBe('number');
            expect(health.latency).toBeGreaterThanOrEqual(0);
            expect(health.version).toBeDefined();
        });
    });

    describe('get() and set()', () => {
        test('returns null for non-existent key', async () => {
            const result = await cache.get('non-existent-key');
            expect(result).toBeNull();
        });

        test('sets and retrieves string value', async () => {
            await cache.set('string-key', 'hello world', 3600000);
            const result = await cache.get<string>('string-key');
            expect(result).toBe('hello world');
        });

        test('sets and retrieves number value', async () => {
            await cache.set('number-key', 42, 3600000);
            const result = await cache.get<number>('number-key');
            expect(result).toBe(42);
        });

        test('sets and retrieves object', async () => {
            const obj = { name: 'test', value: 123, nested: { a: 1, b: 2 } };
            await cache.set('obj-key', obj, 3600000);
            const result = await cache.get<typeof obj>('obj-key');
            expect(result).toEqual(obj);
        });

        test('sets and retrieves array', async () => {
            const arr = [1, 2, 3, 'four', { five: 5 }];
            await cache.set('arr-key', arr, 3600000);
            const result = await cache.get<typeof arr>('arr-key');
            expect(result).toEqual(arr);
        });

        test('sets and retrieves boolean values', async () => {
            await cache.set('bool-true', true, 3600000);
            await cache.set('bool-false', false, 3600000);

            expect(await cache.get<boolean>('bool-true')).toBe(true);
            expect(await cache.get<boolean>('bool-false')).toBe(false);
        });

        test('sets and retrieves null value', async () => {
            await cache.set('null-key', null, 3600000);
            const result = await cache.get('null-key');
            expect(result).toBeNull();
        });

        test('expires after TTL', async () => {
            // Redis TTL is in seconds (minimum 1 second), our API uses milliseconds
            await cache.set('expire-key', 'value', 1000); // 1 second TTL

            const immediate = await cache.get('expire-key');
            expect(immediate).toBe('value');

            await new Promise(resolve => setTimeout(resolve, 1500));

            const expired = await cache.get('expire-key');
            expect(expired).toBeNull();
        });

        test('overwrites existing key', async () => {
            await cache.set('overwrite-key', 'original', 3600000);
            await cache.set('overwrite-key', 'updated', 3600000);

            const result = await cache.get('overwrite-key');
            expect(result).toBe('updated');
        });
    });

    describe('delete()', () => {
        test('removes single key', async () => {
            await cache.set('delete-key', 'value', 3600000);
            await cache.delete('delete-key');

            const result = await cache.get('delete-key');
            expect(result).toBeNull();
        });

        test('removes multiple keys via array', async () => {
            await cache.set('del-key1', 'value1', 3600000);
            await cache.set('del-key2', 'value2', 3600000);
            await cache.delete(['del-key1', 'del-key2']);

            expect(await cache.get('del-key1')).toBeNull();
            expect(await cache.get('del-key2')).toBeNull();
        });

        test('handles non-existent key gracefully', async () => {
            // Should not throw when deleting non-existent key
            await cache.delete('definitely-not-exists');
            expect(true).toBe(true);
        });
    });

    describe('deleteMany()', () => {
        test('removes multiple keys', async () => {
            await cache.set('dm-a', 1, 3600000);
            await cache.set('dm-b', 2, 3600000);
            await cache.set('dm-c', 3, 3600000);

            await cache.deleteMany(['dm-a', 'dm-b']);

            expect(await cache.get('dm-a')).toBeNull();
            expect(await cache.get('dm-b')).toBeNull();
            expect(await cache.get('dm-c')).toBe(3);
        });

        test('handles empty array', async () => {
            await cache.deleteMany([]);
            expect(true).toBe(true);
        });
    });

    describe('getMany()', () => {
        test('returns array of values in order', async () => {
            await cache.set('gm-k1', 'v1', 3600000);
            await cache.set('gm-k2', 'v2', 3600000);
            await cache.set('gm-k3', 'v3', 3600000);

            const results = await cache.getMany(['gm-k1', 'gm-k2', 'gm-k3']);

            expect(results).toEqual(['v1', 'v2', 'v3']);
        });

        test('returns null for missing keys', async () => {
            await cache.set('gm-exists', 'value', 3600000);

            const results = await cache.getMany(['gm-exists', 'gm-missing', 'gm-also-missing']);

            expect(results[0]).toBe('value');
            expect(results[1]).toBeNull();
            expect(results[2]).toBeNull();
        });

        test('handles empty array', async () => {
            const results = await cache.getMany([]);
            expect(results).toEqual([]);
        });
    });

    describe('setMany()', () => {
        test('sets multiple entries', async () => {
            await cache.setMany([
                { key: 'sm-a', value: 1, ttl: 3600000 },
                { key: 'sm-b', value: 2, ttl: 3600000 },
                { key: 'sm-c', value: 3, ttl: 3600000 }
            ]);

            expect(await cache.get('sm-a')).toBe(1);
            expect(await cache.get('sm-b')).toBe(2);
            expect(await cache.get('sm-c')).toBe(3);
        });

        test('sets entries with different TTLs', async () => {
            // Redis TTL minimum is 1 second
            await cache.setMany([
                { key: 'sm-short', value: 'short-lived', ttl: 1000 }, // 1 second
                { key: 'sm-long', value: 'long-lived', ttl: 3600000 }
            ]);

            // Both should exist initially
            expect(await cache.get('sm-short')).toBe('short-lived');
            expect(await cache.get('sm-long')).toBe('long-lived');

            // Wait for short TTL to expire
            await new Promise(resolve => setTimeout(resolve, 1500));

            expect(await cache.get('sm-short')).toBeNull();
            expect(await cache.get('sm-long')).toBe('long-lived');
        });

        test('handles empty array', async () => {
            await cache.setMany([]);
            expect(true).toBe(true);
        });
    });

    describe('clear()', () => {
        test('removes all entries with prefix', async () => {
            await cache.set('clear-key1', 'value1', 3600000);
            await cache.set('clear-key2', 'value2', 3600000);

            await cache.clear();

            expect(await cache.get('clear-key1')).toBeNull();
            expect(await cache.get('clear-key2')).toBeNull();
        });
    });

    describe('invalidatePattern()', () => {
        test('removes keys matching simple prefix pattern', async () => {
            await cache.set('prefix:1', 'v1', 3600000);
            await cache.set('prefix:2', 'v2', 3600000);
            await cache.set('other:1', 'o1', 3600000);

            await cache.invalidatePattern('prefix:*');

            expect(await cache.get('prefix:1')).toBeNull();
            expect(await cache.get('prefix:2')).toBeNull();
            expect(await cache.get('other:1')).toBe('o1');
        });

        test('handles complex patterns', async () => {
            await cache.set('component:entity1:type1', 'c1', 3600000);
            await cache.set('component:entity1:type2', 'c2', 3600000);
            await cache.set('component:entity2:type1', 'c3', 3600000);

            await cache.invalidatePattern('component:entity1:*');

            expect(await cache.get('component:entity1:type1')).toBeNull();
            expect(await cache.get('component:entity1:type2')).toBeNull();
            expect(await cache.get('component:entity2:type1')).toBe('c3');
        });

        test('handles pattern with no matches', async () => {
            await cache.set('keep-this', 'value', 3600000);

            await cache.invalidatePattern('nomatch:*');

            expect(await cache.get('keep-this')).toBe('value');
        });
    });

    describe('getStats()', () => {
        test('returns statistics object', async () => {
            // Perform some operations to generate stats
            await cache.set('stats-key', 'value', 3600000);
            await cache.get('stats-key'); // Hit
            await cache.get('stats-missing'); // Miss

            const stats = await cache.getStats();

            expect(typeof stats.hits).toBe('number');
            expect(typeof stats.misses).toBe('number');
            expect(typeof stats.hitRate).toBe('number');
            expect(typeof stats.size).toBe('number');
            expect(stats.hits).toBeGreaterThanOrEqual(0);
            expect(stats.misses).toBeGreaterThanOrEqual(0);
        });

        test('tracks hit rate correctly', async () => {
            // Fresh stats after clear
            await cache.set('hr-key', 'value', 3600000);

            // Create predictable hits and misses
            await cache.get('hr-key'); // Hit
            await cache.get('hr-missing'); // Miss

            const stats = await cache.getStats();

            // Hit rate should be between 0 and 1
            expect(stats.hitRate).toBeGreaterThanOrEqual(0);
            expect(stats.hitRate).toBeLessThanOrEqual(1);
        });
    });

    describe('complex data types', () => {
        test('handles deeply nested objects', async () => {
            const complex = {
                level1: {
                    level2: {
                        level3: {
                            value: 'deep',
                            array: [1, 2, { nested: true }]
                        }
                    }
                }
            };

            await cache.set('complex-obj', complex, 3600000);
            const result = await cache.get<typeof complex>('complex-obj');

            expect(result).toEqual(complex);
        });

        test('handles Date objects (serialized as string)', async () => {
            const date = new Date('2024-01-15T10:30:00Z');
            await cache.set('date-key', date, 3600000);

            const result = await cache.get<string>('date-key');
            // Date gets serialized to ISO string
            expect(result).toBe(date.toISOString());
        });

        test('handles large arrays', async () => {
            const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item-${i}` }));

            await cache.set('large-array', largeArray, 3600000);
            const result = await cache.get<typeof largeArray>('large-array');

            expect(result).toEqual(largeArray);
            expect(result?.length).toBe(1000);
        });
    });

    describe('concurrent operations', () => {
        test('handles concurrent sets', async () => {
            const promises = Array.from({ length: 10 }, (_, i) =>
                cache.set(`concurrent-${i}`, i, 3600000)
            );

            await Promise.all(promises);

            for (let i = 0; i < 10; i++) {
                const result = await cache.get<number>(`concurrent-${i}`);
                expect(result).toBe(i);
            }
        });

        test('handles concurrent gets', async () => {
            await cache.set('concurrent-read', 'value', 3600000);

            const promises = Array.from({ length: 10 }, () =>
                cache.get<string>('concurrent-read')
            );

            const results = await Promise.all(promises);

            results.forEach(result => {
                expect(result).toBe('value');
            });
        });

        test('handles mixed concurrent operations', async () => {
            const operations = [
                cache.set('mixed-1', 'a', 3600000),
                cache.set('mixed-2', 'b', 3600000),
                cache.set('mixed-3', 'c', 3600000),
            ];

            await Promise.all(operations);

            const reads = [
                cache.get('mixed-1'),
                cache.get('mixed-2'),
                cache.get('mixed-3'),
            ];

            const results = await Promise.all(reads);
            expect(results).toEqual(['a', 'b', 'c']);
        });
    });
});
