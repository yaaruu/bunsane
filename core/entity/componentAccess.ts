// Component access + mutation for Entity (add/set/remove/get/has/reload
// and the in-memory helpers). Extracted from Entity.ts
// (RFC_REFACTOR_TARGETS §3.2). Pure functions take the entity instance as
// the first parameter; hook phases/order are byte-identical to the
// original inline implementation.
import type { ComponentDataType, ComponentGetter, BaseComponent } from "../components";
import { logger } from "../Logger";
import db from "../../database";
import { runWithSignal } from "../../database/cancellable";
import ComponentRegistry from "../components/ComponentRegistry";
import { SQL } from "bun";
import EntityHookManager from "../EntityHookManager";
import { getMetadataStorage } from "../metadata";
import { ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "../events/EntityLifecycleEvents";
import { getRequestScope } from "../requestScope";
import { trackCacheOp } from "./pendingOps";
import type { Entity } from "../Entity";

export function addComponent(entity: Entity, component: BaseComponent): Entity {
    entity.components.set(component.getTypeID(), component);
    return entity;
}

/**
 * Resolve a component constructor to its type id. `getComponentId` is
 * memoized in metadata storage, so this is an O(1) Map lookup with no
 * component instantiation — unlike `new ctor().getTypeID()`. The
 * `components` map is keyed by type id (see addComponent), so callers can
 * then do `entity.components.get(typeId)` instead of allocating an array and
 * scanning it with `instanceof`.
 */
export function typeIdOf(ctor: new (...args: any[]) => BaseComponent): string {
    return getMetadataStorage().getComponentId(ctor.name);
}

export function componentList(entity: Entity): BaseComponent[] {
    return Array.from(entity.components.values());
}

export function getInMemory<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): T | undefined {
    return entity.components.get(typeIdOf(ctor)) as T | undefined;
}

export function hasInMemory<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): boolean {
    return entity.components.has(typeIdOf(ctor));
}

export function wasRemoved<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): boolean {
    const typeId = typeIdOf(ctor);
    // Check both pending removals and already-saved removals
    return entity.removedComponents.has(typeId) || entity.savedRemovedComponents.has(typeId);
}

export function add<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, data?: Partial<ComponentDataType<T>>): Entity {
    const instance = new ctor();
    if (data) {
        Object.assign(instance, data);
    } else {
        Object.assign(instance, {});
    }
    addComponent(entity, instance);
    entity.setDirty(true);
    // executeHooks is async; the surrounding try/catch only captures
    // synchronous throws. Attach a .catch so an async rejection from a
    // hook handler does not escape as an unhandled rejection (H-HOOK-1).
    // Add stays sync to preserve the fluent chaining signature; hook
    // failures are logged and do not fail the add operation.
    Promise.resolve()
        .then(() => EntityHookManager.executeHooks(new ComponentAddedEvent(entity, instance)))
        .catch((error) => {
            logger.error(`Error firing component added hook for ${instance.getTypeID()}: ${error}`);
        });

    return entity;
}

export async function set<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, data: Partial<ComponentDataType<T>>, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<Entity> {
    await get(entity, ctor, context);

    const component = entity.components.get(typeIdOf(ctor)) as T;
    if (component) {
        // Store old data for the update event
        const oldData = { ...component };

        // Update existing component
        Object.assign(component, data);
        component.setDirty(true);
        entity.setDirty(true);

        // Fire component updated event. Await so a hook rejection is
        // captured by this method's try/catch and does not escape as an
        // unhandled rejection (H-HOOK-1).
        try {
            await EntityHookManager.executeHooks(new ComponentUpdatedEvent(entity, component, oldData, component));
        } catch (error) {
            logger.error(`Error firing component updated hook for ${component.getTypeID()}: ${error}`);
            // Don't fail the set operation if hooks fail
        }

        // Invalidate DataLoader cache if context is provided
        if (context?.loaders?.componentsByEntityType) {
            context.loaders.componentsByEntityType.clear({
                entityId: entity.id,
                typeId: component.getTypeID()
            });
        }

        // Fire-and-forget cache update, tracked via drainable set so
        // App.shutdown can await it (H-CACHE-1).
        trackCacheOp((async () => {
            try {
                const { CacheManager } = await import('../cache/CacheManager');
                const cacheManager = CacheManager.getInstance();
                const config = cacheManager.getConfig();

                if (config.enabled && config.component?.enabled) {
                    if (config.strategy === 'write-through') {
                        await cacheManager.setComponentWriteThrough(entity.id, [component], component.getTypeID(), config.component.ttl);
                    } else {
                        await cacheManager.invalidateComponent(entity.id, component.getTypeID());
                    }
                }
            } catch (error) {
                logger.warn({ scope: 'cache', component: 'Entity', msg: 'Cache operation failed after set', err: error });
            }
        })());
    } else {
        // Add new component
        add(entity, ctor, data);
        entity.setDirty(true);
        // Note: add() already fires ComponentAddedEvent, so we don't need to fire it again
    }
    return entity;
}

