// Entity loaders, clone/ref factories, and (de)serialization. Extracted
// from Entity.ts (RFC_REFACTOR_TARGETS §3.2). Functions take/return the
// Entity instance; the Entity class is imported lazily where construction
// is needed to avoid a module-eval cycle.
import { logger } from "../Logger";
import { dbRun } from "../../database/gateway";
import ComponentRegistry from "../components/ComponentRegistry";
import { uuidv7 } from "../../utils/uuid";
import { sql, SQL } from "bun";
import { addComponent } from "./componentAccess";
import { hydrateComponentRow } from "./hydrateComponentRow";
import { getCacheManager } from "./getCacheManager";
import { COMPONENT_TOMBSTONE } from "../cache/CacheManager";
import { trackCacheOp } from "./pendingOps";
// Value import: the Entity class is only referenced inside function bodies
// (called at runtime, after module init), so the ESM cycle with Entity.ts
// resolves via live bindings without a load-order hazard.
import { Entity } from "../Entity";

export async function loadMultiple(ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];

    // Filter out empty/invalid IDs to prevent PostgreSQL UUID parsing errors
    const validIds = ids.filter(id => id && id.trim() !== '');
    if (validIds.length === 0) return [];
    if (validIds.length !== ids.length) {
        logger.warn(`LoadMultiple: Filtered out ${ids.length - validIds.length} invalid entity IDs`);
    }

    const components = await dbRun<any[]>((conn) => conn`
        SELECT c.id, c.entity_id, c.type_id, c.data
        FROM components c
        WHERE c.entity_id IN ${sql(validIds)} AND c.deleted_at IS NULL
    `, "finders.loadMultiple", { lane: "request", label: "finders.loadMultiple" });

    const entitiesMap = new Map<string, Entity>();

    for (const id of validIds) {
        const entity = new Entity();
        entity.id = id;
        entity.setPersisted(true);
        entity.setDirty(false);
        entitiesMap.set(id, entity);
    }

    for (const row of components) {
        const { id, entity_id, type_id, data } = row;
        const ctor = ComponentRegistry.getConstructor(type_id);
        if (ctor) {
            const target = entitiesMap.get(entity_id);
            if (target) addComponent(target, hydrateComponentRow(ctor, { id, data, typeId: type_id }));
        }
    }

    return Array.from(entitiesMap.values());
}

type EagerComponentRow = {
    id: string;
    entity_id: string;
    type_id: string;
    data: unknown;
    created_at?: Date;
    updated_at?: Date;
    deleted_at?: Date | null;
};

function pairKey(entityId: string, typeId: string): string {
    return `${entityId}\0${typeId}`;
}

