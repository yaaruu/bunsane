import { type CacheProvider } from './CacheProvider';
import { type CacheConfig, defaultCacheConfig } from '../../config/cache.config';
import { CacheFactory } from './CacheFactory';
import { MultiLevelCache } from './MultiLevelCache';
import { logger } from '../Logger';
import type { Entity } from '../Entity';
import type { BaseComponent } from '../components';
import type { ComponentData } from '../RequestLoaders';
import {
    getEntity as _getEntity,
    setEntityWriteThrough as _setEntityWriteThrough,
    getEntities as _getEntities,
    setEntitiesWriteThrough as _setEntitiesWriteThrough,
    getComponentsByEntity as _getComponentsByEntity,
    setComponentWriteThrough as _setComponentWriteThrough,
    setComponentsBatchWriteThrough as _setComponentsBatchWriteThrough,
    getComponents as _getComponents,
    setComponentsWriteThrough as _setComponentsWriteThrough,
} from './strategies/writeThrough';
import {
    invalidateEntity as _invalidateEntity,
    invalidateEntities as _invalidateEntities,
    invalidateAllEntityComponents as _invalidateAllEntityComponents,
    invalidateComponent as _invalidateComponent,
    invalidateComponents as _invalidateComponents,
    invalidateEntityComponents as _invalidateEntityComponents,
} from './strategies/writeInvalidate';
import {
    setupPubSub as _setupPubSub,
    handleRemoteInvalidation as _handleRemoteInvalidation,
    publishInvalidation as _publishInvalidation,
} from './invalidation';
import {
    getStats as _getStats,
    ping as _ping,
} from './health';

/**
 * Sentinel value written to the cache to record "known absent" lookups.
 * String literal (not object) so it round-trips cleanly through
 * JSON.stringify in RedisCache + CompressionUtils. Callers must treat it
 * as a cache hit but propagate a `null`/`[]` upstream.
 */
export const COMPONENT_TOMBSTONE = '__TOMBSTONE__' as const;
export const RELATION_TOMBSTONE = '__TOMBSTONE__' as const;
export type ComponentCacheValue = ComponentData | typeof COMPONENT_TOMBSTONE;

/**
 * High-level cache operations manager
 * Singleton that provides entity and component caching methods
 * Note: Query-level caching has been removed in favor of component-level caching only
 */
export class CacheManager {
    private static instance: CacheManager;
    private provider: CacheProvider;
    private config: Readonly<CacheConfig>;
    private instanceId = crypto.randomUUID();
    private pubSubEnabled = false;

    private constructor() {
        this.config = Object.freeze({ ...defaultCacheConfig });
        this.provider = CacheFactory.create(this.config);
    }

    public static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    /**
     * Initialize or reinitialize the cache manager with new config
     */
    public async initialize(config: Partial<CacheConfig>): Promise<void> {
        // Shutdown old provider before replacing
        await this.shutdownProvider();
        this.pubSubEnabled = false;

        this.config = Object.freeze({ ...defaultCacheConfig, ...config });
        this.provider = CacheFactory.create(this.config);

        await this.setupPubSub();

        logger.info({ scope: 'cache', component: 'CacheManager', msg: 'CacheManager initialized', provider: this.config.provider, enabled: this.config.enabled });
    }

    /**
     * Get the current cache configuration.
     * Config is frozen once set so callers may hold the reference safely.
     */
    public getConfig(): Readonly<CacheConfig> {
        return this.config;
    }

    /**
     * Get the current cache provider
     */
    public getProvider(): CacheProvider {
        return this.provider;
    }

    // Entity caching methods

    /**
     * Get an entity existence check from cache
     * Returns entity ID if exists, null if not found
     */
    public async getEntity(id: string): Promise<string | null> {
        return _getEntity(this.provider, this.config, id);
    }

