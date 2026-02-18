/**
 * Redis Cache Implementation for BunSane Framework
 * Provides distributed caching with Redis backend
 */

import Redis, { type RedisOptions } from 'ioredis';
import { type CacheProvider, type CacheStats } from './CacheProvider';
import { type CacheConfig } from '../../config/cache.config';
import { logger } from '../Logger';
import { CompressionUtils } from './CompressionUtils';

export interface HealthStatus {
    connected: boolean;
    latency: number;
    memoryUsage?: number;
    connections?: number;
    version?: string;
}

export interface RedisCacheConfig {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    retryStrategy?: (times: number) => number | void;
    maxRetriesPerRequest?: number;
    lazyConnect?: boolean;
    enableReadyCheck?: boolean;
}

/**
 * Redis-based cache implementation with connection pooling and Pub/Sub support
 */
export class RedisCache implements CacheProvider {
    private client: Redis;
    private subscriber?: Redis;
    private publisher?: Redis;
    private config: RedisCacheConfig;
    private keyPrefix: string;
    private stats = {
        hits: 0,
        misses: 0,
        size: 0
    };
    private invalidationHandlers: Map<string, (channel: string, message: string) => void> = new Map();
    private monitoringInterval: Timer | null = null;
    private subscriberListenerAttached = false;

    constructor(config: RedisCacheConfig) {
        this.config = config;
        this.keyPrefix = config.keyPrefix || 'bunsane:';

        const redisOptions: RedisOptions = {
            host: config.host,
            port: config.port,
            password: config.password,
            db: config.db || 0,
            retryStrategy: config.retryStrategy,
            maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
            lazyConnect: config.lazyConnect || false,
            enableReadyCheck: config.enableReadyCheck || false,
            // Connection pooling settings
            enableOfflineQueue: true,
        };

        this.client = new Redis(redisOptions);
        this.setupEventHandlers();
        this.setupMonitoring();
    }

    /**
     * Setup Redis event handlers for connection monitoring
     */
    private setupEventHandlers(): void {
        this.client.on('connect', () => {
            logger.info('Redis cache connected');
        });

        this.client.on('ready', () => {
            logger.info('Redis cache ready');
        });

        this.client.on('error', (error: Error) => {
            logger.error({ error, msg: 'Redis cache error' });
        });

        this.client.on('close', () => {
            logger.warn('Redis cache connection closed');
        });

        this.client.on('reconnecting', (delay: number) => {
            logger.info(`Redis cache reconnecting in ${delay}ms`);
        });
    }

    /**
     * Setup monitoring for memory usage and connection stats
     */
    private setupMonitoring(): void {
        // Log memory usage every 5 minutes
        this.monitoringInterval = setInterval(async () => {
            try {
                const info = await this.client.info('memory');
                const memoryMatch = info.match(/used_memory:(\d+)/);
                if (memoryMatch && memoryMatch[1]) {
                    const memoryUsage = parseInt(memoryMatch[1], 10);
                    logger.debug({ msg: 'Redis memory usage', memoryUsage });
                }
            } catch (error) {
                logger.error({ error, msg: 'Failed to get Redis memory info' });
            }
        }, 300000); // 5 minutes
    }

    /**
     * Get a value from cache
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const prefixedKey = this.prefixKey(key);
            const value = await this.client.get(prefixedKey);

            if (value === null) {
                this.stats.misses++;
                return null;
            }

            this.stats.hits++;
            const parsed = JSON.parse(value);
            return await CompressionUtils.decompress(parsed) as T;
        } catch (error) {
            logger.error({ error, msg: 'Redis get error' });
            this.stats.misses++;
            return null;
        }
    }

    /**
     * Set a value in cache with optional TTL
     */
    async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        try {
            const prefixedKey = this.prefixKey(key);
            const compressedValue = await CompressionUtils.compress(value);
            const serializedValue = JSON.stringify(compressedValue);

            if (ttl) {
                await this.client.setex(prefixedKey, Math.floor(ttl / 1000), serializedValue);
            } else {
                await this.client.set(prefixedKey, serializedValue);
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis set error' });
            // Don't throw - cache failures shouldn't break the app
        }
    }

