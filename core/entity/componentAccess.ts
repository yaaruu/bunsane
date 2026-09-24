// Component access + mutation for Entity (add/set/remove/get/has/reload
// and the in-memory helpers). Extracted from Entity.ts
// (RFC_REFACTOR_TARGETS §3.2). Pure functions take the entity instance as
// the first parameter; hook phases/order match the original inline implementation.
import type { ComponentDataType, ComponentGetter, BaseComponent } from "../components";
import { logger } from "../Logger";
import { dbRun } from "../../database/gateway";
import { runWithSignal } from "../../database/cancellable";
import ComponentRegistry from "../components/ComponentRegistry";
import { SQL } from "bun";
import EntityHookManager from "../EntityHookManager";
import { getMetadataStorage } from "../metadata";
import { ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "../events/EntityLifecycleEvents";
import { getRequestScope } from "../requestScope";
import { trackCacheOp } from "./pendingOps";
import { getCacheManager } from "./getCacheManager";
import { COMPONENT_TOMBSTONE } from "../cache/CacheManager";
import type { Entity } from "../Entity";
import { hydrateComponentRow } from "./hydrateComponentRow";
import { ComponentLoadError, ComponentMissingError } from "./errors";

export { ComponentLoadError, ComponentMissingError };

export type ComponentAccessContext = {
    loaders?: { componentsByEntityType?: ComponentsByEntityTypeLoader };
    trx?: SQL;
    signal?: AbortSignal;
};

type ComponentsByEntityTypeLoader = {
    load(key: { entityId: string; typeId: string }): Promise<unknown>;
    clear(key: { entityId: string; typeId: string }): void;
};

type PersistenceFlags = { _dirty: boolean; _persisted: boolean };

function flagsOf(target: object): PersistenceFlags {
    return target as unknown as PersistenceFlags;
}

function readLoaderRow(value: unknown): { id: string | null; data: unknown } | null {
    if (value == null || typeof value !== "object") return null;
    const rec = value as unknown as Record<string, unknown>;
    const id = rec.id;
    return { id: typeof id === "string" ? id : null, data: rec.data };
}

export function addComponent(entity: Entity, component: BaseComponent): Entity {
    const typeId = component.getTypeID();
    entity.components.set(typeId, component);
    // A component that just arrived can never be "missing" — clear any
    // previously recorded absence so future get() calls see the new data.
    entity._missingComponents.delete(typeId);
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

export async function set<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, data: Partial<ComponentDataType<T>>, context?: ComponentAccessContext): Promise<Entity> {
    await get(entity, ctor, context);

    const component = entity.components.get(typeIdOf(ctor)) as T | undefined;
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

        // Invalidate DataLoader cache if context is provided. Shared cache
        // I/O waits until save() commits — publishing here would let a
        // concurrent miss refill L2 with the pre-commit row (or with data
        // that never landed). save() invalidates / write-throughs after commit.
        if (context?.loaders?.componentsByEntityType) {
            context.loaders.componentsByEntityType.clear({
                entityId: entity.id,
                typeId: component.getTypeID()
            });
        }
    } else {
        // Add new component
        add(entity, ctor, data);
        entity.setDirty(true);
        // Note: add() already fires ComponentAddedEvent, so we don't need to fire it again
    }
    return entity;
}

/**
 * Remove a component. If it is not loaded, the type id is still enqueued so
 * `save()` deletes the row. Returns false only when this session already
 * saved that deletion. `has()` stays an in-memory check — use `hasPersisted`
 * to ask the loader.
 */
export function remove<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: ComponentAccessContext): boolean {
    const typeId = typeIdOf(ctor);
    const component = entity.components.get(typeId) as T | undefined;

    if (component) {
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

        // Invalidate DataLoader cache if context is provided. Shared cache
        // invalidation runs post-commit from save(), which already covers
        // removed type ids.
        if (context?.loaders?.componentsByEntityType) {
            context.loaders.componentsByEntityType.clear({
                entityId: entity.id,
                typeId: typeId
            });
        }

        return true;
    }

    if (entity.savedRemovedComponents.has(typeId)) {
        return false;
    }
    if (entity.removedComponents.has(typeId)) {
        return true;
    }

    // Not in memory. Still record the deletion so save() issues the DELETE
    // even when the caller never hydrated the component (loaded-by-id).
    entity.removedComponents.add(typeId);
    entity._missingComponents.delete(typeId);
    entity.setDirty(true);
    if (context?.loaders?.componentsByEntityType) {
        context.loaders.componentsByEntityType.clear({
            entityId: entity.id,
            typeId
        });
    }
    return true;
}