    /**
     * Set an entity existence in cache with write-through strategy
     * Only caches entity ID for existence tracking, not full entity data
     */
    public async setEntityWriteThrough(entity: Entity, ttl?: number): Promise<void> {
        return _setEntityWriteThrough(this.provider, this.config, entity, ttl);
    }

    /**
     * Invalidate an entity from cache
     */
    public async invalidateEntity(id: string): Promise<void> {
        return _invalidateEntity(this.provider, this.config, this._publishInvalidation.bind(this), id);
    }

    /**
     * Get multiple entity existence checks from cache (for DataLoader integration)
     * Returns entity IDs if they exist, null if not found
     */
    public async getEntities(ids: string[]): Promise<(string | null)[]> {
        return _getEntities(this.provider, this.config, ids);
    }

    /**
     * Set multiple entity existences in cache with write-through strategy (for DataLoader integration)
     * Only caches entity IDs for existence tracking, not full entity data
     */
    public async setEntitiesWriteThrough(entities: Entity[], ttl?: number): Promise<void> {
        return _setEntitiesWriteThrough(this.provider, this.config, entities, ttl);
    }

    // Component caching methods

    /**
     * Get components for an entity from cache
     */
    public async getComponentsByEntity(entityId: string, componentType?: string): Promise<BaseComponent[] | null> {
        return _getComponentsByEntity(this.provider, this.config, entityId, componentType);
    }

    /**
     * Set components for an entity in cache with write-through strategy.
     * Converts BaseComponent instances to ComponentData format for cache compatibility with DataLoader.
     * Delegates to setComponentsBatchWriteThrough for a single-entity, 2-RTT batch.
     */
    public async setComponentWriteThrough(entityId: string, components: BaseComponent[], componentType?: string, ttl?: number): Promise<void> {
        return _setComponentWriteThrough(this.provider, this.config, entityId, components, componentType, ttl);
    }

    /**
     * Batch write-through for BaseComponent instances across any number of
     * entities. Performs exactly 2 Redis round-trips regardless of entry count:
     *   1. pipelined getMany  — reads existing entries to preserve createdAt (H-CACHE-3)
     *   2. pipelined setMany  — writes all updated entries
     *
     * Signature:
     *   setComponentsBatchWriteThrough(
     *     entries: Array<{ entityId: string; typeId: string; component: BaseComponent; ttl?: number }>
     *   ): Promise<void>
     */
    public async setComponentsBatchWriteThrough(
        entries: Array<{ entityId: string; typeId: string; component: BaseComponent; ttl?: number }>,
    ): Promise<void> {
        return _setComponentsBatchWriteThrough(this.provider, this.config, entries);
    }

    /**
     * Invalidate a specific component for an entity from cache
     * More granular than invalidateComponents which can invalidate all components
     */
    public async invalidateComponent(entityId: string, typeId: string): Promise<void> {
        return _invalidateComponent(this.provider, this.config, this._publishInvalidation.bind(this), entityId, typeId);
    }

    /**
     * Invalidate all listed component types for one entity in a single round-trip.
     * Optionally includes the entity existence key.
     * Emits a single pub/sub message carrying all keys rather than one per component.
     */
    public async invalidateEntityComponents(
        entityId: string,
        componentTypeIds: string[],
        opts?: { includeEntityKey?: boolean },
    ): Promise<void> {
        return _invalidateEntityComponents(this.provider, this.config, this._publishInvalidation.bind(this), entityId, componentTypeIds, opts);
    }

    /**
     * Invalidate multiple specific components from cache
     * Useful for bulk invalidation operations
     */
    public async invalidateComponents(components: Array<{ entityId: string; typeId: string }>): Promise<void> {
        return _invalidateComponents(this.provider, this.config, this._publishInvalidation.bind(this), components);
    }