export function remove<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): boolean {
    const component = entity.components.get(typeIdOf(ctor)) as T;

    if (component) {
        const typeId = component.getTypeID();

        // Track the component type for database deletion
        entity.removedComponents.add(typeId);

        // Remove the component from the map
        entity.components.delete(typeId);
        entity.setDirty(true);

        // Fire component removed event. remove() stays sync to preserve
        // the boolean return signature used by callers; attach .catch so
        // async hook rejections do not escape (H-HOOK-1).
        Promise.resolve()
            .then(() => EntityHookManager.executeHooks(new ComponentRemovedEvent(entity, component)))
            .catch((error) => {
                logger.error(`Error firing component removed hook for ${typeId}: ${error}`);
            });

        // Invalidate DataLoader cache if context is provided
        if (context?.loaders?.componentsByEntityType) {
            context.loaders.componentsByEntityType.clear({
                entityId: entity.id,
                typeId: typeId
            });
        }

        // Fire-and-forget cache invalidation, tracked for shutdown drain
        // (H-CACHE-1).
        trackCacheOp((async () => {
            try {
                const { CacheManager } = await import('../cache/CacheManager');
                const cacheManager = CacheManager.getInstance();
                const config = cacheManager.getConfig();

                if (config.enabled && config.component?.enabled) {
                    await cacheManager.invalidateComponent(entity.id, typeId);
                }
            } catch (error) {
                logger.warn({ scope: 'cache', component: 'Entity', msg: 'Cache invalidation failed after remove', err: error });
            }
        })());

        return true;
    }

    return false;
}

export async function get<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<ComponentDataType<T> | null> {
    const comp = await loadComponent(entity, ctor, context);
    return comp ? (comp as ComponentGetter<T>).data() : null;
}

export function has<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): boolean {
    return hasInMemory(entity, ctor);
}

export async function getOrThrow<T extends BaseComponent>(
    entity: Entity,
    ctor: new (...args: any[]) => T,
    context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }
): Promise<ComponentDataType<T>> {
    const data = await get(entity, ctor, context);
    if (data === null) {
        throw new Error(`Entity ${entity.id} is missing required component ${ctor.name}`);
    }
    return data;
}

export function getCached<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): ComponentDataType<T> | undefined {
    const comp = getInMemory(entity, ctor);
    return comp ? (comp as ComponentGetter<T>).data() : undefined;
}

export async function getInstanceOf<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<T | null> {
    return loadComponent(entity, ctor, context);
}

export async function reload(entity: Entity, opts?: { trx?: SQL; signal?: AbortSignal }): Promise<Entity> {
    if (!entity.id || entity.id.trim() === '') {
        return entity;
    }
    entity.components.clear();
    entity.removedComponents.clear();
    entity.savedRemovedComponents.clear();

    const dbConn = opts?.trx ?? db;
    const rows = await runWithSignal<any[]>(
        dbConn`
        SELECT c.id, c.type_id, c.data
        FROM components c
        WHERE c.entity_id = ${entity.id} AND c.deleted_at IS NULL
    `,
        opts?.signal
    );

    const storage = getMetadataStorage();
    for (const row of rows) {
        const ctor = ComponentRegistry.getConstructor(row.type_id);
        if (!ctor) continue;
        const comp: any = new ctor();
        const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        Object.assign(comp, parsed);
        comp.id = row.id;
        const props = storage.componentProperties.get(row.type_id);
        if (props) {
            for (const prop of props) {
                if (prop.propertyType === Date && typeof comp[prop.propertyKey] === 'string') {
                    comp[prop.propertyKey] = new Date(comp[prop.propertyKey]);
                }
            }
        }
        comp.setPersisted(true);
        comp.setDirty(false);
        addComponent(entity, comp);
    }

    entity.setPersisted(true);
    entity.setDirty(false);
    return entity;
}

