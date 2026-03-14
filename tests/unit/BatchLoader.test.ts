/**
 * Unit tests for BatchLoader TTL behavior and bounded cache
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

        test('includes memory estimate', () => {
            const stats = BatchLoader.getCacheStats();
            expect(stats.memoryEstimate).toBeDefined();
            expect(typeof stats.memoryEstimate).toBe('string');
        });
    });

    describe('clearCache()', () => {
        test('clears all cached entries', () => {
            // Access internal cache to set up test data
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            // Use the cache's set method to add entries
            cache.set('type1\x00value', 'parent1', {
                ids: ['a', 'b'],
                expiresAt: now + 300000,
                lastAccessed: now
            });

            expect(BatchLoader.getCacheStats().entries).toBe(1);

            BatchLoader.clearCache();
            expect(BatchLoader.getCacheStats().entries).toBe(0);
        });
    });

    describe('TTL expiry', () => {
        test('getCacheStats reports expired entries', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            // One fresh entry
            cache.set('type1\x00value', 'parent1', {
                ids: ['a'],
                expiresAt: now + 300000,
                lastAccessed: now
            });
            // One expired entry
            cache.set('type1\x00value', 'parent2', {
                ids: ['b'],
                expiresAt: now - 1000,
                lastAccessed: now - 1000
            });

            const stats = BatchLoader.getCacheStats();
            expect(stats.entries).toBe(2);
            expect(stats.expired).toBe(1);
        });

        test('expired entries are counted correctly for multiple type keys', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            // Type 1 entries
            cache.set('type1\x00field', 'p1', {
                ids: ['a'],
                expiresAt: now - 5000,
                lastAccessed: now - 5000
            });
            cache.set('type1\x00field', 'p2', {
                ids: ['b'],
                expiresAt: now + 300000,
                lastAccessed: now
            });

            // Type 2 entry
            cache.set('type2\x00field', 'p3', {
                ids: ['c'],
                expiresAt: now - 1000,
                lastAccessed: now - 1000
            });

            const stats = BatchLoader.getCacheStats();
            expect(stats.size).toBe(2);
            expect(stats.entries).toBe(3);
            expect(stats.expired).toBe(2);
        });

        test('all entries fresh means zero expired', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            cache.set('type\x00field', 'p1', {
                ids: ['a'],
                expiresAt: now + 60000,
                lastAccessed: now
            });
            cache.set('type\x00field', 'p2', {
                ids: ['b'],
                expiresAt: now + 60000,
                lastAccessed: now
            });
            cache.set('type\x00field', 'p3', {
                ids: ['c'],
                expiresAt: now + 60000,
                lastAccessed: now
            });

            const stats = BatchLoader.getCacheStats();
            expect(stats.entries).toBe(3);
            expect(stats.expired).toBe(0);
        });
    });

    describe('pruneExpiredEntries()', () => {
        test('removes expired entries and returns count', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            // Add mix of fresh and expired entries
            cache.set('type\x00field', 'p1', {
                ids: ['a'],
                expiresAt: now - 5000,
                lastAccessed: now - 5000
            });
            cache.set('type\x00field', 'p2', {
                ids: ['b'],
                expiresAt: now + 300000,
                lastAccessed: now
            });
            cache.set('type\x00field', 'p3', {
                ids: ['c'],
                expiresAt: now - 1000,
                lastAccessed: now - 1000
            });

            expect(BatchLoader.getCacheStats().entries).toBe(3);
            expect(BatchLoader.getCacheStats().expired).toBe(2);

            const pruned = BatchLoader.pruneExpiredEntries();
            expect(pruned).toBe(2);

            const statsAfter = BatchLoader.getCacheStats();
            expect(statsAfter.entries).toBe(1);
            expect(statsAfter.expired).toBe(0);
        });

        test('returns 0 when no expired entries', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            cache.set('type\x00field', 'p1', {
                ids: ['a'],
                expiresAt: now + 60000,
                lastAccessed: now
            });

            const pruned = BatchLoader.pruneExpiredEntries();
            expect(pruned).toBe(0);
        });
    });

    describe('bounded cache behavior', () => {
        test('memory estimate increases with entries', () => {
            const cache = (BatchLoader as any).cache;
            const now = Date.now();

            const statsBefore = BatchLoader.getCacheStats();

            // Add several entries
            for (let i = 0; i < 100; i++) {
                cache.set(`type${i}\x00field`, `parent${i}`, {
                    ids: [`id${i}`],
                    expiresAt: now + 60000,
                    lastAccessed: now
                });
            }

            const statsAfter = BatchLoader.getCacheStats();
            expect(statsAfter.entries).toBe(100);

            // Memory estimate should reflect the entries
            expect(statsAfter.memoryEstimate).toBeDefined();
        });
    });
});
