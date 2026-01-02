import type { ComponentDataType, ComponentGetter, BaseComponent } from "@/core/components";
import { logger } from "./Logger";
import db from "database";
import EntityManager from "./EntityManager";
import ComponentRegistry from "@/core/components/ComponentRegistry";
import { uuidv7 } from "utils/uuid";
import { sql, SQL } from "bun";
// import Query from "./Query"; // Lazy import to avoid cycle
import { timed } from "./Decorators";
import EntityHookManager from "./EntityHookManager";
import { getMetadataStorage } from "./metadata";
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent, ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "./events/EntityLifecycleEvents";
import type { IEntity } from "./EntityInterface";

export class Entity implements IEntity {
    id: string;
    public _persisted: boolean = false;
    private components: Map<string, BaseComponent> = new Map<string, BaseComponent>();
    private removedComponents: Set<string> = new Set<string>();
    protected _dirty: boolean = false;

    constructor(id?: string) {
        // Use || instead of ?? to also handle empty strings
        this.id = (id && id.trim() !== '') ? id : uuidv7();
        this._dirty = true;
    }

    public static Create(): Entity {
        return new Entity();
    }

    protected addComponent(component: BaseComponent): Entity {
        this.components.set(component.getTypeID(), component);
        return this;
    }

    public componentList(): BaseComponent[] {
        return Array.from(this.components.values());
    }

    /**
     * Adds a new component to the entity.
     * Use like: entity.add(Component, { value: "Test" })
     */
    public add<T extends BaseComponent>(ctor: new (...args: any[]) => T, data?: Partial<ComponentDataType<T>>): this {
        const instance = new ctor();
        if (data) {
            Object.assign(instance, data);
        } else {
            Object.assign(instance, {});
        }
        this.addComponent(instance);
        this._dirty = true; 
        // Fire component added event
        try {
            EntityHookManager.executeHooks(new ComponentAddedEvent(this, instance));
        } catch (error) {
            logger.error(`Error firing component added hook for ${instance.getTypeID()}: ${error}`);
            // Don't fail the add operation if hooks fail
        }
        
        return this;
    }

    /**
     * Sets/updates a component on the entity.
     * If the component exists, it updates its properties.
     * If it doesn't exist, it adds a new component.
     * Use like: entity.set(Component, { value: "Test" })
     */
    public async set<T extends BaseComponent>(ctor: new (...args: any[]) => T, data: Partial<ComponentDataType<T>>): Promise<this> {
        await this.get(ctor);
        
        const component = Array.from(this.components.values()).find(comp => comp instanceof ctor) as T;
        if (component) {
            // Store old data for the update event
            const oldData = { ...component };
            
            // Update existing component
            Object.assign(component, data);
            component.setDirty(true);
            this._dirty = true;
            
            // Fire component updated event
            try {
                EntityHookManager.executeHooks(new ComponentUpdatedEvent(this, component, oldData, component));
            } catch (error) {
                logger.error(`Error firing component updated hook for ${component.getTypeID()}: ${error}`);
                // Don't fail the set operation if hooks fail
            }
        } else {
            // Add new component
            this.add(ctor, data);
            this._dirty = true;
            // Note: add() already fires ComponentAddedEvent, so we don't need to fire it again
        }
        return this;
    }