    /**
     * Invalidate cached state (entity + all components) for a batch of
     * entity IDs. Call this after a raw-SQL write (db.unsafe) that bypasses
     * Entity.set/save, so downstream reads observe fresh data instead of
     * stale L1/L2 cache entries.
     */
    public async invalidateEntities(entityIds: string[]): Promise<void> {
        return _invalidateEntities(this.provider, this.config, this._publishInvalidation.bind(this), entityIds);
    }

    /**
     * Invalidate all components for a specific entity from cache
     * Uses pattern matching to efficiently clear all component caches for an entity
     */
    public async invalidateAllEntityComponents(entityId: string): Promise<void> {
        return _invalidateAllEntityComponents(this.provider, this.config, this._publishInvalidation.bind(this), entityId);
    }

    /**
     * Get components by entity and type from cache (for DataLoader integration).
     * Returns COMPONENT_TOMBSTONE for keys whose absence was previously
     * recorded; callers must treat this as a hit and propagate null upstream.
     */
    public async getComponents(keys: Array<{ entityId: string; typeId: string }>): Promise<(ComponentCacheValue | null)[]> {
        return _getComponents(this.provider, this.config, keys);
    }

    /**
     * Set components in cache with write-through strategy (for DataLoader integration).
     *
     * When `requestedKeys` is supplied and `component.negativeCacheEnabled` is
     * true, tombstones are written for any requested key not present in
     * `components` (within the same setMany call — single round-trip).
     */
    public async setComponentsWriteThrough(
        components: ComponentData[],
        ttlOrRequested?: number | Array<{ entityId: string; typeId: string }>,
        ttlIfRequested?: number,
    ): Promise<void> {
        return _setComponentsWriteThrough(this.provider, this.config, components, ttlOrRequested, ttlIfRequested);
    }

    // Relation negative-cache methods

    /**
     * Build the cache key for a relation tombstone. Null byte separator
     * prevents collision when relationField contains hyphens or colons.
     */
    private static relationCacheKey(entityId: string, relationField: string, relatedType: string, foreignKey?: string): string {
        const fk = foreignKey ?? '';
        return `relation:${entityId}\x00${relationField}\x00${relatedType}\x00${fk}`;
    }