export async function requireComponents(entity: Entity, ctors: Array<new (...args: any[]) => BaseComponent>): Promise<void> {
    if (ctors.length === 0) return;
    const missing: string[] = [];
    for (const ctor of ctors) {
        // components is keyed by type id — O(1) lookup, no instantiation
        // and no O(K) instanceof scan per constructor.
        const typeId = typeIdOf(ctor);
        if (!entity.components.has(typeId)) {
            missing.push(typeId);
        }
    }
    if (missing.length === 0) return;
    const { Entity } = await import("../Entity");
    await Entity.LoadComponents([entity], missing);
}

async function loadComponent<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<T | null> {
    const comp = entity.components.get(typeIdOf(ctor)) as T | undefined;
    if (typeof comp !== "undefined") {
        return comp;
    }

    // Validate entity ID before database query
    if (!entity.id || entity.id.trim() === '') {
        logger.warn(`Cannot load component ${ctor.name}: entity id is empty`);
        return null;
    }

    // Memoized metadata lookup — no throwaway component instantiation
    // just to read the type id.
    const typeId = typeIdOf(ctor);

    // Use transaction if provided, otherwise use default db
    const dbConn = context?.trx ?? db;

    // Ambient request scope fallback: bare entity.get() calls (e.g.
    // inside @ArcheTypeFunction bodies or Unwrap()) batch through the
    // request's DataLoaders instead of firing one SELECT per call.
    // Never substituted when the caller passed an explicit trx — a
    // loader read outside the transaction could see stale data.
    const scope = (!context?.loaders && !context?.trx) ? getRequestScope() : undefined;
    const loaders = context?.loaders ?? scope?.loaders;
    const signal = context?.signal ?? scope?.signal;

    try {
        let componentData: any = null;
        let componentId: string | null = null;

        if (loaders?.componentsByEntityType) {
            const loaderResult = await loaders.componentsByEntityType.load({
                entityId: entity.id,
                typeId: typeId
            });
            if (loaderResult) {
                componentData = loaderResult.data;
                componentId = loaderResult.id;
            }
        } else {
            // Route through runWithSignal so a request/wall-clock abort can
            // cancel this in-flight read. When dbConn is context.trx, an
            // uncancelled read leaks the backend into `idle in transaction`
            // on timeout (matches the d1dde84 save/delete fix, which missed
            // the read path).
            const rows = await runWithSignal<any[]>(
                dbConn`SELECT id, data FROM components WHERE entity_id = ${entity.id} AND type_id = ${typeId} AND deleted_at IS NULL`,
                signal
            );
            if (rows.length > 0) {
                componentData = rows[0].data;
                componentId = rows[0].id;
            }
        }

        if (componentData !== null) {
            const comp: any = new ctor();
            if (componentId) {
                comp.id = componentId;
            }
            const parsedData = typeof componentData === 'string' ? JSON.parse(componentData) : componentData;
            Object.assign(comp, parsedData);
            const storage = getMetadataStorage();
            const props = storage.componentProperties.get(typeId);
            if (props) {
                for (const prop of props) {
                    if (prop.propertyType === Date && typeof comp[prop.propertyKey] === 'string') {
                        comp[prop.propertyKey] = new Date(comp[prop.propertyKey]);
                    }
                }
            }
            comp.setPersisted(true);
            comp.setDirty(false);
            addComponent(entity, comp);
            return comp as T;
        } else {
            return null;
        }
    } catch (error) {
        logger.error(`Failed to fetch component ${ctor.name}: ${error}`);
        return null;
    }
}

export { loadComponent };