    /**
     * Removes a component from the entity.
     * Use like: entity.remove(Component)
     * WARNING: This will delete the component from the database upon saving the entity.
     * If you want to keep the component in the database but just remove it from the entity instance,
     * consider implementing a different method.
     */
    public remove<T extends BaseComponent>(ctor: new (...args: any[]) => T): boolean {
        const component = Array.from(this.components.values()).find(comp => comp instanceof ctor) as T;
        
        if (component) {
            // Track the component type for database deletion
            this.removedComponents.add(component.getTypeID());
            
            // Remove the component from the map
            this.components.delete(component.getTypeID());
            this._dirty = true;
            
            // Fire component removed event
            try {
                EntityHookManager.executeHooks(new ComponentRemovedEvent(this, component));
            } catch (error) {
                logger.error(`Error firing component removed hook for ${component.getTypeID()}: ${error}`);
                // Don't fail the remove operation if hooks fail
            }
            
            return true;
        }
        
        return false;
    }
    /**
     * Get component from entities. If entity is populated in query the component will get within the entity
     * If not it will fetch from database. Optionally uses DataLoader if context with loaders is provided.
     * @param ctor Component constructor
     * @param context Optional context containing DataLoader for batched loading (prevents connection pool exhaustion)
     * @returns `Component | null` *if entity doesn't have the component
     */
    public async get<T extends BaseComponent>(ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any } }): Promise<ComponentDataType<T> | null> {
        const comp = Array.from(this.components.values()).find(comp => comp instanceof ctor) as ComponentGetter<T> | undefined;
        if(typeof comp !== "undefined") {
            return comp.data();
        } else {
            // Validate entity ID before database query
            if (!this.id || this.id.trim() === '') {
                logger.warn(`Cannot get component ${ctor.name}: entity id is empty`);
                return null;
            }
            // fetch from db
            const temp = new ctor();
            const typeId = temp.getTypeID();
            try {
                let componentData: any = null;
                let componentId: string | null = null;

                // Use DataLoader if available (prevents N+1 queries and connection pool exhaustion)
                if (context?.loaders?.componentsByEntityType) {
                    const loaderResult = await context.loaders.componentsByEntityType.load({
                        entityId: this.id,
                        typeId: typeId
                    });
                    if (loaderResult) {
                        componentData = loaderResult.data;
                        componentId = loaderResult.id;  // Get component ID from DataLoader result
                    }
                } else {
                    // Fallback to direct DB call
                    const rows = await db`SELECT id, data FROM components WHERE entity_id = ${this.id} AND type_id = ${typeId} AND deleted_at IS NULL`;
                    if (rows.length > 0) {
                        componentData = rows[0].data;
                        componentId = rows[0].id;
                    }
                }

                if (componentData !== null) {
                    const comp: any = new ctor();
                    // Set the component ID from the database
                    if (componentId) {
                        comp.id = componentId;
                    }
                    const parsedData = typeof componentData === 'string' ? JSON.parse(componentData) : componentData;
                    Object.assign(comp, parsedData);
                    // Deserialize Date properties
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
                    this.addComponent(comp);
                    return comp.data();
                } else {
                    return null;
                }
            } catch (error) {
                logger.error(`Failed to fetch component: ${error}`);
                return null;
            }
        }
    }

    /**
     * Get a component from the entity.
     * @param ctor Constructor of the component to fetch
     * @param context Optional context containing DataLoader for batched loading (prevents connection pool exhaustion)
     * @returns Component instance or null if not found
     */
    public async getComponent<T extends BaseComponent>(ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any } }): Promise<T | null> {
        const comp = Array.from(this.components.values()).find(comp => comp instanceof ctor) as T | undefined;
        if(typeof comp !== "undefined") {
            return comp;
        } else {
            // Validate entity ID before database query
            if (!this.id || this.id.trim() === '') {
                logger.warn(`Cannot get component ${ctor.name}: entity id is empty`);
                return null;
            }
            // fetch from db
            const temp = new ctor();
            const typeId = temp.getTypeID();
            try {
                let componentData: any = null;
                let componentId: string | null = null;

                // Use DataLoader if available (prevents N+1 queries and connection pool exhaustion)
                if (context?.loaders?.componentsByEntityType) {
                    const loaderResult = await context.loaders.componentsByEntityType.load({
                        entityId: this.id,
                        typeId: typeId
                    });
                    if (loaderResult) {
                        componentData = loaderResult.data;
                        componentId = loaderResult.id;  // Get component ID from DataLoader result
                    }
                } else {
                    // Fallback to direct DB call
                    const rows = await db`SELECT id, data FROM components WHERE entity_id = ${this.id} AND type_id = ${typeId} AND deleted_at IS NULL`;
                    if (rows.length > 0) {
                        componentData = rows[0].data;
                        componentId = rows[0].id;
                    }
                }

                if (componentData !== null) {
                    const comp: any = new ctor();
                    // Set the component ID from the database
                    if (componentId) {
                        comp.id = componentId;
                    }
                    const parsedData = typeof componentData === 'string' ? JSON.parse(componentData) : componentData;
                    Object.assign(comp, parsedData);
                    // Deserialize Date properties
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
                    this.addComponent(comp);
                    return comp;
                } else {
                    return null;
                }
            } catch (error) {
                logger.error(`Failed to fetch component: ${error}`);
                return null;
            }
        }
    }

    @timed("Entity.save")
    public save(trx?: SQL) {
        return new Promise<boolean>((resolve, reject) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                logger.error(`Entity save timeout for entity ${this.id}`);
                reject(new Error(`Entity save timeout for entity ${this.id}`));
            }, 30000); // 30 second timeout

            if (trx) {
                // Use provided transaction
                this.doSave(trx)
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
            } else {
                // Create new transaction
                db.transaction(async (newTrx) => {
                    return await this.doSave(newTrx);
                })
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
            }
        });
    }

    public doSave(trx: SQL) {
        return new Promise<boolean>(async (resolve, reject) => {
            // Validate entity ID to prevent PostgreSQL UUID parsing errors
            if (!this.id || this.id.trim() === '') {
                logger.error(`Cannot save entity: id is empty or invalid`);
                return reject(new Error(`Cannot save entity: id is empty or invalid`));
            }

            if(!this._dirty) {
                logger.trace("Entity is not dirty, no need to save.");
                return resolve(true);
            }

            const wasNew = !this._persisted;
            const changedComponents = this.getDirtyComponents();

            const executeSave = async (saveTrx: SQL) => {
                if(!this._persisted) {
                    await saveTrx`INSERT INTO entities (id) VALUES (${this.id}) ON CONFLICT DO NOTHING`;
                    this._persisted = true;
                }

                // Delete removed components from database
                if (this.removedComponents.size > 0) {
                    const typeIds = Array.from(this.removedComponents);
                    await saveTrx`DELETE FROM components WHERE entity_id = ${this.id} AND type_id IN ${sql(typeIds)}`;
                    await saveTrx`DELETE FROM entity_components WHERE entity_id = ${this.id} AND type_id IN ${sql(typeIds)}`;
                    this.removedComponents.clear();
                }
                
                if(this.components.size === 0) {
                    logger.trace(`No components to save for entity ${this.id}`);
                    return;
                }
                
                // Batch inserts and updates for better performance
                const componentsToInsert = [];
                const entityComponentsToInsert = [];
                const componentsToUpdate = [];
                
                for(const comp of this.components.values()) {
                    const compName = comp.constructor.name;
                    if (!ComponentRegistry.isComponentReady(compName)) {
                        await ComponentRegistry.getReadyPromise(compName);
                    }
                    
                    if(!(comp as any)._persisted) {
                        if(comp.id === "") {
                            comp.id = uuidv7();
                        }
                        componentsToInsert.push({
                            id: comp.id,
                            entity_id: this.id,
                            name: compName,
                            type_id: comp.getTypeID(),
                            data: comp.serializableData()
                        });
                        entityComponentsToInsert.push({
                            entity_id: this.id,
                            type_id: comp.getTypeID(),
                            component_id: comp.id
                        });
                        (comp as any).setPersisted(true);
                        (comp as any).setDirty(false);
                    } else if((comp as any)._dirty) {
                        componentsToUpdate.push({
                            id: comp.id,
                            data: comp.serializableData()
                        });
                        (comp as any).setDirty(false);
                    }
                }
                
                // Perform batch inserts
                if(componentsToInsert.length > 0) {
                    await saveTrx`INSERT INTO components ${sql(componentsToInsert, 'id', 'entity_id', 'name', 'type_id', 'data')}`;
                    await saveTrx`INSERT INTO entity_components ${sql(entityComponentsToInsert, 'entity_id', 'type_id', 'component_id')} ON CONFLICT DO NOTHING`;
                }

                // Insert entity_components for existing components if entity is new
                if(!this._persisted) {
                    const existingEntityComponents = [];
                    for(const comp of this.components.values()) {
                        if((comp as any)._persisted) {
                            existingEntityComponents.push({
                                entity_id: this.id,
                                type_id: comp.getTypeID(),
                                component_id: comp.id
                            });
                        }
                    }
                    if(existingEntityComponents.length > 0) {
                        await saveTrx`INSERT INTO entity_components ${sql(existingEntityComponents, 'entity_id', 'type_id', 'component_id')} ON CONFLICT DO NOTHING`;
                    }
                }

                // Perform batch updates
                if(componentsToUpdate.length > 0) {
                    for(const comp of componentsToUpdate) {
                        // Validate component ID to prevent PostgreSQL UUID parsing errors
                        if (!comp.id || comp.id.trim() === '') {
                            logger.error(`Cannot update component: id is empty or invalid. Component data: ${JSON.stringify(comp.data).substring(0, 200)}`);
                            throw new Error(`Cannot update component: component id is empty or invalid`);
                        }
                        await saveTrx`UPDATE components SET data = ${comp.data} WHERE id = ${comp.id}`;
                    }
                }
            };

            await executeSave(trx);

            this._dirty = false;

            // Fire lifecycle events after successful save
            try {
                if (wasNew) {
                    await EntityHookManager.executeHooks(new EntityCreatedEvent(this));
                } else if (changedComponents.length > 0) {
                    await EntityHookManager.executeHooks(new EntityUpdatedEvent(this, changedComponents));
                }
            } catch (error) {
                logger.error(`Error firing lifecycle hooks for entity ${this.id}: ${error}`);
                // Don't fail the save operation if hooks fail
            }

            resolve(true);
        })
        
    }

    public delete(force: boolean = false) {
        return EntityManager.deleteEntity(this, force);
    }

    public doDelete(force: boolean = false) {
        return new Promise<boolean>(async resolve => {
            if(!this._persisted) {
                logger.warn("Entity is not persisted, cannot delete.");
                return resolve(false); 
            }
            try {
                await db.transaction(async (trx) => {
                    if(force) {
                        await trx`DELETE FROM entity_components WHERE entity_id = ${this.id}`;
                        await trx`DELETE FROM components WHERE entity_id = ${this.id}`;
                        await trx`DELETE FROM entities WHERE id = ${this.id}`;
                    } else {
                        await trx`UPDATE entities SET deleted_at = CURRENT_TIMESTAMP WHERE id = ${this.id} AND deleted_at IS NULL`;
                        await trx`UPDATE entity_components SET deleted_at = CURRENT_TIMESTAMP WHERE entity_id = ${this.id} AND deleted_at IS NULL`;
                        await trx`UPDATE components SET deleted_at = CURRENT_TIMESTAMP WHERE entity_id = ${this.id} AND deleted_at IS NULL`;
                    }
                });

                // Fire lifecycle event after successful deletion
                try {
                    await EntityHookManager.executeHooks(new EntityDeletedEvent(this, !force));
                } catch (error) {
                    logger.error(`Error firing delete lifecycle hook for entity ${this.id}: ${error}`);
                    // Don't fail the delete operation if hooks fail
                }

                resolve(true);
            } catch (error) {
                logger.error(`Failed to delete entity: ${error}`);
                resolve(false);
            }
        })
    }

    public setPersisted(persisted: boolean) {
        this._persisted = persisted;
    }

    public setDirty(dirty: boolean) {
        this._dirty = dirty;
    }

    /**
     * Get list of component type IDs that are dirty
     */
    private getDirtyComponents(): string[] {
        const dirtyComponents: string[] = [];
        for (const component of this.components.values()) {
            if ((component as any)._dirty) {
                dirtyComponents.push(component.getTypeID());
            }
        }
        return dirtyComponents;
    }


    @timed("Entity.LoadMultiple")
    public static async LoadMultiple(ids: string[]): Promise<Entity[]> {
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
                entitiesMap.get(entity_id)?.addComponent(comp);
            }
        }

        return Array.from(entitiesMap.values());
    }

    public static async LoadComponents(entities: Entity[], componentIds: string[]): Promise<void> {
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
                    entity.addComponent(comp);
                }
            }
        }
    }

    /**
     * Find an entity by its ID. Returning populated with all components. Or null if not found.
     * @param id Entity ID
     * @returns Entity | null
     */
    public static async FindById(id: string): Promise<Entity | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            logger.warn(`FindById called with invalid id: "${id}"`);
            return null;
        }
        const { Query } = await import("../query/Query");
        const entities = await new Query().findById(id).populate().exec()
        if(entities.length === 1) {
            return entities[0]!;
        }
        return null;
    }

    public static Clone(entity: Entity): Entity {
        const clone = new Entity();
        clone._dirty = true;
        clone._persisted = false;
        for (const comp of entity.components.values()) {
            const newComp = new (comp.constructor as any)();
            Object.assign(newComp, comp.data());
            newComp.id = uuidv7();
            newComp.setDirty(true);
            newComp.setPersisted(false);
            clone.addComponent(newComp);
        }
        return clone;
    }

    public static MakeRef(entity: Entity): Entity {
        const ref = new Entity();
        ref._dirty = true;
        ref._persisted = false;
        for (const comp of entity.components.values()) {
            const refComp = comp;
            refComp.setDirty(false);
            refComp.setPersisted(true);
            ref.addComponent(refComp);
        }
        return ref;
    }

    /**
     * Serialize the entity with only the currently loaded components
     * @returns Object containing id and components data
     */
    public serialize(): { id: string; components: Record<string, any> } {
        const components: Record<string, any> = {};
        for (const comp of this.components.values()) {
            components[comp.constructor.name] = comp.serializableData();
        }
        return {
            id: this.id,
            components
        };
    }


}

export default Entity;