/**
 * Get component data. Loads from the DB when not in memory.
 *
 * The returned object is a snapshot of `@CompData` fields. Mutating it does
 * not change the component and does not mark the entity dirty — use `set()`.
 */
export async function get<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: ComponentAccessContext): Promise<ComponentDataType<T> | null> {
    const comp = await loadComponent(entity, ctor, context);
    return comp ? (comp as ComponentGetter<T>).data() : null;
}

/**
 * In-memory presence only. A component that exists in the database but has
 * not been loaded returns false. Use `hasPersisted()` for a loader/DB check,
 * or `get()` to load it.
 */
export function has<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): boolean {
    return hasInMemory(entity, ctor);
}

/**
 * True when a saved row exists (or the in-memory instance is already marked
 * persisted). Consults the loader / database when the component is not in
 * memory. A pending or completed `remove()` returns false and does not
 * rehydrate the row.
 */
export async function hasPersisted<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: ComponentAccessContext): Promise<boolean> {
    const typeId = typeIdOf(ctor);
    const inMem = entity.components.get(typeId);
    if (inMem) return flagsOf(inMem)._persisted;
    if (entity.removedComponents.has(typeId) || entity.savedRemovedComponents.has(typeId)) {
        return false;
    }
    const loaded = await loadComponent(entity, ctor, context);
    return loaded !== null;
}

/**
 * Get component data or throw if not found.
 * A database failure throws `ComponentLoadError`. A confirmed absence throws
 * `ComponentMissingError`.
 */
export async function getOrThrow<T extends BaseComponent>(
    entity: Entity,
    ctor: new (...args: any[]) => T,
    context?: ComponentAccessContext
): Promise<ComponentDataType<T>> {
    const data = await get(entity, ctor, context);
    if (data === null) {
        throw new ComponentMissingError(entity.id, ctor.name);
    }
    return data;
}

export function getCached<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T): ComponentDataType<T> | undefined {
    const comp = getInMemory(entity, ctor);
    return comp ? (comp as ComponentGetter<T>).data() : undefined;
}

export async function getInstanceOf<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: ComponentAccessContext): Promise<T | null> {
    return loadComponent(entity, ctor, context);
}

