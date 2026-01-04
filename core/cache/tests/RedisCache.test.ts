import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { RedisCache } from '../RedisCache';

// Mock ioredis to avoid needing a real Redis server for basic tests
const mockRedis = {
    on: mock(() => {}),
    get: mock(() => Promise.resolve(null)),
    set: mock(() => Promise.resolve('OK')),
    setex: mock(() => Promise.resolve('OK')),
    del: mock(() => Promise.resolve(1)),
    keys: mock(() => Promise.resolve([])),
    mget: mock(() => Promise.resolve([])),
    mset: mock(() => Promise.resolve('OK')),
    scan: mock(() => Promise.resolve(['0', []])),
    ping: mock(() => Promise.resolve('PONG')),
    dbsize: mock(() => Promise.resolve(0)),
    info: mock(() => Promise.resolve('used_memory:1024\nconnected_clients:1\nredis_version:7.0.0')),
    pipeline: mock(() => ({
        set: mock(function(this: any) { return this; }),
        setex: mock(function(this: any) { return this; }),
        exec: mock(() => Promise.resolve([]))
    })),
    disconnect: mock(() => Promise.resolve()),
    duplicate: mock(() => mockRedis),
    publish: mock(() => Promise.resolve(1)),
    subscribe: mock(() => Promise.resolve()),
    unsubscribe: mock(() => Promise.resolve())
};

// Mock the Redis constructor
mock.module('ioredis', () => ({
    default: mock(() => mockRedis)
}));

