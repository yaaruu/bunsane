import { describe, test, expect, afterEach } from 'bun:test';
import { MemoryCache } from '../../../core/cache/MemoryCache';
import {
    assertScopedInvalidatePattern,
    collectScanKeys,
    CacheInvalidateCapExceededError,
} from '../../../core/cache/invalidateBounds';

describe('pattern invalidation bounds (SEC-13)', () => {
    const previous = process.env.BUNSANE_CACHE_INVALIDATE_MAX;

    afterEach(() => {
        if (previous === undefined) delete process.env.BUNSANE_CACHE_INVALIDATE_MAX;
        else process.env.BUNSANE_CACHE_INVALIDATE_MAX = previous;
    });

    test('MemoryCache glob does not catastrophically backtrack', async () => {
        const cache = new MemoryCache({ cleanupInterval: 60_000 });
        const hostile = 'a'.repeat(20_000);
        await cache.set(hostile, 'kept', 60_000);
        const start = Date.now();
        await cache.invalidatePattern('*a*a*a*a*b');
        expect(Date.now() - start).toBeLessThan(250);
        expect(await cache.get<string>(hostile)).toBe('kept');
        cache.stopCleanup();
    });

    test('MemoryCache aborts at the cap without deleting', async () => {
        process.env.BUNSANE_CACHE_INVALIDATE_MAX = '2';
        const cache = new MemoryCache({ cleanupInterval: 60_000 });
        await cache.set('a', 1, 60_000);
        await cache.set('b', 2, 60_000);
        await cache.set('c', 3, 60_000);
        await expect(cache.invalidatePattern('*')).rejects.toBeInstanceOf(CacheInvalidateCapExceededError);
        expect(await cache.get<number>('a')).toBe(1);
        expect(await cache.get<number>('b')).toBe(2);
        expect(await cache.get<number>('c')).toBe(3);
        cache.stopCleanup();
    });

    test('unprefixed Redis MATCH is rejected', () => {
        expect(() => assertScopedInvalidatePattern('*')).toThrow(/literal key prefix/);
        expect(() => assertScopedInvalidatePattern('bunsane:*')).not.toThrow();
    });

    test('SCAN collector errors at the cap instead of returning a partial wipe set', async () => {
        let pages = 0;
        await expect(collectScanKeys(async (cursor) => {
            pages++;
            // Would continue forever if the collector did not stop at the cap.
            return { cursor: cursor === '0' ? '1' : String(Number(cursor) + 1), keys: ['k' + pages] };
        }, 3, '*')).rejects.toBeInstanceOf(CacheInvalidateCapExceededError);
        expect(pages).toBeLessThan(10);
    });
});
