import { type CacheProvider } from '../CacheProvider';
import { type CacheConfig } from '../../../config/cache.config';
import { logger } from '../../Logger';
import type { Entity } from '../../Entity';
import type { BaseComponent } from '../../components';
import type { ComponentData } from '../../RequestLoaders';

// Must match the value exported by CacheManager — inlined here to avoid
// a circular import (CacheManager imports this module).
const COMPONENT_TOMBSTONE = '__TOMBSTONE__' as const;
type ComponentCacheValue = ComponentData | typeof COMPONENT_TOMBSTONE;

/**
 * Write-through strategy: entity get/set operations
 */

export async function getEntity(provider: CacheProvider, config: CacheConfig, id: string): Promise<string | null> {
    if (!config.enabled || !config.entity?.enabled) {
        return null;
    }

    try {
        const key = `entity:${id}`;
        const result = await provider.get<string>(key);
        return result || null;
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting entity from cache', error });
        return null;
    }
}

export async function setEntityWriteThrough(provider: CacheProvider, config: CacheConfig, entity: Entity, ttl?: number): Promise<void> {
    if (!config.enabled || !config.entity?.enabled) {
        return;
    }

    try {
        const key = `entity:${entity.id}`;
        const effectiveTTL = ttl ?? config.entity.ttl;
        // Only cache entity ID for existence check
        await provider.set(key, entity.id, effectiveTTL);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting entity in cache', error });
    }
}

export async function getEntities(provider: CacheProvider, config: CacheConfig, ids: string[]): Promise<(string | null)[]> {
    if (!config.enabled || !config.entity?.enabled) {
        return ids.map(() => null);
    }

    try {
        const cacheKeys = ids.map(id => `entity:${id}`);
        const results = await provider.getMany<string>(cacheKeys);
        return results;
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting entities from cache', error });
        return ids.map(() => null);
    }
}

export async function setEntitiesWriteThrough(provider: CacheProvider, config: CacheConfig, entities: Entity[], ttl?: number): Promise<void> {
    if (!config.enabled || !config.entity?.enabled) {
        return;
    }

    try {
        const effectiveTTL = ttl ?? config.entity?.ttl;
        const entries = entities.map(entity => ({
            key: `entity:${entity.id}`,
            // Only cache entity ID for existence check
            value: entity.id,
            ttl: effectiveTTL
        }));
        await provider.setMany(entries);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting entities in cache', error });
    }
}

export async function getComponentsByEntity(provider: CacheProvider, config: CacheConfig, entityId: string, componentType?: string): Promise<BaseComponent[] | null> {
    if (!config.enabled || !config.component?.enabled) {
        return null;
    }

    try {
        const key = componentType
            ? `component:${entityId}:${componentType}`
            : `components:${entityId}`;
        return await provider.get<BaseComponent[]>(key);
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
export async function setComponentWriteThrough(provider: CacheProvider, config: CacheConfig, entityId: string, components: BaseComponent[], componentType?: string, ttl?: number): Promise<void> {
    if (!config.enabled || !config.component?.enabled) {
        return;
    }
    const entries = components.map(c => ({
        entityId,
        typeId: componentType || c.getTypeID(),
        component: c,
        ttl,
    }));
    await setComponentsBatchWriteThrough(provider, config, entries);
}

/**
 * Batch write-through for BaseComponent instances across any number of
 * entities. Performs exactly 2 Redis round-trips regardless of entry count:
 *   1. pipelined getMany  — reads existing entries to preserve createdAt (H-CACHE-3)
 *   2. pipelined setMany  — writes all updated entries
 */
export async function setComponentsBatchWriteThrough(
    provider: CacheProvider,
    config: CacheConfig,
    entries: Array<{ entityId: string; typeId: string; component: BaseComponent; ttl?: number }>,
): Promise<void> {
    if (!config.enabled || !config.component?.enabled || entries.length === 0) {
        return;
    }

    try {
        const effectiveTTL = config.component.ttl;
        const keys = entries.map(e => `component:${e.entityId}:${e.typeId}`);

        // One batched read — preserves createdAt from existing entries (H-CACHE-3).
        const existing = await provider.getMany<ComponentData>(keys);

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
        await provider.setMany(setEntries);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache (batch)', err: error });
    }
}

export async function getComponents(provider: CacheProvider, config: CacheConfig, keys: Array<{ entityId: string; typeId: string }>): Promise<(ComponentCacheValue | null)[]> {
    if (!config.enabled || !config.component?.enabled) {
        return keys.map(() => null);
    }

    try {
        const cacheKeys = keys.map(k => `component:${k.entityId}:${k.typeId}`);
        const results = await provider.getMany<ComponentCacheValue>(cacheKeys);
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
export async function setComponentsWriteThrough(
    provider: CacheProvider,
    config: CacheConfig,
    components: ComponentData[],
    ttlOrRequested?: number | Array<{ entityId: string; typeId: string }>,
    ttlIfRequested?: number,
): Promise<void> {
    if (!config.enabled || !config.component?.enabled) {
        return;
    }

    // Backward-compatible overload: (components, ttl?) or (components, requestedKeys, ttl?)
    const requestedKeys = Array.isArray(ttlOrRequested) ? ttlOrRequested : undefined;
    const ttl = Array.isArray(ttlOrRequested) ? ttlIfRequested : ttlOrRequested;

    try {
        const componentTTL = ttl ?? config.component.ttl;
        const entries: Array<{ key: string; value: ComponentCacheValue; ttl: number }> = components.map(comp => ({
            key: `component:${comp.entityId}:${comp.typeId}`,
            value: comp,
            ttl: componentTTL,
        }));

        const negativeEnabled = config.component.negativeCacheEnabled === true;
        if (negativeEnabled && requestedKeys && requestedKeys.length > 0) {
            const found = new Set(components.map(c => `${c.entityId}-${c.typeId}`));
            const tombstoneTTL = config.component.negativeCacheTtl
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
            await provider.setMany(entries);
        }
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error setting components in cache', error });
    }
}
