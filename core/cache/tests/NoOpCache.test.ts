import { describe, it, expect, beforeEach } from 'bun:test';
import { NoOpCache } from '../NoOpCache';

describe('NoOpCache', () => {
    let cache: NoOpCache;

    beforeEach(() => {
        cache = new NoOpCache();
    });

    describe('Basic Operations', () => {
        it('should always return null for get', async () => {
            const result = await cache.get('any-key');
            expect(result).toBeNull();
        });

        it('should not throw on set', async () => {
            await expect(cache.set('key', 'value')).resolves.toBeUndefined();
        });

        it('should not throw on delete', async () => {
            await expect(cache.delete('key')).resolves.toBeUndefined();
            await expect(cache.delete(['key1', 'key2'])).resolves.toBeUndefined();
        });

        it('should not throw on clear', async () => {
            await expect(cache.clear()).resolves.toBeUndefined();
        });
    });

    describe('Batch Operations', () => {
        it('should return array of nulls for getMany', async () => {
            const results = await cache.getMany(['key1', 'key2', 'key3']);
            expect(results).toEqual([null, null, null]);
        });

        it('should not throw on setMany', async () => {
            const entries = [
                { key: 'key1', value: 'value1' },
                { key: 'key2', value: 'value2' }
            ];
            await expect(cache.setMany(entries)).resolves.toBeUndefined();
        });

        it('should not throw on deleteMany', async () => {
            await expect(cache.deleteMany(['key1', 'key2'])).resolves.toBeUndefined();
        });
    });

    describe('Pattern Operations', () => {
        it('should not throw on invalidatePattern', async () => {
            await expect(cache.invalidatePattern('pattern')).resolves.toBeUndefined();
        });
    });

    describe('Health Check', () => {
        it('should always return true for ping', async () => {
            const result = await cache.ping();
            expect(result).toBe(true);
        });
    });

    describe('Statistics', () => {
        it('should return zero statistics', async () => {
            const stats = await cache.getStats();
            expect(stats).toEqual({
                hits: 0,
                misses: 0,
                hitRate: 0,
                size: 0,
                memoryUsage: 0
            });
        });
    });
});