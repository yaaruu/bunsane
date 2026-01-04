import { type CacheProvider } from './CacheProvider';
import { type CacheConfig, defaultCacheConfig } from '../../config/cache.config';
import { CacheFactory } from './CacheFactory';
import { logger } from '../Logger';
import type { Entity } from '../Entity';
import type { BaseComponent } from '../components';
import type { ComponentData } from '../RequestLoaders';

/**
 * High-level cache operations manager
 * Singleton that provides entity and component caching methods
 * Note: Query-level caching has been removed in favor of component-level caching only
 */
export class CacheManager {
    private static instance: CacheManager;
    private provider: CacheProvider;
    private config: CacheConfig;

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
    public initialize(config: Partial<CacheConfig>): void {
        this.config = { ...defaultCacheConfig, ...config };
        this.provider = CacheFactory.create(this.config);
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
     */
    public async setComponentWriteThrough(entityId: string, components: BaseComponent[], componentType?: string, ttl?: number): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        try {
            const effectiveTTL = ttl ?? this.config.component.ttl;
            
            // Convert BaseComponent to ComponentData format for cache compatibility with DataLoader
            for (const component of components) {
                const typeId = componentType || component.getTypeID();
                const key = `component:${entityId}:${typeId}`;
                
                // Create ComponentData structure matching what DataLoader expects
                const componentData: ComponentData = {
                    id: component.id,
                    entityId: entityId,
                    typeId: typeId,
                    data: component.data(),
                    createdAt: new Date(), // Component doesn't track this, use current time
                    updatedAt: new Date(),
                    deletedAt: null
                };
                
                await this.provider.set(key, componentData, effectiveTTL);
            }
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache', error });
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
            const key = `component:${entityId}:${typeId}`;
            await this.provider.delete(key);
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
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating components from cache', error });
        }
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
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating all entity components from cache', error });
        }
    }

    /**
     * Get components by entity and type from cache (for DataLoader integration)
     */
    public async getComponents(keys: Array<{ entityId: string; typeId: string }>): Promise<(ComponentData | null)[]> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return keys.map(() => null);
        }

        try {
            const cacheKeys = keys.map(k => `component:${k.entityId}:${k.typeId}`);
            const results = await this.provider.getMany<ComponentData>(cacheKeys);
            return results;
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting components from cache', error });
            return keys.map(() => null);
        }
    }

    /**
     * Set components in cache with write-through strategy (for DataLoader integration)
     */
    public async setComponentsWriteThrough(components: ComponentData[], ttl?: number): Promise<void> {
        if (!this.config.enabled || !this.config.component?.enabled) {
            return;
        }

        try {
            const effectiveTTL = ttl ?? this.config.component?.ttl;
            const entries = components.map(comp => ({
                key: `component:${comp.entityId}:${comp.typeId}`,
                value: comp,
                ttl: effectiveTTL
            }));
            await this.provider.setMany(entries);
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache', error });
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

    /**
     * Shutdown the cache manager
     */
    public async shutdown(): Promise<void> {
        try {
            // If the provider has a shutdown method, call it
            if (typeof (this.provider as any).shutdown === 'function') {
                await (this.provider as any).shutdown();
            }
        } catch (error) {
            logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error shutting down cache', error });
        }
    }
}