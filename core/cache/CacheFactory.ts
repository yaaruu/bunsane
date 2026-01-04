import { type CacheProvider } from './CacheProvider';
import { MemoryCache, type MemoryCacheConfig } from './MemoryCache';
import { NoOpCache } from './NoOpCache';
import { RedisCache, type RedisCacheConfig } from './RedisCache';
import { MultiLevelCache } from './MultiLevelCache';
import { type CacheConfig } from '../../config/cache.config';
import { logger } from '../Logger';

/**
 * Factory for creating cache provider instances based on configuration
 */
export class CacheFactory {
    /**
     * Create a cache provider instance based on the configuration
     */
    public static create(config: CacheConfig): CacheProvider {
        if (!config.enabled) {
            logger.debug('Cache disabled, using NoOpCache');
            return new NoOpCache();
        }

        switch (config.provider) {
            case 'memory':
                return this.createMemoryCache(config);
            case 'redis':
                return this.createRedisCache(config);
            case 'multilevel':
                return this.createMultiLevelCache(config);
            case 'noop':
                return new NoOpCache();
            default:
                logger.warn(`Unknown cache provider '${config.provider}', falling back to MemoryCache`);
                return this.createMemoryCache(config);
        }
    }

    /**
     * Create a MemoryCache instance with the given configuration
     */
    private static createMemoryCache(config: CacheConfig): MemoryCache {
        const memoryConfig: MemoryCacheConfig = {
            maxSize: config.query?.maxSize ?? 10000,
            maxMemory: config.maxMemory,
            defaultTTL: config.defaultTTL,
            cleanupInterval: 60000 // 1 minute cleanup interval
        };

        logger.debug({ msg: 'Creating MemoryCache', config: memoryConfig });
        return new MemoryCache(memoryConfig);
    }

    /**
     * Create a RedisCache instance with the given configuration
     */
    private static createRedisCache(config: CacheConfig): RedisCache {
        if (!config.redis) {
            throw new Error('Redis configuration is required for Redis cache provider');
        }

        const redisConfig: RedisCacheConfig = {
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
            keyPrefix: config.redis.keyPrefix,
            retryStrategy: config.redis.retryStrategy,
            maxRetriesPerRequest: 3,
            lazyConnect: false,
            enableReadyCheck: true
        };

        logger.debug({ msg: 'Creating RedisCache', config: redisConfig });
        return new RedisCache(redisConfig);
    }

    /**
     * Create a MultiLevelCache instance with the given configuration
     */
    private static createMultiLevelCache(config: CacheConfig): MultiLevelCache {
        // Create L1 (Memory) cache
        const l1Cache = this.createMemoryCache(config);

        // Create L2 (Redis) cache if Redis config is available
        let l2Cache: RedisCache | null = null;
        if (config.redis) {
            l2Cache = this.createRedisCache(config);
        } else {
            logger.warn('MultiLevel cache requested but no Redis config provided, using Memory-only cache');
        }

        logger.debug({ msg: 'Creating MultiLevelCache', hasL2: !!l2Cache });
        return new MultiLevelCache(l1Cache, l2Cache, config);
    }

    /**
     * Validate cache configuration
     */
    public static validateConfig(config: CacheConfig): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (config.defaultTTL < 0) {
            errors.push('defaultTTL must be non-negative');
        }

        if (config.maxMemory && config.maxMemory < 0) {
            errors.push('maxMemory must be non-negative');
        }

        if (config.entity?.ttl && config.entity.ttl < 0) {
            errors.push('entity.ttl must be non-negative');
        }

        if (config.component?.ttl && config.component.ttl < 0) {
            errors.push('component.ttl must be non-negative');
        }

        if (config.query?.ttl && config.query.ttl < 0) {
            errors.push('query.ttl must be non-negative');
        }

        if (config.query?.maxSize && config.query.maxSize < 0) {
            errors.push('query.maxSize must be non-negative');
        }

        if (config.redis) {
            if (config.redis.port < 1 || config.redis.port > 65535) {
                errors.push('redis.port must be between 1 and 65535');
            }

            if (config.redis.db && (config.redis.db < 0 || config.redis.db > 15)) {
                errors.push('redis.db must be between 0 and 15');
            }

            if (config.provider === 'redis' && !config.redis.host) {
                errors.push('redis.host is required when using redis provider');
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}