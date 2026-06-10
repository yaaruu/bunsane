import { type CacheProvider } from '../CacheProvider';
import { type CacheConfig } from '../../../config/cache.config';
import { logger } from '../../Logger';

/**
 * Write-invalidate strategy: entity and component invalidation operations.
 * publishInvalidation is passed as a callback to avoid circular imports.
 */

type PublishFn = (type: 'key' | 'pattern', keys?: string[], pattern?: string) => Promise<void>;

export async function invalidateEntity(provider: CacheProvider, config: CacheConfig, publishInvalidation: PublishFn, id: string): Promise<void> {
    if (!config.enabled || !config.entity?.enabled) {
        return;
    }

    try {
        const key = `entity:${id}`;
        await provider.delete(key);
        await publishInvalidation('key', [key]);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating entity from cache', error });
    }
}

export async function invalidateEntities(provider: CacheProvider, config: CacheConfig, publishInvalidation: PublishFn, entityIds: string[]): Promise<void> {
    if (!config.enabled || entityIds.length === 0) {
        return;
    }
    await Promise.all(
        entityIds.flatMap(id => [
            invalidateEntity(provider, config, publishInvalidation, id),
            invalidateAllEntityComponents(provider, config, publishInvalidation, id),
        ])
    );
}

export async function invalidateAllEntityComponents(provider: CacheProvider, config: CacheConfig, publishInvalidation: PublishFn, entityId: string): Promise<void> {
    if (!config.enabled || !config.component?.enabled) {
        return;
    }

    try {
        const pattern = `component:${entityId}:*`;
        await provider.invalidatePattern(pattern);
        await publishInvalidation('pattern', undefined, pattern);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating all entity components from cache', error });
    }
}

export async function invalidateComponent(provider: CacheProvider, config: CacheConfig, publishInvalidation: PublishFn, entityId: string, typeId: string): Promise<void> {
    if (!config.enabled || !config.component?.enabled) {
        return;
    }

    try {
        logger.trace({
            msg: 'Invalidating component from cache',
            entityId,
            typeId
        })
        const key = `component:${entityId}:${typeId}`;
        await provider.delete(key);
        await publishInvalidation('key', [key]);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating component from cache', error });
    }
}

export async function invalidateComponents(provider: CacheProvider, config: CacheConfig, publishInvalidation: PublishFn, components: Array<{ entityId: string; typeId: string }>): Promise<void> {
    if (!config.enabled || !config.component?.enabled) {
        return;
    }

    try {
        const keys = components.map(comp => `component:${comp.entityId}:${comp.typeId}`);
        await provider.deleteMany(keys);
        await publishInvalidation('key', keys);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating components from cache', error });
    }
}

/**
 * Invalidate all listed component types for one entity in a single round-trip.
 * Optionally includes the entity existence key.
 * Emits a single pub/sub message carrying all keys rather than one per component.
 */
export async function invalidateEntityComponents(
    provider: CacheProvider,
    config: CacheConfig,
    publishInvalidation: PublishFn,
    entityId: string,
    componentTypeIds: string[],
    opts?: { includeEntityKey?: boolean },
): Promise<void> {
    if (!config.enabled) return;
    if (componentTypeIds.length === 0 && !opts?.includeEntityKey) return;

    try {
        const keys: string[] = componentTypeIds.map(typeId => `component:${entityId}:${typeId}`);
        if (opts?.includeEntityKey) {
            keys.push(`entity:${entityId}`);
        }
        await provider.deleteMany(keys);
        await publishInvalidation('key', keys);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error invalidating entity components', entityId, error });
    }
}