export async function reload(entity: Entity, opts?: { trx?: SQL; signal?: AbortSignal }): Promise<Entity> {
    if (!entity.id || entity.id.trim() === '') {
        return entity;
    }
    entity.components.clear();
    entity.removedComponents.clear();
    entity.savedRemovedComponents.clear();
    entity._missingComponents.clear();

    // Caller-supplied trx stays a raw template: the enclosing transaction
    // already holds the admission permit. Bare reads go through the gateway.
    const rows = opts?.trx
        ? await runWithSignal<ComponentSelectRow[]>(
            opts.trx`
            SELECT c.id, c.type_id, c.data
            FROM components c
            WHERE c.entity_id = ${entity.id} AND c.deleted_at IS NULL
        `,
            opts.signal
        )
        : await dbRun<ComponentSelectRow[]>(
            (conn) => conn`
            SELECT c.id, c.type_id, c.data
            FROM components c
            WHERE c.entity_id = ${entity.id} AND c.deleted_at IS NULL
        `,
            "entity.reload",
            { lane: "request", label: "entity.reload", signal: opts?.signal },
        );

    for (const row of rows) {
        const ctor = ComponentRegistry.getConstructor(row.type_id);
        if (!ctor) continue;
        addComponent(entity, hydrateComponentRow(ctor, { id: row.id, data: row.data, typeId: row.type_id }));
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

type ComponentSelectRow = {
    id: string;
    entity_id?: string;
    type_id: string;
    data: unknown;
    created_at?: Date;
    updated_at?: Date;
    deleted_at?: Date | null;
};

async function loadComponent<T extends BaseComponent>(entity: Entity, ctor: new (...args: any[]) => T, context?: ComponentAccessContext): Promise<T | null> {
    const typeId = typeIdOf(ctor);
    const comp = entity.components.get(typeId) as T | undefined;
    if (typeof comp !== "undefined") {
        return comp;
    }

    // Validate entity ID before database query
    if (!entity.id || entity.id.trim() === '') {
        logger.warn(`Cannot load component ${ctor.name}: entity id is empty`);
        return null;
    }

    // A removal recorded this session must not be resurrected by get().
    if (entity.removedComponents.has(typeId) || entity.savedRemovedComponents.has(typeId)) {
        return null;
    }

    // Negative-cache short-circuit: if we previously confirmed this component
    // is absent from the DB (and no explicit transaction is in scope that
    // could see a different snapshot), skip the SELECT entirely.
    // Skipped when a trx is provided — within a transaction the visibility
    // horizon may differ from the outer read (stale-read hazard).
    if (!context?.trx && entity._missingComponents.has(typeId)) {
        return null;
    }

    // Ambient request scope fallback: bare entity.get() calls (e.g.
    // inside @ArcheTypeFunction bodies or Unwrap()) batch through the
    // request's DataLoaders instead of firing one SELECT per call.
    // Never substituted when the caller passed an explicit trx — a
    // loader read outside the transaction could see stale data.
    const scope = (!context?.loaders && !context?.trx) ? getRequestScope() : undefined;
    const loaders = context?.loaders ?? scope?.loaders;
    const signal = context?.signal ?? scope?.signal;

    try {
        let componentData: unknown = null;
        let componentId: string | null = null;

        if (loaders?.componentsByEntityType) {
            const loaderResult = readLoaderRow(await loaders.componentsByEntityType.load({
                entityId: entity.id,
                typeId: typeId
            }));
            if (loaderResult) {
                componentData = loaderResult.data;
                componentId = loaderResult.id;
            }
        } else {
            // Bare path (no request loaders): consult the shared cache first,
            // exactly like the DataLoader path does. Skipped inside an explicit
            // transaction — the cache cannot see the trx's uncommitted writes.
            // A tombstone hit is a confirmed absence.
            const cacheManager = context?.trx ? null : getCacheManager().getInstance();
            const cacheConfig = cacheManager?.getConfig();
            const cacheOn = Boolean(cacheConfig?.enabled && cacheConfig.component?.enabled);
            let cacheDecided = false;
            if (cacheOn && cacheManager) {
                try {
                    const [cached] = await cacheManager.getComponents([{ entityId: entity.id, typeId }]);
                    if (cached === COMPONENT_TOMBSTONE) {
                        cacheDecided = true;
                    } else if (cached) {
                        componentData = cached.data;
                        componentId = cached.id;
                        cacheDecided = true;
                    }
                } catch (error) {
                    logger.warn({ scope: 'cache', component: 'componentAccess', msg: 'Cache read failed, falling back to database', error });
                }
            }

            if (!cacheDecided) {
                // Bare reads take a gateway permit (lane request, statement
                // timeout). A caller-supplied trx is already admitted — keep
                // the raw template so we do not wait for a second permit
                // while holding the connection.
                const rows = context?.trx
                    ? await runWithSignal<ComponentSelectRow[]>(
                        context.trx`SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at FROM components WHERE entity_id = ${entity.id} AND type_id = ${typeId} AND deleted_at IS NULL`,
                        signal
                    )
                    : await dbRun<ComponentSelectRow[]>(
                        (conn) => conn`SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at FROM components WHERE entity_id = ${entity.id} AND type_id = ${typeId} AND deleted_at IS NULL`,
                        "entity.component.get",
                        { lane: "request", label: "entity.component.get", signal },
                    );
                if (rows.length > 0) {
                    componentData = rows[0]!.data;
                    componentId = rows[0]!.id;
                }
                if (cacheOn && cacheManager) {
                    // Write-through (or tombstone the absence). Fire-and-forget
                    // like the other cache writes in this module.
                    const requested = [{ entityId: entity.id, typeId }];
                    const found = [];
                    if (rows.length > 0) {
                        const row = rows[0]!;
                        const createdAt = row.created_at instanceof Date ? row.created_at : new Date();
                        const updatedAt = row.updated_at instanceof Date ? row.updated_at : createdAt;
                        found.push({
                            id: row.id,
                            entityId: row.entity_id ?? entity.id,
                            typeId: row.type_id,
                            data: row.data,
                            createdAt,
                            updatedAt,
                            deletedAt: row.deleted_at ?? null,
                        });
                    }
                    const ttl = cacheConfig?.component?.ttl;
                    trackCacheOp(
                        cacheManager.setComponentsWriteThrough(found, requested, ttl)
                            .catch((error) => logger.warn({ scope: 'cache', component: 'componentAccess', msg: 'Cache write failed after component fetch', error }))
                    );
                }
            }
        }

        if (componentData !== null) {
            const hydrated = hydrateComponentRow(ctor, {
                id: componentId,
                data: componentData,
                typeId,
            });
            addComponent(entity, hydrated);
            return hydrated;
        }

        // Record the confirmed absence so repeated probes skip the DB.
        // Only when no explicit trx — within a transaction the caller
        // may insert the component and probe again in the same scope.
        // A thrown read must NOT land here: absence is a zero-row result.
        if (!context?.trx) {
            entity._missingComponents.add(typeId);
        }
        return null;
    } catch (error) {
        if (error instanceof ComponentLoadError) throw error;
        logger.error(`Failed to fetch component ${ctor.name}: ${error}`);
        throw new ComponentLoadError(entity.id, ctor.name, error);
    }
}

export { loadComponent };
