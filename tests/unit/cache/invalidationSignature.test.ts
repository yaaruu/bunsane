import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryCache } from '../../../core/cache/MemoryCache';
import { MultiLevelCache } from '../../../core/cache/MultiLevelCache';
import {
    encodeInvalidationMessage,
    handleRemoteInvalidation,
    invalidationPubSubDecision,
    verifyInvalidationMessage,
} from '../../../core/cache/invalidation';
import { defaultCacheConfig } from '../../../config/cache.config';

const SECRET = 'test-invalidation-secret';

describe('cache invalidation HMAC (SEC-11)', () => {
    const previous = process.env.BUNSANE_CACHE_INVALIDATION_SECRET;

    beforeEach(() => {
        process.env.BUNSANE_CACHE_INVALIDATION_SECRET = SECRET;
    });

    afterEach(() => {
        if (previous === undefined) delete process.env.BUNSANE_CACHE_INVALIDATION_SECRET;
        else process.env.BUNSANE_CACHE_INVALIDATION_SECRET = previous;
    });

    test('unsigned, tampered, and stale messages are dropped', async () => {
        const l1 = new MemoryCache({ cleanupInterval: 60_000 });
        const cache = new MultiLevelCache(l1, null, { ...defaultCacheConfig, enabled: true });
        await l1.set('keep', 'value', 60_000);

        await handleRemoteInvalidation(cache, 'self', JSON.stringify({
            instanceId: 'other',
            type: 'key',
            keys: ['keep'],
        }));
        expect(await l1.get<string>('keep')).toBe('value');

        const signed = encodeInvalidationMessage({
            instanceId: 'other',
            type: 'key',
            keys: ['keep'],
        }, SECRET);
        const tampered = signed.replace(/"sig":"[0-9a-f]/, (m) => m.slice(0, -1) + (m.endsWith('a') ? 'b' : 'a'));
        await handleRemoteInvalidation(cache, 'self', tampered);
        expect(await l1.get<string>('keep')).toBe('value');

        const stale = encodeInvalidationMessage({
            instanceId: 'other',
            type: 'key',
            keys: ['keep'],
        }, SECRET, Date.now() - 60_000);
        expect(verifyInvalidationMessage(stale, SECRET).ok).toBe(false);
        await handleRemoteInvalidation(cache, 'self', stale);
        expect(await l1.get<string>('keep')).toBe('value');

        l1.stopCleanup();
    });

    test('a signed message from another instance invalidates L1', async () => {
        const l1 = new MemoryCache({ cleanupInterval: 60_000 });
        const cache = new MultiLevelCache(l1, null, { ...defaultCacheConfig, enabled: true });
        await l1.set('drop-me', 'value', 60_000);

        const raw = encodeInvalidationMessage({
            instanceId: 'other',
            type: 'key',
            keys: ['drop-me'],
        }, SECRET);
        await handleRemoteInvalidation(cache, 'self', raw);
        expect(await l1.get('drop-me')).toBeNull();

        await l1.set('self-key', 'stay', 60_000);
        const own = encodeInvalidationMessage({
            instanceId: 'self',
            type: 'key',
            keys: ['self-key'],
        }, SECRET);
        await handleRemoteInvalidation(cache, 'self', own);
        expect(await l1.get<string>('self-key')).toBe('stay');

        l1.stopCleanup();
    });

    test('missing secret disables pub/sub instead of crashing', () => {
        delete process.env.BUNSANE_CACHE_INVALIDATION_SECRET;
        expect(invalidationPubSubDecision(true)).toBe('disabled-no-secret');
        expect(invalidationPubSubDecision(false)).toBe('disabled-no-redis');
        process.env.BUNSANE_CACHE_INVALIDATION_SECRET = SECRET;
        expect(invalidationPubSubDecision(true)).toBe('enabled');
    });
});
