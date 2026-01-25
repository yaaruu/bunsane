/**
 * Cache Configuration for BunSane Framework
 */

export interface CacheConfig {
    enabled: boolean;
    provider: 'memory' | 'redis' | 'multilevel' | 'noop';
    defaultTTL: number; // milliseconds
    maxMemory?: number; // bytes for MemoryCache

    redis?: {
        host: string;
        port: number;
        password?: string;
        db?: number;
        keyPrefix?: string;
        retryStrategy?: (times: number) => number | void;
    };

    entity?: {
        enabled: boolean;
        ttl: number;
    };

    component?: {
        enabled: boolean;
        ttl: number;
    };

    query?: {
        enabled: boolean;
        ttl: number;
        maxSize: number;
    };

    strategy: 'write-through' | 'write-invalidate';
}

/**
 * Default cache configuration
 */
export const defaultCacheConfig: CacheConfig = {
    enabled: process.env.CACHE_ENABLED === 'true' || false,
    provider: (process.env.CACHE_PROVIDER as 'memory' | 'redis' | 'multilevel' | 'noop') || 'memory',
    defaultTTL: parseInt(process.env.CACHE_DEFAULT_TTL || '3600000'), // 1 hour
    maxMemory: parseInt(process.env.CACHE_MAX_MEMORY || '104857600'), // 100MB

    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'bunsane:',
        retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    },

    entity: {
        enabled: process.env.CACHE_ENTITY_ENABLED !== 'false', // Default true
        ttl: parseInt(process.env.CACHE_ENTITY_TTL || '3600000') // 1 hour
    },

    component: {
        enabled: process.env.CACHE_COMPONENT_ENABLED !== 'false', // Default true
        ttl: parseInt(process.env.CACHE_COMPONENT_TTL || '1800000') // 30 minutes
    },

    query: {
        enabled: process.env.CACHE_QUERY_ENABLED !== 'false', // Default true
        ttl: parseInt(process.env.CACHE_QUERY_TTL || '1800000'), // 30 minutes
        maxSize: parseInt(process.env.CACHE_QUERY_MAX_SIZE || '10000')
    },

    strategy: (process.env.CACHE_STRATEGY as 'write-through' | 'write-invalidate') || 'write-invalidate'
};