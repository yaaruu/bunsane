// Cache side-effect strategies for Entity save/delete. Extracted from
// Entity.ts (RFC_REFACTOR_TARGETS §3.2). Pure functions take the entity
// instance as the first parameter.
import type { BaseComponent } from "../components";
import { logger } from "../Logger";
import EntityHookManager from "../EntityHookManager";
import { EntityDeletedEvent } from "../events/EntityLifecycleEvents";
import type { SQL } from "bun";
import type { Entity } from "../Entity";

/**
 * Handle cache operations after successful save
 * @param changedComponentTypeIds - Component type IDs that were dirty before save (captured before doSave clears flags)
 * @param removedComponentTypeIds - Component type IDs that were removed (captured before doSave clears the set)
 */
export async function handleCacheAfterSave(entity: Entity, changedComponentTypeIds: string[], removedComponentTypeIds: string[], context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<void> {
    try {
        // Import CacheManager dynamically to avoid circular dependency
        const { CacheManager } = await import('../cache/CacheManager');
        const cacheManager = CacheManager.getInstance();
        const config = cacheManager.getConfig();

        const entityEnabled = !!(config.enabled && config.entity?.enabled);
        const componentEnabled = !!(config.enabled && config.component?.enabled);

        if (entityEnabled && config.strategy === 'write-through') {
            await cacheManager.setEntityWriteThrough(entity, config.entity!.ttl);
        }

        // Handle component cache invalidation with granular approach
        if (componentEnabled) {
            // Use the pre-captured lists instead of re-querying (dirty flags are already cleared by doSave)

            if (config.strategy === 'write-through') {
                // Single batched write-through (2 pipelined provider
                // round-trips total) instead of one GET+SET pair per
                // changed component.
                const entries = changedComponentTypeIds
                    .map(typeId => ({ typeId, component: entity.components.get(typeId) }))
                    .filter((e): e is { typeId: string; component: BaseComponent } => !!e.component)
                    .map(e => ({ entityId: entity.id, typeId: e.typeId, component: e.component, ttl: config.component!.ttl }));
                if (entries.length > 0) {
                    await cacheManager.setComponentsBatchWriteThrough(entries);
                }
                // Removed components must still drop out of cache.
                if (removedComponentTypeIds.length > 0) {
                    await cacheManager.invalidateEntityComponents(entity.id, removedComponentTypeIds);
                }
            } else {
                // One deleteMany + ONE pub/sub message for the whole save
                // (entity key included) — previously N+1 DEL+PUBLISH pairs
                // per save, fanning out to every other instance.
                const toInvalidate = [...changedComponentTypeIds, ...removedComponentTypeIds];
                if (toInvalidate.length > 0 || entityEnabled) {
                    await cacheManager.invalidateEntityComponents(entity.id, toInvalidate, { includeEntityKey: entityEnabled });
                }
            }

            // Invalidate DataLoader cache for changed + removed components
            if (context?.loaders?.componentsByEntityType) {
                for (const typeId of [...changedComponentTypeIds, ...removedComponentTypeIds]) {
                    context.loaders.componentsByEntityType.clear({
                        entityId: entity.id,
                        typeId: typeId
                    });
                }
            }
        } else if (entityEnabled && config.strategy !== 'write-through') {
            await cacheManager.invalidateEntity(entity.id);
        }
    } catch (error) {
        logger.warn({ scope: 'cache', component: 'Entity', msg: 'Cache operation failed after save', error });
    }
}

export async function runPostDeleteSideEffects(entity: Entity, softDelete: boolean): Promise<void> {
    try {
        await EntityHookManager.executeHooks(new EntityDeletedEvent(entity, softDelete));
    } catch (err) {
        logger.error({ scope: 'hooks', entityId: entity.id, err }, 'post-delete lifecycle hooks failed');
    }

    try {
        const { CacheManager } = await import('../cache/CacheManager');
        const cacheManager = CacheManager.getInstance();
        const config = cacheManager.getConfig();

        if (config.enabled && config.entity?.enabled) {
            await cacheManager.invalidateEntity(entity.id);
        }
        if (config.enabled && config.component?.enabled) {
            await cacheManager.invalidateAllEntityComponents(entity.id);
        }
    } catch (err) {
        logger.warn({ scope: 'cache', entityId: entity.id, err }, 'post-delete cache invalidation failed');
    }
}
