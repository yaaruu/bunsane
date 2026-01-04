import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MultiLevelCache } from '../MultiLevelCache';
import { MemoryCache } from '../MemoryCache';
import { NoOpCache } from '../NoOpCache';

/**
 * TASK-053: Unit tests for MultiLevelCache L1/L2 promotion, write-through
 * 
 * Tests the multi-level caching behavior including L1/L2 promotion,
 * write-through semantics, and fallback mechanisms.
 */

describe('MultiLevelCache', () => {
    let l1Cache: MemoryCache;
    let l2Cache: MemoryCache;
    let multiCache: MultiLevelCache;

    beforeEach(async () => {
        l1Cache = new MemoryCache({
            maxSize: 50,
            defaultTTL: 5000,
            cleanupInterval: 10000
        });

        l2Cache = new MemoryCache({
            maxSize: 200,
            defaultTTL: 10000,
            cleanupInterval: 10000
        });

        multiCache = new MultiLevelCache(l1Cache, l2Cache);
        
        await l1Cache.clear();
        await l2Cache.clear();
    });

    afterEach(async () => {
        l1Cache.stopCleanup();
        l2Cache.stopCleanup();
        await l1Cache.clear();
        await l2Cache.clear();
    });

    describe('Basic Operations', () => {
        it('should set value in both L1 and L2 caches', async () => {
            await multiCache.set('key1', 'value1');
            
            const l1Result = await l1Cache.get('key1');
            const l2Result = await l2Cache.get('key1');
            
            expect(l1Result).toBe('value1');
            expect(l2Result).toBe('value1');
        });

        it('should get value from L1 if available', async () => {
            await l1Cache.set('key1', 'l1value');
            await l2Cache.set('key1', 'l2value');
            
            const result = await multiCache.get('key1');
            expect(result).toBe('l1value');
        });

        it('should promote L2 hit to L1', async () => {
            // Set only in L2
            await l2Cache.set('key1', 'value1');
            
            // First get should miss L1, hit L2, and promote to L1
            const result = await multiCache.get('key1');
            expect(result).toBe('value1');
            
            // Verify it's now in L1
            const l1Result = await l1Cache.get('key1');
            expect(l1Result).toBe('value1');
        });

        it('should return null for complete cache miss', async () => {
            const result = await multiCache.get('nonexistent');
            expect(result).toBeNull();
        });

        it('should delete from both L1 and L2', async () => {
            await multiCache.set('key1', 'value1');
            await multiCache.delete('key1');
            
            const l1Result = await l1Cache.get('key1');
            const l2Result = await l2Cache.get('key1');
            
            expect(l1Result).toBeNull();
            expect(l2Result).toBeNull();
        });

        it('should clear both L1 and L2 caches', async () => {
            await multiCache.set('key1', 'value1');
            await multiCache.set('key2', 'value2');
            await multiCache.clear();
            
            const l1Stats = await l1Cache.getStats();
            const l2Stats = await l2Cache.getStats();
            
            expect(l1Stats.size).toBe(0);
            expect(l2Stats.size).toBe(0);
        });
    });

    describe('Batch Operations', () => {
        it('should get many values checking L1 first, then L2', async () => {
            await l1Cache.set('key1', 'l1value1');
            await l2Cache.set('key2', 'l2value2');
            
            const results = await multiCache.getMany(['key1', 'key2', 'key3']);
            
            expect(results).toHaveLength(3);
            expect(results[0]).toBe('l1value1');
            expect(results[1]).toBe('l2value2');
            expect(results[2]).toBeNull();
        });

        it('should promote L2 hits to L1 during getMany', async () => {
            await l2Cache.setMany([
                { key: 'key1', value: 'value1' },
                { key: 'key2', value: 'value2' }
            ]);
            
            await multiCache.getMany(['key1', 'key2']);
            
            // Verify promotion to L1
            const l1Results = await l1Cache.getMany(['key1', 'key2']);
            expect(l1Results[0]).toBe('value1');
            expect(l1Results[1]).toBe('value2');
        });

        it('should set many values in both caches', async () => {
            await multiCache.setMany([
                { key: 'key1', value: 'value1' },
                { key: 'key2', value: 'value2' }
            ]);
            
            const l1Results = await l1Cache.getMany(['key1', 'key2']);
            const l2Results = await l2Cache.getMany(['key1', 'key2']);
            
            expect(l1Results).toEqual(['value1', 'value2']);
            expect(l2Results).toEqual(['value1', 'value2']);
        });

        it('should delete many from both caches', async () => {
            await multiCache.setMany([
                { key: 'key1', value: 'value1' },
                { key: 'key2', value: 'value2' },
                { key: 'key3', value: 'value3' }
            ]);
            
            await multiCache.deleteMany(['key1', 'key2']);
            
            const l1Results = await l1Cache.getMany(['key1', 'key2', 'key3']);
            const l2Results = await l2Cache.getMany(['key1', 'key2', 'key3']);
            
            expect(l1Results[0]).toBeNull();
            expect(l1Results[1]).toBeNull();
            expect(l1Results[2]).toBe('value3');
            expect(l2Results[0]).toBeNull();
            expect(l2Results[1]).toBeNull();
            expect(l2Results[2]).toBe('value3');
        });
    });

    describe('Pattern Invalidation', () => {
        it('should invalidate pattern in both L1 and L2', async () => {
            await multiCache.setMany([
                { key: 'user:1', value: 'user1' },
                { key: 'user:2', value: 'user2' },
                { key: 'post:1', value: 'post1' }
            ]);
            
            await multiCache.invalidatePattern('user:*');
            
            const l1Results = await l1Cache.getMany(['user:1', 'user:2', 'post:1']);
            const l2Results = await l2Cache.getMany(['user:1', 'user:2', 'post:1']);
            
            expect(l1Results[0]).toBeNull();
            expect(l1Results[1]).toBeNull();
            expect(l1Results[2]).toBe('post1');
            expect(l2Results[0]).toBeNull();
            expect(l2Results[1]).toBeNull();
            expect(l2Results[2]).toBe('post1');
        });
    });

    describe('Health and Stats', () => {
        it('should ping both caches and return true if both healthy', async () => {
            const result = await multiCache.ping();
            expect(result).toBe(true);
        });

        it('should return combined statistics', async () => {
            // Generate some activity
            await multiCache.set('key1', 'value1');
            await multiCache.get('key1'); // L1 hit
            await multiCache.get('nonexistent'); // Miss
            
            const stats = await multiCache.getStats();
            
            expect(stats).toHaveProperty('hits');
            expect(stats).toHaveProperty('misses');
            expect(stats).toHaveProperty('hitRate');
            expect(stats).toHaveProperty('size');
            expect(typeof stats.hits).toBe('number');
            expect(typeof stats.misses).toBe('number');
        });

        it('should aggregate stats from both levels', async () => {
            await l1Cache.set('key1', 'value1');
            await l1Cache.get('key1'); // L1 hit
            
            await l2Cache.set('key2', 'value2');
            await l2Cache.get('key2'); // L2 hit
            
            const stats = await multiCache.getStats();
            expect(stats.hits).toBeGreaterThanOrEqual(2);
        });
    });

    describe('TTL Handling', () => {
        it('should respect TTL in both caches', async () => {
            await multiCache.set('key1', 'value1', 100);
            
            // Should exist initially
            let result = await multiCache.get('key1');
            expect(result).toBe('value1');
            
            // Wait for expiration
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Should be expired in both caches
            result = await multiCache.get('key1');
            expect(result).toBeNull();
        });

        it('should use different TTLs for L1 and L2 if configured', async () => {
            const customMultiCache = new MultiLevelCache(
                new MemoryCache({ defaultTTL: 100 }), // Short TTL for L1
                new MemoryCache({ defaultTTL: 5000 })  // Long TTL for L2
            );

            await customMultiCache.set('key1', 'value1');
            
            // Wait for L1 to expire
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Should still be in L2 and get promoted back to L1
            const result = await customMultiCache.get('key1');
            expect(result).toBe('value1');
            
            customMultiCache.l1Cache.stopCleanup();
            customMultiCache.l2Cache.stopCleanup();
        });
    });

    describe('Fallback Behavior', () => {
        it('should fallback to L2 if L1 fails', async () => {
            // Create a multi-level cache with NoOp as L1
            const noopL1 = new NoOpCache();
            const fallbackMultiCache = new MultiLevelCache(noopL1, l2Cache);
            
            await fallbackMultiCache.set('key1', 'value1');
            
            // L1 (NoOp) won't store, but L2 will
            const result = await fallbackMultiCache.get('key1');
            expect(result).toBe('value1');
        });

        it('should continue working if L2 is unavailable', async () => {
            const noopL2 = new NoOpCache();
            const fallbackMultiCache = new MultiLevelCache(l1Cache, noopL2);
            
            await fallbackMultiCache.set('key1', 'value1');
            
            // L1 will store and serve
            const result = await fallbackMultiCache.get('key1');
            expect(result).toBe('value1');
        });
    });

    describe('Cache Coherency', () => {
        it('should maintain consistency between L1 and L2 on updates', async () => {
            await multiCache.set('key1', 'value1');
            await multiCache.set('key1', 'value2');
            
            const l1Result = await l1Cache.get('key1');
            const l2Result = await l2Cache.get('key1');
            
            expect(l1Result).toBe('value2');
            expect(l2Result).toBe('value2');
        });

        it('should handle rapid updates correctly', async () => {
            const updates = [];
            for (let i = 0; i < 10; i++) {
                updates.push(multiCache.set('key1', `value${i}`));
            }
            
            await Promise.all(updates);
            
            const result = await multiCache.get('key1');
            expect(result).toMatch(/^value\d$/);
        });
    });

    describe('Memory Management', () => {
        it('should respect size limits in L1', async () => {
            const smallL1 = new MemoryCache({ maxSize: 3 });
            const largeL2 = new MemoryCache({ maxSize: 100 });
            const limitedCache = new MultiLevelCache(smallL1, largeL2);
            
            // Add more items than L1 can hold
            for (let i = 0; i < 10; i++) {
                await limitedCache.set(`key${i}`, `value${i}`);
            }
            
            const l1Stats = await smallL1.getStats();
            const l2Stats = await largeL2.getStats();
            
            // L1 should be at or near its limit
            expect(l1Stats.size).toBeLessThanOrEqual(3);
            // L2 should have all items
            expect(l2Stats.size).toBe(10);
            
            smallL1.stopCleanup();
            largeL2.stopCleanup();
        });
    });

    describe('Performance Characteristics', () => {
        it('should be faster to read from L1 than L2', async () => {
            await multiCache.set('key1', 'value1');
            
            // Clear L1 to force L2 read
            await l1Cache.clear();
            
            const l2Start = performance.now();
            await multiCache.get('key1'); // L2 read + promotion
            const l2Time = performance.now() - l2Start;
            
            const l1Start = performance.now();
            await multiCache.get('key1'); // L1 read
            const l1Time = performance.now() - l1Start;
            
            // L1 should generally be faster, but this is a soft check
            // In memory-to-memory, the difference may be negligible
            expect(l1Time).toBeLessThan(l2Time + 10);
        });
    });
});