describe('RedisCache', () => {
    let cache: RedisCache;

    beforeEach(() => {
        // Reset all mocks
        Object.values(mockRedis).forEach(mockFn => {
            if (typeof mockFn === 'function' && mockFn.mock) {
                mockFn.mockClear();
            }
        });

        cache = new RedisCache({
            host: 'localhost',
            port: 6379,
            keyPrefix: 'test:'
        });
    });

    afterEach(async () => {
        await cache.disconnect();
    });

    describe('Basic Operations', () => {
        it('should set and get a value', async () => {
            mockRedis.get.mockResolvedValueOnce(JSON.stringify('value1'));

            await cache.set('key1', 'value1');
            const result = await cache.get('key1');

            expect(mockRedis.set).toHaveBeenCalledWith('test:key1', JSON.stringify('value1'));
            expect(result).toBe('value1');
        });

        it('should return null for non-existent key', async () => {
            const result = await cache.get('nonexistent');
            expect(result).toBeNull();
        });

        it('should delete a key', async () => {
            await cache.delete('key1');
            expect(mockRedis.del).toHaveBeenCalledWith('test:key1');
        });

        it('should delete multiple keys', async () => {
            await cache.delete(['key1', 'key2']);
            expect(mockRedis.del).toHaveBeenCalledWith('test:key1', 'test:key2');
        });

        it('should clear all keys', async () => {
            mockRedis.keys.mockResolvedValueOnce(['test:key1', 'test:key2']);

            await cache.clear();

            expect(mockRedis.keys).toHaveBeenCalledWith('test:*');
            expect(mockRedis.del).toHaveBeenCalledWith('test:key1', 'test:key2');
        });
    });

    describe('TTL Support', () => {
        it('should set value with TTL', async () => {
            await cache.set('key1', 'value1', 5000); // 5 seconds
            expect(mockRedis.setex).toHaveBeenCalledWith('test:key1', 5, JSON.stringify('value1'));
        });

        it('should set value without TTL', async () => {
            await cache.set('key1', 'value1');
            expect(mockRedis.set).toHaveBeenCalledWith('test:key1', JSON.stringify('value1'));
        });
    });

    describe('Batch Operations', () => {
        it('should get multiple values', async () => {
            mockRedis.mget.mockResolvedValueOnce([
                JSON.stringify('value1'),
                null,
                JSON.stringify('value3')
            ]);

            const result = await cache.getMany(['key1', 'key2', 'key3']);

            expect(mockRedis.mget).toHaveBeenCalledWith('test:key1', 'test:key2', 'test:key3');
            expect(result).toEqual(['value1', null, 'value3']);
        });

        it('should set multiple values', async () => {
            const entries = [
                { key: 'key1', value: 'value1', ttl: 5000 },
                { key: 'key2', value: 'value2' }
            ];

            await cache.setMany(entries);

            expect(mockRedis.pipeline).toHaveBeenCalled();
        });

        it('should delete multiple keys', async () => {
            await cache.deleteMany(['key1', 'key2']);
            expect(mockRedis.del).toHaveBeenCalledWith('test:key1', 'test:key2');
        });
    });

    describe('Pattern Invalidation', () => {
        it('should invalidate keys matching pattern', async () => {
            mockRedis.scan
                .mockResolvedValueOnce(['1', ['test:user:1', 'test:user:2']])
                .mockResolvedValueOnce(['0', ['test:user:3']]);

            await cache.invalidatePattern('user:*');

            expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'test:user:*', 'COUNT', 100);
            expect(mockRedis.del).toHaveBeenCalledWith('test:user:1', 'test:user:2', 'test:user:3');
        });
    });

    describe('Health and Stats', () => {
        it('should ping successfully', async () => {
            const result = await cache.ping();
            expect(result).toBe(true);
            expect(mockRedis.ping).toHaveBeenCalled();
        });

        it('should return stats', async () => {
            const stats = await cache.getStats();

            expect(stats).toHaveProperty('hits');
            expect(stats).toHaveProperty('misses');
            expect(stats).toHaveProperty('hitRate');
            expect(stats).toHaveProperty('size');
            expect(mockRedis.dbsize).toHaveBeenCalled();
        });

        it('should perform health check', async () => {
            const health = await cache.healthCheck();

            expect(health).toHaveProperty('connected');
            expect(health).toHaveProperty('latency');
            expect(health).toHaveProperty('memoryUsage');
            expect(health).toHaveProperty('connections');
            expect(health).toHaveProperty('version');
        });
    });

    describe('Pub/Sub', () => {
        it('should publish invalidation event', async () => {
            await cache.publishInvalidation('channel1', 'message1');
            expect(mockRedis.publish).toHaveBeenCalledWith('channel1', 'message1');
        });

        it('should subscribe to invalidation events', async () => {
            const handler = mock(() => {});
            await cache.subscribeInvalidation('channel1', handler);
            expect(mockRedis.subscribe).toHaveBeenCalledWith('channel1');
        });

        it('should unsubscribe from invalidation events', async () => {
            // First subscribe to set up the subscriber
            const handler = mock(() => {});
            await cache.subscribeInvalidation('channel1', handler);

            // Now unsubscribe
            await cache.unsubscribeInvalidation('channel1');
            expect(mockRedis.unsubscribe).toHaveBeenCalledWith('channel1');
        });
    });

    describe('Key Prefixing', () => {
        it('should prefix keys correctly', async () => {
            await cache.set('mykey', 'myvalue');
            expect(mockRedis.set).toHaveBeenCalledWith('test:mykey', JSON.stringify('myvalue'));
        });
    });

    describe('Error Handling', () => {
        it('should handle get errors gracefully', async () => {
            mockRedis.get.mockRejectedValueOnce(new Error('Connection failed'));

            const result = await cache.get('key1');
            expect(result).toBeNull();
        });

        it('should handle set errors gracefully', async () => {
            mockRedis.set.mockRejectedValueOnce(new Error('Connection failed'));

            await expect(cache.set('key1', 'value1')).resolves.toBeUndefined();
        });

        it('should handle ping errors', async () => {
            mockRedis.ping.mockRejectedValueOnce(new Error('Connection failed'));

            const result = await cache.ping();
            expect(result).toBe(false);
        });
    });
});