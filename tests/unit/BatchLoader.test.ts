/**
 * Unit tests for BatchLoader TTL behavior
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { BatchLoader } from '../../core/BatchLoader';

describe('BatchLoader', () => {
    beforeEach(() => {
        BatchLoader.clearCache();
    });

    describe('getCacheStats()', () => {
        test('returns zero stats when cache is empty', () => {
            const stats = BatchLoader.getCacheStats();
            expect(stats.size).toBe(0);
            expect(stats.entries).toBe(0);
            expect(stats.expired).toBe(0);
        });
    });

    describe('clearCache()', () => {
        test('clears all cached entries', () => {
            // Access internal cache via any to set up test data
            const cache = (BatchLoader as any).cache as Map<string, Map<string, any>>;
            const innerMap = new Map();
            innerMap.set('parent1', { ids: ['a', 'b'], expiresAt: Date.now() + 300000 });
            cache.set('type1:value', innerMap);

            expect(BatchLoader.getCacheStats().entries).toBe(1);

            BatchLoader.clearCache();
            expect(BatchLoader.getCacheStats().entries).toBe(0);
        });
    });

    describe('TTL expiry', () => {
        test('getCacheStats reports expired entries', () => {
            const cache = (BatchLoader as any).cache as Map<string, Map<string, any>>;
            const innerMap = new Map();
            // One fresh entry
            innerMap.set('parent1', { ids: ['a'], expiresAt: Date.now() + 300000 });
            // One expired entry
            innerMap.set('parent2', { ids: ['b'], expiresAt: Date.now() - 1000 });
            cache.set('type1:value', innerMap);

            const stats = BatchLoader.getCacheStats();
            expect(stats.entries).toBe(2);
            expect(stats.expired).toBe(1);
        });

        test('expired entries are counted correctly for multiple type keys', () => {
            const cache = (BatchLoader as any).cache as Map<string, Map<string, any>>;

            const map1 = new Map();
            map1.set('p1', { ids: ['a'], expiresAt: Date.now() - 5000 });
            map1.set('p2', { ids: ['b'], expiresAt: Date.now() + 300000 });
            cache.set('type1:field', map1);

            const map2 = new Map();
            map2.set('p3', { ids: ['c'], expiresAt: Date.now() - 1000 });
            cache.set('type2:field', map2);

            const stats = BatchLoader.getCacheStats();
            expect(stats.size).toBe(2);
            expect(stats.entries).toBe(3);
            expect(stats.expired).toBe(2);
        });

        test('all entries fresh means zero expired', () => {
            const cache = (BatchLoader as any).cache as Map<string, Map<string, any>>;
            const innerMap = new Map();
            innerMap.set('p1', { ids: ['a'], expiresAt: Date.now() + 60000 });
            innerMap.set('p2', { ids: ['b'], expiresAt: Date.now() + 60000 });
            innerMap.set('p3', { ids: ['c'], expiresAt: Date.now() + 60000 });
            cache.set('type:field', innerMap);

            const stats = BatchLoader.getCacheStats();
            expect(stats.entries).toBe(3);
            expect(stats.expired).toBe(0);
        });
    });
});
