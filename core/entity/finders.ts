// Entity loaders, clone/ref factories, and (de)serialization. Extracted
// from Entity.ts (RFC_REFACTOR_TARGETS §3.2). Functions take/return the
// Entity instance; the Entity class is imported lazily where construction
// is needed to avoid a module-eval cycle.
import { logger } from "../Logger";
import db from "../../database";
import ComponentRegistry from "../components/ComponentRegistry";
import { uuidv7 } from "../../utils/uuid";
import { sql, SQL } from "bun";
import { getMetadataStorage } from "../metadata";
import { addComponent } from "./componentAccess";
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

    const components = await db`
        SELECT c.id, c.entity_id, c.type_id, c.data
        FROM components c
        WHERE c.entity_id IN ${sql(validIds)} AND c.deleted_at IS NULL
    `;

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
            const comp = new ctor();
            const componentData = typeof data === 'string' ? JSON.parse(data) : data;
            Object.assign(comp, componentData);
            comp.id = id;
            comp.setPersisted(true);
            comp.setDirty(false);
            const target = entitiesMap.get(entity_id);
            if (target) addComponent(target, comp);
        }
    }

    return Array.from(entitiesMap.values());
}

export async function loadComponents(entities: Entity[], componentIds: string[], skipCache: boolean = false): Promise<void> {
    if (entities.length === 0 || componentIds.length === 0) return;

    // Filter out entities with empty/invalid IDs to prevent PostgreSQL UUID parsing errors
    const validEntities = entities.filter(e => e.id && e.id.trim() !== '');
    if (validEntities.length === 0) return;

    const entityIds = validEntities.map(e => e.id);

    const components = await db`
        SELECT c.id, c.entity_id, c.type_id, c.data
        FROM components c
        WHERE c.entity_id IN ${sql(entityIds)} AND c.type_id IN ${sql(componentIds)} AND c.deleted_at IS NULL
    `;

    // Use Map for O(1) lookups instead of O(n) find() - fixes O(n²) performance issue
    const entityMap = new Map<string, Entity>(validEntities.map(e => [e.id, e]));

    for (const row of components) {
        const { id, entity_id, type_id, data } = row;
        const entity = entityMap.get(entity_id);  // O(1) instead of O(n)
        if (entity) {
            const ctor = ComponentRegistry.getConstructor(type_id);
            if (ctor) {
                const comp = new ctor();
                const componentData = typeof data === 'string' ? JSON.parse(data) : data;
                Object.assign(comp, componentData);
                comp.id = id;
                comp.setPersisted(true);
                comp.setDirty(false);
                addComponent(entity, comp);
            }
        }
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
        const storage = getMetadataStorage();

        for (const [componentName, componentData] of Object.entries(data.components)) {
            // Find the component constructor by name
            const ComponentCtor = ComponentRegistry.getConstructorByName(componentName);
            if (!ComponentCtor) {
                logger.warn(`Cannot deserialize component: constructor not found for ${componentName}`);
                continue;
            }

            const comp = new ComponentCtor();
            const parsedData = typeof componentData === 'string' ? JSON.parse(componentData) : componentData;
            Object.assign(comp, parsedData);

            // Restore Date objects
            const typeId = comp.getTypeID();
            const props = storage.componentProperties.get(typeId);
            if (props) {
                for (const prop of props) {
                    if (prop.propertyType === Date && typeof (comp as any)[prop.propertyKey] === 'string') {
                        (comp as any)[prop.propertyKey] = new Date((comp as any)[prop.propertyKey]);
                    }
                }
            }

            comp.setPersisted(true);
            comp.setDirty(false);
            addComponent(entity, comp);
        }
    }

    return entity;
}