    /**
     * Bulk-check relation tombstones. Returns true at index i when the
     * relation at keys[i] was previously recorded as empty.
     */
    public async getRelationsEmpty(
        keys: Array<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }>,
    ): Promise<boolean[]> {
        if (!this.config.enabled || !this.config.relation?.negativeCacheEnabled) {
            return keys.map(() => false);
        }
        try {
            const cacheKeys = keys.map(k => CacheManager.relationCacheKey(k.entityId, k.relationField, k.relatedType, k.foreignKey));
            const values = await this.provider.getMany<string>(cacheKeys);
            return values.map(v => v === RELATION_TOMBSTONE);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting relation tombstones', error });
            return keys.map(() => false);
        }
    }

    /**
     * Record relation tombstones for keys whose query returned []. TTL
     * defaults to relation.negativeCacheTtl (60s).
     */
    public async setRelationsEmpty(
        keys: Array<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }>,
        ttl?: number,
    ): Promise<void> {
        if (!this.config.enabled || !this.config.relation?.negativeCacheEnabled || keys.length === 0) {
            return;
        }
        try {
            const effectiveTTL = ttl ?? this.config.relation.negativeCacheTtl ?? 60_000;
            const entries = keys.map(k => ({
                key: CacheManager.relationCacheKey(k.entityId, k.relationField, k.relatedType, k.foreignKey),
                value: RELATION_TOMBSTONE,
                ttl: effectiveTTL,
            }));
            await this.provider.setMany(entries);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting relation tombstones', error });
        }
    }

    /**
     * Drop a relation tombstone. Call when a target component is created
     * that may newly satisfy the relation. Pub/sub invalidation is wired
     * identically to component invalidation.
     */
    public async invalidateRelation(entityId: string, relationField: string, relatedType: string, foreignKey?: string): Promise<void> {
        if (!this.config.enabled || !this.config.relation?.negativeCacheEnabled) {
            return;
        }
        try {
            const key = CacheManager.relationCacheKey(entityId, relationField, relatedType, foreignKey);
            await this.provider.delete(key);
            await this._publishInvalidation('key', [key]);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating relation tombstone', error });
        }
    }

    // Generic cache methods

    /**
     * Generic get method
     */
    public async get<T>(key: string): Promise<T | null> {
        if (!this.config.enabled) {
            return null;
        }

        try {
            return await this.provider.get<T>(key);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting from cache', error });
            return null;
        }
    }

    /**
     * Generic set method
     */
    public async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        try {
            const effectiveTTL = ttl ?? this.config.defaultTTL;
            await this.provider.set(key, value, effectiveTTL);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting in cache', error });
        }
    }

    /**
     * Generic delete method
     */
    public async delete(key: string | string[]): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        try {
            await this.provider.delete(key);
            const keys = Array.isArray(key) ? key : [key];
            await this._publishInvalidation('key', keys);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error deleting from cache', error });
        }
    }

    /**
     * Clear all cache
     */
    public async clear(): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        try {
            await this.provider.clear();
            await this._publishInvalidation('pattern', undefined, '*');
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error clearing cache', error });
        }
    }

    /**
     * Get cache statistics
     */
    public async getStats() {
        return _getStats(this.provider);
    }

    /**
     * Health check for cache
     */
    public async ping(): Promise<boolean> {
        return _ping(this.provider);
    }

    // --- Cross-instance pub/sub ---

    /**
     * Setup pub/sub for cross-instance cache invalidation.
     * Only activates when using MultiLevel provider with a Redis L2.
     */
    private async setupPubSub(): Promise<void> {
        this.pubSubEnabled = await _setupPubSub(
            this.provider,
            this.instanceId,
            (raw) => this.handleRemoteInvalidation(raw)
        );
    }

    /**
     * Handle an invalidation message from another instance.
     * Ignores messages from self. Invalidates L1 only (L2 is shared Redis).
     */
    private async handleRemoteInvalidation(raw: string): Promise<void> {
        return _handleRemoteInvalidation(this.provider, this.instanceId, raw);
    }

    /**
     * Publish an invalidation event to other instances via Redis pub/sub.
     */
    private async _publishInvalidation(type: 'key' | 'pattern', keys?: string[], pattern?: string): Promise<void> {
        return _publishInvalidation(this.provider, this.pubSubEnabled, this.instanceId, type, keys, pattern);
    }

    /**
     * Shutdown the current provider (disconnect Redis, stop Memory cleanup
     * timer). For `MultiLevelCache`, descends into both L1 and L2 layers —
     * previously the method only dispatched on the top-level provider, so a
     * MultiLevelCache left its inner `MemoryCache` cleanup timer and Redis
     * connection alive (H-CACHE-2).
     */
    private async shutdownProvider(): Promise<void> {
        const shutdownOne = async (p: any) => {
            try {
                if (p && typeof p.disconnect === 'function') {
                    await p.disconnect();
                }
                if (p && typeof p.stopCleanup === 'function') {
                    p.stopCleanup();
                }
            } catch (error) {
                logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error shutting down layer', err: error });
            }
        };

        try {
            const provider = this.provider as any;
            // MultiLevelCache exposes getL1Cache / getL2Cache.
            if (provider && typeof provider.getL1Cache === 'function') {
                await shutdownOne(provider.getL1Cache());
                if (typeof provider.getL2Cache === 'function') {
                    await shutdownOne(provider.getL2Cache());
                }
                return;
            }
            // Single-layer providers.
            await shutdownOne(provider);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error shutting down provider', err: error });
        }
    }

    /**
     * Shutdown the cache manager
     */
    public async shutdown(): Promise<void> {
        try {
            await this.shutdownProvider();
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error shutting down cache', error });
        }
    }
}