    /**
     * Delete a key or array of keys from cache
     */
    async delete(key: string | string[]): Promise<void> {
        try {
            const keys = Array.isArray(key) ? key : [key];
            const prefixedKeys = keys.map(k => this.prefixKey(k));

            if (prefixedKeys.length > 0) {
                await this.client.del(...prefixedKeys);
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis delete error' });
        }
    }

    /**
     * Clear all cache entries
     */
    async clear(): Promise<void> {
        try {
            const keys = await this.client.keys(`${this.keyPrefix}*`);
            if (keys.length > 0) {
                await this.client.del(...keys);
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis clear error' });
        }
    }

    /**
     * Get multiple values from cache
     */
    async getMany<T>(keys: string[]): Promise<(T | null)[]> {
        try {
            const prefixedKeys = keys.map(k => this.prefixKey(k));
            const values = await this.client.mget(...prefixedKeys);

            return values.map((value, index) => {
                if (value === null) {
                    this.stats.misses++;
                    return null;
                }
                this.stats.hits++;
                try {
                    return JSON.parse(value) as T;
                } catch (parseError) {
                    logger.error({ error: parseError, key: keys[index], msg: 'Failed to parse cached value' });
                    return null;
                }
            });
        } catch (error) {
            logger.error({ error, msg: 'Redis getMany error' });
            return new Array(keys.length).fill(null);
        }
    }

    /**
     * Set multiple values in cache
     */
    async setMany<T>(entries: Array<{key: string, value: T, ttl?: number}>): Promise<void> {
        try {
            const pipeline = this.client.pipeline();

            for (const entry of entries) {
                const prefixedKey = this.prefixKey(entry.key);
                const serializedValue = JSON.stringify(entry.value);

                if (entry.ttl) {
                    pipeline.setex(prefixedKey, Math.floor(entry.ttl / 1000), serializedValue);
                } else {
                    pipeline.set(prefixedKey, serializedValue);
                }
            }

            await pipeline.exec();
        } catch (error) {
            logger.error({ error, msg: 'Redis setMany error' });
        }
    }

    /**
     * Delete multiple keys from cache
     */
    async deleteMany(keys: string[]): Promise<void> {
        try {
            const prefixedKeys = keys.map(k => this.prefixKey(k));
            if (prefixedKeys.length > 0) {
                await this.client.del(...prefixedKeys);
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis deleteMany error' });
        }
    }

    /**
     * Invalidate keys matching a pattern using SCAN to avoid blocking
     */
    async invalidatePattern(pattern: string): Promise<void> {
        try {
            const prefixedPattern = this.prefixKey(pattern);
            let cursor = '0';
            const keysToDelete: string[] = [];

            do {
                const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', prefixedPattern, 'COUNT', 100);
                cursor = newCursor;
                keysToDelete.push(...keys);
            } while (cursor !== '0');

            if (keysToDelete.length > 0) {
                await this.client.del(...keysToDelete);
                logger.debug({ pattern, count: keysToDelete.length, msg: `Invalidated ${keysToDelete.length} keys matching pattern` });
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis invalidatePattern error' });
        }
    }

    /**
     * Check if Redis is reachable
     */
    async ping(): Promise<boolean> {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        } catch (error) {
            logger.error({ error, msg: 'Redis ping error' });
            return false;
        }
    }

    /**
     * Get cache statistics
     */
    async getStats(): Promise<CacheStats> {
        try {
            // Get approximate key count using DBSIZE
            const size = await this.client.dbsize();

            // Get memory usage
            const info = await this.client.info('memory');
            const memoryMatch = info.match(/used_memory:(\d+)/);
            const memoryUsage = memoryMatch && memoryMatch[1] ? parseInt(memoryMatch[1], 10) : undefined;

            return {
                hits: this.stats.hits,
                misses: this.stats.misses,
                hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
                size,
                memoryUsage
            };
        } catch (error) {
            logger.error({ error, msg: 'Redis getStats error' });
            return {
                hits: this.stats.hits,
                misses: this.stats.misses,
                hitRate: 0,
                size: 0
            };
        }
    }

    /**
     * Perform health check with detailed status
     */
    async healthCheck(): Promise<HealthStatus> {
        const startTime = Date.now();

        try {
            const pingResult = await this.ping();
            const latency = Date.now() - startTime;

            if (!pingResult) {
                return {
                    connected: false,
                    latency
                };
            }

            // Get additional health info
            const info = await this.client.info();
            const memoryMatch = info.match(/used_memory:(\d+)/);
            const memoryUsage = memoryMatch && memoryMatch[1] ? parseInt(memoryMatch[1], 10) : undefined;

            const connectionsMatch = info.match(/connected_clients:(\d+)/);
            const connections = connectionsMatch && connectionsMatch[1] ? parseInt(connectionsMatch[1], 10) : undefined;

            const versionMatch = info.match(/redis_version:([^\r\n]+)/);
            const version = versionMatch ? versionMatch[1] : undefined;

            return {
                connected: true,
                latency,
                memoryUsage,
                connections,
                version
            };
        } catch (error) {
            logger.error({ error, msg: 'Redis health check error' });
            return {
                connected: false,
                latency: Date.now() - startTime
            };
        }
    }

    /**
     * Publish cache invalidation event
     */
    async publishInvalidation(channel: string, message: string): Promise<void> {
        try {
            if (!this.publisher) {
                this.publisher = this.client.duplicate();
            }
            await this.publisher.publish(channel, message);
        } catch (error) {
            logger.error({ error, msg: 'Redis publish invalidation error' });
        }
    }

    /**
     * Subscribe to cache invalidation events
     */
    async subscribeInvalidation(channel: string, handler: (channel: string, message: string) => void): Promise<void> {
        try {
            if (!this.subscriber) {
                this.subscriber = this.client.duplicate();
            }

            this.invalidationHandlers.set(channel, handler);
            await this.subscriber.subscribe(channel);

            // Only attach the message listener once to avoid stacking
            if (!this.subscriberListenerAttached) {
                this.subscriberListenerAttached = true;
                this.subscriber.on('message', (receivedChannel, message) => {
                    this.handleInvalidationEvent(receivedChannel, message);
                });
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis subscribe invalidation error' });
        }
    }

    /**
     * Unsubscribe from cache invalidation events
     */
    async unsubscribeInvalidation(channel: string): Promise<void> {
        try {
            if (this.subscriber) {
                await this.subscriber.unsubscribe(channel);
                this.invalidationHandlers.delete(channel);
            }
        } catch (error) {
            logger.error({ error, msg: 'Redis unsubscribe invalidation error' });
        }
    }

    /**
     * Handle incoming invalidation events
     */
    private handleInvalidationEvent(channel: string, message: string): void {
        try {
            const handler = this.invalidationHandlers.get(channel);
            if (handler) {
                handler(channel, message);
            }
        } catch (error) {
            logger.error({ error, msg: 'Error handling invalidation event' });
        }
    }

    /**
     * Prefix a key with the configured prefix
     */
    private prefixKey(key: string): string {
        return `${this.keyPrefix}${key}`;
    }

    /**
     * Close all Redis connections
     */
    async disconnect(): Promise<void> {
        try {
            if (this.monitoringInterval) {
                clearInterval(this.monitoringInterval);
                this.monitoringInterval = null;
            }

            await this.client.disconnect();

            if (this.subscriber) {
                await this.subscriber.disconnect();
            }

            if (this.publisher) {
                await this.publisher.disconnect();
            }

            logger.info('Redis cache disconnected');
        } catch (error) {
            logger.error({ error, msg: 'Redis disconnect error' });
        }
    }
}