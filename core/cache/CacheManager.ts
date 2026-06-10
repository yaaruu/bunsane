import { type CacheProvider } from './CacheProvider';
import { type CacheConfig, defaultCacheConfig } from '../../config/cache.config';
import { CacheFactory } from './CacheFactory';
import { MultiLevelCache } from './MultiLevelCache';
import { RedisCache } from './RedisCache';
import { logger } from '../Logger';
import type { Entity } from '../Entity';
import type { BaseComponent } from '../components';
import type { ComponentData } from '../RequestLoaders';

interface InvalidationMessage {
    instanceId: string;
    type: 'key' | 'pattern';
    keys?: string[];
    pattern?: string;
}

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
    private config: CacheConfig;
    private instanceId = crypto.randomUUID();
    private pubSubEnabled = false;
    private static readonly INVALIDATION_CHANNEL = 'bunsane:cache:invalidate';

    private constructor() {
        this.config = defaultCacheConfig;
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

        this.config = { ...defaultCacheConfig, ...config };
        this.provider = CacheFactory.create(this.config);

        await this.setupPubSub();

        logger.info({ scope: 'cache', component: 'CacheManager', msg: 'CacheManager initialized', provider: this.config.provider, enabled: this.config.enabled });
    }

    /**
     * Get the current cache configuration
     */
    public getConfig(): CacheConfig {
        return { ...this.config };
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
        if (!this.config.enabled || !this.config.entity?.enabled) {
            return null;
        }

        try {
            const key = `entity:${id}`;
            const result = await this.provider.get<string>(key);
            return result || null;
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting entity from cache', error });
            return null;
        }
    }

    /**
     * Set an entity existence in cache with write-through strategy
     * Only caches entity ID for existence tracking, not full entity data
     */
    public async setEntityWriteThrough(entity: Entity, ttl?: number): Promise<void> {
        if (!this.config.enabled || !this.config.entity?.enabled) {
            return;
        }

        try {
            const key = `entity:${entity.id}`;
            const effectiveTTL = ttl ?? this.config.entity.ttl;
            // Only cache entity ID for existence check
            await this.provider.set(key, entity.id, effectiveTTL);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting entity in cache', error });
        }
    }

    /**
     * Invalidate an entity from cache
     */
    public async invalidateEntity(id: string): Promise<void> {
        if (!this.config.enabled || !this.config.entity?.enabled) {
            return;
        }

        try {
            const key = `entity:${id}`;
            await this.provider.delete(key);
            await this.publishInvalidation('key', [key]);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating entity from cache', error });
        }
    }

    /**
     * Get multiple entity existence checks from cache (for DataLoader integration)
     * Returns entity IDs if they exist, null if not found
     */
    public async getEntities(ids: string[]): Promise<(string | null)[]> {
        if (!this.config.enabled || !this.config.entity?.enabled) {
            return ids.map(() => null);
        }

        try {
            const cacheKeys = ids.map(id => `entity:${id}`);
            const results = await this.provider.getMany<string>(cacheKeys);
            return results;
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting entities from cache', error });
            return ids.map(() => null);
        }
    }

    /**
     * Set multiple entity existences in cache with write-through strategy (for DataLoader integration)
     * Only caches entity IDs for existence tracking, not full entity data
     */
    public async setEntitiesWriteThrough(entities: Entity[], ttl?: number): Promise<void> {
        if (!this.config.enabled || !this.config.entity?.enabled) {
            return;
        }

        try {
            const effectiveTTL = ttl ?? this.config.entity?.ttl;
            const entries = entities.map(entity => ({
                key: `entity:${entity.id}`,
                // Only cache entity ID for existence check
                value: entity.id,
                ttl: effectiveTTL
            }));
            await this.provider.setMany(entries);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting entities in cache', error });
        }
    }

    // Component caching methods

    /**
     * Get components for an entity from cache
     */
    public async getComponentsByEntity(entityId: string, componentType?: string): Promise<BaseComponent[] | null> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return null;
        }

        try {
            const key = componentType
                ? `component:${entityId}:${componentType}`
                : `components:${entityId}`;
            return await this.provider.get<BaseComponent[]>(key);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting components from cache', error });
            return null;
        }
    }

    /**
     * Set components for an entity in cache with write-through strategy.
     * Converts BaseComponent instances to ComponentData format for cache compatibility with DataLoader.
     * Delegates to setComponentsBatchWriteThrough for a single-entity, 2-RTT batch.
     */
    public async setComponentWriteThrough(entityId: string, components: BaseComponent[], componentType?: string, ttl?: number): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }
        const entries = components.map(c => ({
            entityId,
            typeId: componentType || c.getTypeID(),
            component: c,
            ttl,
        }));
        await this.setComponentsBatchWriteThrough(entries);
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
        if (!this.config.enabled || !this.config.component?.enabled || entries.length === 0) {
            return;
        }

        try {
            const effectiveTTL = this.config.component.ttl;
            const keys = entries.map(e => `component:${e.entityId}:${e.typeId}`);

            // One batched read — preserves createdAt from existing entries (H-CACHE-3).
            const existing = await this.provider.getMany<ComponentData>(keys);

            const now = new Date();
            const setEntries = entries.map((e, i) => {
                const prev = existing[i];
                const createdAt: Date =
                    prev && prev.createdAt
                        ? (prev.createdAt instanceof Date ? prev.createdAt : new Date(prev.createdAt))
                        : now;

                const componentData: ComponentData = {
                    id: e.component.id,
                    entityId: e.entityId,
                    typeId: e.typeId,
                    data: e.component.data(),
                    createdAt,
                    updatedAt: now,
                    deletedAt: null,
                };

                return { key: keys[i]!, value: componentData, ttl: e.ttl ?? effectiveTTL };
            });

            // One batched write.
            await this.provider.setMany(setEntries);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache (batch)', err: error });
        }
    }

    /**
     * Invalidate a specific component for an entity from cache
     * More granular than invalidateComponents which can invalidate all components
     */
    public async invalidateComponent(entityId: string, typeId: string): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        try {
            logger.trace({
                msg: 'Invalidating component from cache',
                entityId,
                typeId
            })
            const key = `component:${entityId}:${typeId}`;
            await this.provider.delete(key);
            await this.publishInvalidation('key', [key]);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating component from cache', error });
        }
    }

    /**
     * Invalidate multiple specific components from cache
     * Useful for bulk invalidation operations
     */
    public async invalidateComponents(components: Array<{ entityId: string; typeId: string }>): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        try {
            const keys = components.map(comp => `component:${comp.entityId}:${comp.typeId}`);
            await this.provider.deleteMany(keys);
            await this.publishInvalidation('key', keys);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating components from cache', error });
        }
    }

    /**
     * Invalidate cached state (entity + all components) for a batch of
     * entity IDs. Call this after a raw-SQL write (db.unsafe) that bypasses
     * Entity.set/save, so downstream reads observe fresh data instead of
     * stale L1/L2 cache entries.
     */
    public async invalidateEntities(entityIds: string[]): Promise<void> {
        if (!this.config.enabled || entityIds.length === 0) {
            return;
        }
        await Promise.all(
            entityIds.flatMap(id => [
                this.invalidateEntity(id),
                this.invalidateAllEntityComponents(id),
            ])
        );
    }

    /**
     * Invalidate all components for a specific entity from cache
     * Uses pattern matching to efficiently clear all component caches for an entity
     */
    public async invalidateAllEntityComponents(entityId: string): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        try {
            const pattern = `component:${entityId}:*`;
            await this.provider.invalidatePattern(pattern);
            await this.publishInvalidation('pattern', undefined, pattern);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating all entity components from cache', error });
        }
    }

    /**
     * Get components by entity and type from cache (for DataLoader integration).
     * Returns COMPONENT_TOMBSTONE for keys whose absence was previously
     * recorded; callers must treat this as a hit and propagate null upstream.
     */
    public async getComponents(keys: Array<{ entityId: string; typeId: string }>): Promise<(ComponentCacheValue | null)[]> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return keys.map(() => null);
        }

        try {
            const cacheKeys = keys.map(k => `component:${k.entityId}:${k.typeId}`);
            const results = await this.provider.getMany<ComponentCacheValue>(cacheKeys);
            return results;
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting components from cache', error });
            return keys.map(() => null);
        }
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
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        // Backward-compatible overload: (components, ttl?) or (components, requestedKeys, ttl?)
        const requestedKeys = Array.isArray(ttlOrRequested) ? ttlOrRequested : undefined;
        const ttl = Array.isArray(ttlOrRequested) ? ttlIfRequested : ttlOrRequested;

        try {
            const componentTTL = ttl ?? this.config.component.ttl;
            const entries: Array<{ key: string; value: ComponentCacheValue; ttl: number }> = components.map(comp => ({
                key: `component:${comp.entityId}:${comp.typeId}`,
                value: comp,
                ttl: componentTTL,
            }));

            const negativeEnabled = this.config.component.negativeCacheEnabled === true;
            if (negativeEnabled && requestedKeys && requestedKeys.length > 0) {
                const found = new Set(components.map(c => `${c.entityId}-${c.typeId}`));
                const tombstoneTTL = this.config.component.negativeCacheTtl
                    ?? Math.min(componentTTL, 60_000);
                for (const k of requestedKeys) {
                    const dedupeKey = `${k.entityId}-${k.typeId}`;
                    if (!found.has(dedupeKey)) {
                        entries.push({
                            key: `component:${k.entityId}:${k.typeId}`,
                            value: COMPONENT_TOMBSTONE,
                            ttl: tombstoneTTL,
                        });
                    }
                }
            }

            if (entries.length > 0) {
                await this.provider.setMany(entries);
            }
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache', error });
        }
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
            await this.publishInvalidation('key', [key]);
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
            await this.publishInvalidation('key', keys);
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
            await this.publishInvalidation('pattern', undefined, '*');
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error clearing cache', error });
        }
    }

    /**
     * Get cache statistics
     */
    public async getStats() {
        try {
            return await this.provider.getStats();
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting cache stats', error });
            return {
                hits: 0,
                misses: 0,
                hitRate: 0,
                size: 0,
                memoryUsage: 0
            };
        }
    }

    /**
     * Health check for cache
     */
    public async ping(): Promise<boolean> {
        try {
            return await this.provider.ping();
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Cache ping failed', error });
            return false;
        }
    }

    // --- Cross-instance pub/sub ---

    /**
     * Setup pub/sub for cross-instance cache invalidation.
     * Only activates when using MultiLevel provider with a Redis L2.
     */
    private async setupPubSub(): Promise<void> {
        if (!(this.provider instanceof MultiLevelCache)) return;

        const l2 = this.provider.getL2Cache();
        if (!(l2 instanceof RedisCache)) return;

        try {
            await l2.subscribeInvalidation(
                CacheManager.INVALIDATION_CHANNEL,
                (_channel, message) => this.handleRemoteInvalidation(message)
            );
            this.pubSubEnabled = true;
            logger.info({ scope: 'cache', component: 'CacheManager', msg: 'Cross-instance cache invalidation enabled', instanceId: this.instanceId });
        } catch (error) {
            logger.warn({ scope: 'cache', component: 'CacheManager', msg: 'Failed to setup pub/sub', error });
        }
    }

    /**
     * Handle an invalidation message from another instance.
     * Ignores messages from self. Invalidates L1 only (L2 is shared Redis).
     */
    private async handleRemoteInvalidation(raw: string): Promise<void> {
        try {
            const msg: InvalidationMessage = JSON.parse(raw);

            // Ignore our own messages
            if (msg.instanceId === this.instanceId) return;

            if (!(this.provider instanceof MultiLevelCache)) return;
            const l1 = this.provider.getL1Cache();

            if (msg.type === 'key' && msg.keys) {
                await l1.deleteMany(msg.keys);
            } else if (msg.type === 'pattern' && msg.pattern) {
                await l1.invalidatePattern(msg.pattern);
            }

            logger.debug({ scope: 'cache', component: 'CacheManager', msg: 'Applied remote invalidation', from: msg.instanceId, type: msg.type });
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error handling remote invalidation', error });
        }
    }

    /**
     * Publish an invalidation event to other instances via Redis pub/sub.
     */
    private async publishInvalidation(type: 'key' | 'pattern', keys?: string[], pattern?: string): Promise<void> {
        if (!this.pubSubEnabled) return;
        if (!(this.provider instanceof MultiLevelCache)) return;

        const l2 = this.provider.getL2Cache();
        if (!(l2 instanceof RedisCache)) return;

        try {
            const msg: InvalidationMessage = { instanceId: this.instanceId, type, keys, pattern };
            await l2.publishInvalidation(CacheManager.INVALIDATION_CHANNEL, JSON.stringify(msg));
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error publishing invalidation', error });
        }
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