export async function loadComponents(entities: Entity[], componentIds: string[], skipCache: boolean = false): Promise<void> {
    if (entities.length === 0 || componentIds.length === 0) return;

    // Filter out entities with empty/invalid IDs to prevent PostgreSQL UUID parsing errors
    const validEntities = entities.filter(e => e.id && e.id.trim() !== '');
    if (validEntities.length === 0) return;

    type Pending = { entity: Entity; typeId: string };
    const pending: Pending[] = [];
    for (const entity of validEntities) {
        for (const typeId of componentIds) {
            if (entity.components.has(typeId)) continue;
            // skipCache also bypasses the entity-local negative cache so the
            // caller gets a fresh read. Otherwise a confirmed absence is final.
            if (!skipCache && entity._missingComponents.has(typeId)) continue;
            pending.push({ entity, typeId });
        }
    }
    if (pending.length === 0) return;

    const resolved = new Set<string>();
    const cacheManager = skipCache ? null : getCacheManager().getInstance();
    const cacheConfig = cacheManager?.getConfig();
    const cacheOn = !!cacheConfig?.enabled && !!cacheConfig.component?.enabled;

    if (cacheOn && cacheManager) {
        try {
            const cached = await cacheManager.getComponents(pending.map((p) => ({ entityId: p.entity.id, typeId: p.typeId })));
            for (let i = 0; i < cached.length; i++) {
                const value = cached[i];
                const req = pending[i]!;
                const key = pairKey(req.entity.id, req.typeId);
                if (value === COMPONENT_TOMBSTONE) {
                    req.entity._missingComponents.add(req.typeId);
                    resolved.add(key);
                } else if (value) {
                    const ctor = ComponentRegistry.getConstructor(req.typeId);
                    if (ctor) {
                        addComponent(req.entity, hydrateComponentRow(ctor, { id: value.id, data: value.data, typeId: req.typeId }));
                    }
                    resolved.add(key);
                }
            }
        } catch (error) {
            logger.warn({ scope: "cache", component: "finders", msg: "Cache read failed, falling back to database", error });
        }
    }

    const missing = pending.filter((p) => !resolved.has(pairKey(p.entity.id, p.typeId)));
    if (missing.length === 0) return;

    const entityIds: string[] = [];
    const typeIds: string[] = [];
    const seenEntities = new Set<string>();
    const seenTypes = new Set<string>();
    for (const item of missing) {
        if (!seenEntities.has(item.entity.id)) {
            seenEntities.add(item.entity.id);
            entityIds.push(item.entity.id);
        }
        if (!seenTypes.has(item.typeId)) {
            seenTypes.add(item.typeId);
            typeIds.push(item.typeId);
        }
    }

    const rows = await dbRun<EagerComponentRow[]>((conn) => conn`
        SELECT c.id, c.entity_id, c.type_id, c.data, c.created_at, c.updated_at, c.deleted_at
        FROM components c
        WHERE c.entity_id IN ${sql(entityIds)} AND c.type_id IN ${sql(typeIds)} AND c.deleted_at IS NULL
    `, "finders.eagerLoad", { lane: "request", label: "finders.eagerLoad" });

    const entityMap = new Map<string, Entity>(validEntities.map(e => [e.id, e]));
    const missingKeys = new Set(missing.map((item) => pairKey(item.entity.id, item.typeId)));
    const found = new Set<string>();
    const cacheRows: Array<{
        id: string;
        entityId: string;
        typeId: string;
        data: unknown;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }> = [];

    for (const row of rows) {
        const key = pairKey(row.entity_id, row.type_id);
        if (!missingKeys.has(key)) continue;
        found.add(key);
        const entity = entityMap.get(row.entity_id);
        const ctor = ComponentRegistry.getConstructor(row.type_id);
        if (entity && ctor && !entity.components.has(row.type_id)) {
            addComponent(entity, hydrateComponentRow(ctor, { id: row.id, data: row.data, typeId: row.type_id }));
        }
        if (cacheOn) {
            cacheRows.push({
                id: row.id,
                entityId: row.entity_id,
                typeId: row.type_id,
                data: row.data,
                createdAt: row.created_at ?? new Date(),
                updatedAt: row.updated_at ?? new Date(),
                deletedAt: row.deleted_at ?? null,
            });
        }
    }

    for (const item of missing) {
        if (!found.has(pairKey(item.entity.id, item.typeId))) {
            item.entity._missingComponents.add(item.typeId);
        }
    }

    if (cacheOn && cacheManager) {
        const requested = missing.map((item) => ({ entityId: item.entity.id, typeId: item.typeId }));
        const ttl = cacheConfig?.component?.ttl;
        trackCacheOp(
            cacheManager.setComponentsWriteThrough(cacheRows, requested, ttl)
                .catch((error) => logger.warn({ scope: "cache", component: "finders", msg: "Cache write failed after eager load", error }))
        );
    }
}

/**
 * Find an entity by its ID. Returning populated with all components. Or null if not found.
 */
export async function findById(id: string, trx?: SQL): Promise<Entity | null> {
    // Validate ID to prevent PostgreSQL UUID parsing errors
    if (!id || typeof id !== 'string' || id.trim() === '') {
        logger.warn(`FindById called with invalid id: "${id}"`);
        return null;
    }
    const { Query } = await import("../../query/Query");
    const entities = await new Query(trx).findById(id).populate().exec()
    if (entities.length === 1) {
        return entities[0]!;
    }
    return null;
}

export function clone(entity: Entity): Entity {
    const clone = new Entity();
    clone.setDirty(true);
    clone.setPersisted(false);
    for (const comp of entity.components.values()) {
        const newComp = new (comp.constructor as any)();
        Object.assign(newComp, comp.data());
        newComp.id = uuidv7();
        newComp.setDirty(true);
        newComp.setPersisted(false);
        addComponent(clone, newComp);
    }
    return clone;
}

export function makeRef(entity: Entity): Entity {
    const ref = new Entity();
    ref.setDirty(true);
    ref.setPersisted(false);
    for (const comp of entity.components.values()) {
        const refComp = comp;
        refComp.setDirty(false);
        refComp.setPersisted(true);
        addComponent(ref, refComp);
    }
    return ref;
}

/**
 * Serialize the entity with only the currently loaded components
 */
export function serialize(entity: Entity): { id: string; components: Record<string, any> } {
    const components: Record<string, any> = {};
    for (const comp of entity.components.values()) {
        components[comp.constructor.name] = comp.serializableData();
    }
    return {
        id: entity.id,
        components
    };
}

/**
 * Deserialize/reconstitute an Entity from cached/serialized data.
 */
export function deserialize(data: any): Entity {
    if (data instanceof Entity) {
        return data;
    }

    const entity = new Entity(data.id);
    entity.setPersisted(true);
    entity.setDirty(false);

    // Handle serialized format: { id, components: { ComponentName: {...data} } }
    if (data.components && typeof data.components === 'object') {
        for (const [componentName, componentData] of Object.entries(data.components)) {
            const ComponentCtor = ComponentRegistry.getConstructorByName(componentName);
            if (!ComponentCtor) {
                logger.warn(`Cannot deserialize component: constructor not found for ${componentName}`);
                continue;
            }
            const parsedData = typeof componentData === 'string' ? JSON.parse(componentData) : componentData;
            addComponent(entity, hydrateComponentRow(ComponentCtor, { data: parsedData }));
        }
    }

    return entity;
}
