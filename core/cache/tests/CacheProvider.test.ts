import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CacheProvider, CacheStats } from '../CacheProvider';
import { MemoryCache } from '../MemoryCache';
import { NoOpCache } from '../NoOpCache';
import { RedisCache } from '../RedisCache';

/**
 * TASK-049: Unit tests for CacheProvider interface compliance
 * 
 * These tests verify that all CacheProvider implementations correctly
 * implement the interface contract and behave consistently.
 */

describe('CacheProvider Interface Compliance', () => {
    const providers: Array<{ name: string; factory: () => CacheProvider }> = [
        {
            name: 'MemoryCache',
            factory: () => new MemoryCache({ maxSize: 100, defaultTTL: 5000 })
        },
        {
            name: 'NoOpCache',
            factory: () => new NoOpCache()
        }
    ];

    // Add Redis if available
    if (process.env.REDIS_HOST || process.env.TEST_REDIS === 'true') {
        providers.push({
            name: 'RedisCache',
            factory: () => new RedisCache({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                keyPrefix: 'test:compliance:',
                db: 15 // Use separate DB for tests
            })
        });
    }

    providers.forEach(({ name, factory }) => {
        describe(`${name} Compliance`, () => {
            let cache: CacheProvider;

            beforeEach(async () => {
                cache = factory();
                await cache.clear();
            });

            afterEach(async () => {
                await cache.clear();
                if (cache instanceof MemoryCache) {
                    cache.stopCleanup();
                }
                if (cache instanceof RedisCache) {
                    await cache.disconnect();
                }
            });

            describe('Basic Operations', () => {
                it('should implement get() returning null for non-existent keys', async () => {
                    const result = await cache.get('nonexistent');
                    expect(result).toBeNull();
                });

                it('should implement set() and get() for string values', async () => {
                    await cache.set('key1', 'value1');
                    const result = await cache.get('key1');
                    
                    if (name !== 'NoOpCache') {
                        expect(result).toBe('value1');
                    } else {
                        expect(result).toBeNull();
                    }
                });

                it('should implement set() and get() for object values', async () => {
                    const obj = { id: 1, name: 'test', nested: { value: 42 } };
                    await cache.set('key1', obj);
                    const result = await cache.get('key1');
                    
                    if (name !== 'NoOpCache') {
                        expect(result).toEqual(obj);
                    } else {
                        expect(result).toBeNull();
                    }
                });

                it('should implement set() with TTL parameter', async () => {
                    await cache.set('key1', 'value1', 1000);
                    const result = await cache.get('key1');
                    
                    if (name !== 'NoOpCache') {
                        expect(result).toBe('value1');
                    } else {
                        expect(result).toBeNull();
                    }
                });

                it('should implement delete() for single key', async () => {
                    await cache.set('key1', 'value1');
                    await cache.delete('key1');
                    const result = await cache.get('key1');
                    expect(result).toBeNull();
                });

                it('should implement delete() for multiple keys', async () => {
                    await cache.set('key1', 'value1');
                    await cache.set('key2', 'value2');
                    await cache.delete(['key1', 'key2']);
                    
                    const result1 = await cache.get('key1');
                    const result2 = await cache.get('key2');
                    expect(result1).toBeNull();
                    expect(result2).toBeNull();
                });

                it('should implement clear() to remove all entries', async () => {
                    await cache.set('key1', 'value1');
                    await cache.set('key2', 'value2');
                    await cache.clear();
                    
                    const result1 = await cache.get('key1');
                    const result2 = await cache.get('key2');
                    expect(result1).toBeNull();
                    expect(result2).toBeNull();
                });
            });

            describe('Batch Operations', () => {
                it('should implement getMany() for multiple keys', async () => {
                    await cache.set('key1', 'value1');
                    await cache.set('key2', 'value2');
                    await cache.set('key3', 'value3');
                    
                    const results = await cache.getMany(['key1', 'key2', 'key3', 'nonexistent']);
                    
                    if (name !== 'NoOpCache') {
                        expect(results).toHaveLength(4);
                        expect(results[0]).toBe('value1');
                        expect(results[1]).toBe('value2');
                        expect(results[2]).toBe('value3');
                        expect(results[3]).toBeNull();
                    } else {
                        expect(results).toHaveLength(4);
                        expect(results.every(r => r === null)).toBe(true);
                    }
                });

                it('should implement setMany() for multiple entries', async () => {
                    await cache.setMany([
                        { key: 'key1', value: 'value1' },
                        { key: 'key2', value: 'value2' },
                        { key: 'key3', value: 'value3', ttl: 5000 }
                    ]);
                    
                    const results = await cache.getMany(['key1', 'key2', 'key3']);
                    
                    if (name !== 'NoOpCache') {
                        expect(results[0]).toBe('value1');
                        expect(results[1]).toBe('value2');
                        expect(results[2]).toBe('value3');
                    } else {
                        expect(results.every(r => r === null)).toBe(true);
                    }
                });

                it('should implement deleteMany() for multiple keys', async () => {
                    await cache.setMany([
                        { key: 'key1', value: 'value1' },
                        { key: 'key2', value: 'value2' },
                        { key: 'key3', value: 'value3' }
                    ]);
                    
                    await cache.deleteMany(['key1', 'key3']);
                    
                    const results = await cache.getMany(['key1', 'key2', 'key3']);
                    expect(results[0]).toBeNull();
                    
                    if (name !== 'NoOpCache') {
                        expect(results[1]).toBe('value2');
                    } else {
                        expect(results[1]).toBeNull();
                    }
                    
                    expect(results[2]).toBeNull();
                });
            });

            describe('Pattern Operations', () => {
                it('should implement invalidatePattern() for wildcard patterns', async () => {
                    await cache.setMany([
                        { key: 'user:1', value: 'user1' },
                        { key: 'user:2', value: 'user2' },
                        { key: 'post:1', value: 'post1' }
                    ]);
                    
                    await cache.invalidatePattern('user:*');
                    
                    const results = await cache.getMany(['user:1', 'user:2', 'post:1']);
                    expect(results[0]).toBeNull();
                    expect(results[1]).toBeNull();
                    
                    if (name !== 'NoOpCache') {
                        expect(results[2]).toBe('post1');
                    } else {
                        expect(results[2]).toBeNull();
                    }
                });
            });

            describe('Health and Stats', () => {
                it('should implement ping() returning boolean', async () => {
                    const result = await cache.ping();
                    expect(typeof result).toBe('boolean');
                    
                    if (name !== 'NoOpCache') {
                        expect(result).toBe(true);
                    }
                });

                it('should implement getStats() returning CacheStats', async () => {
                    // Perform some operations to generate stats
                    await cache.set('key1', 'value1');
                    await cache.get('key1'); // Hit
                    await cache.get('nonexistent'); // Miss
                    
                    const stats: CacheStats = await cache.getStats();
                    
                    expect(stats).toHaveProperty('hits');
                    expect(stats).toHaveProperty('misses');
                    expect(stats).toHaveProperty('hitRate');
                    expect(stats).toHaveProperty('size');
                    expect(typeof stats.hits).toBe('number');
                    expect(typeof stats.misses).toBe('number');
                    expect(typeof stats.hitRate).toBe('number');
                    expect(typeof stats.size).toBe('number');
                    
                    // Hit rate should be between 0 and 1
                    expect(stats.hitRate).toBeGreaterThanOrEqual(0);
                    expect(stats.hitRate).toBeLessThanOrEqual(1);
                });
            });

            describe('Type Safety', () => {
                it('should handle various data types correctly', async () => {
                    const testCases = [
                        { key: 'string', value: 'test string' },
                        { key: 'number', value: 42 },
                        { key: 'boolean', value: true },
                        { key: 'array', value: [1, 2, 3] },
                        { key: 'object', value: { a: 1, b: 'test' } },
                        { key: 'null', value: null },
                        { key: 'nested', value: { a: { b: { c: [1, 2, 3] } } } }
                    ];

                    for (const testCase of testCases) {
                        await cache.set(testCase.key, testCase.value);
                        const result = await cache.get(testCase.key);
                        
                        if (name !== 'NoOpCache') {
                            if (testCase.value === null) {
                                expect(result).toBeNull();
                            } else {
                                expect(result).toEqual(testCase.value);
                            }
                        } else {
                            expect(result).toBeNull();
                        }
                    }
                });
            });

            describe('Error Handling', () => {
                it('should not throw on operations with invalid keys', async () => {
                    await expect(cache.get('')).resolves.not.toThrow();
                    await expect(cache.set('', 'value')).resolves.not.toThrow();
                    await expect(cache.delete('')).resolves.not.toThrow();
                });

                it('should handle concurrent operations gracefully', async () => {
                    const operations = Array.from({ length: 10 }, (_, i) => 
                        cache.set(`key${i}`, `value${i}`)
                    );
                    
                    await expect(Promise.all(operations)).resolves.not.toThrow();
                });
            });
        });
    });
});
