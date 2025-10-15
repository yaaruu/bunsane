import type { ComponentDataType, ComponentGetter, BaseComponent } from "./Components";
import { logger } from "./Logger";
import db from "database";
import EntityManager from "./EntityManager";
import ComponentRegistry from "./ComponentRegistry";
import { uuidv7 } from "utils/uuid";
import { sql } from "bun";
// import Query from "./Query"; // Lazy import to avoid cycle
import { timed } from "./Decorators";
import EntityHookManager from "./EntityHookManager";
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent, ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "./events/EntityLifecycleEvents";
import type { IEntity } from "./EntityInterface";

export class Entity implements IEntity {
    id: string;
    public _persisted: boolean = false;
    private components: Map<string, BaseComponent> = new Map<string, BaseComponent>();
    private removedComponents: Set<string> = new Set<string>();
    protected _dirty: boolean = false;

    constructor(id?: string) {
        this.id = id ?? uuidv7();
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
     * Get component from entities. If entity is populated in query the component will get within the entitiy
     * If not it will fetch from database
     * @param Component
     * @returns `Component | null` *if entity doesn't have the component
     */
    public async get<T extends BaseComponent>(ctor: new (...args: any[]) => T): Promise<ComponentDataType<T> | null> {
        const comp = Array.from(this.components.values()).find(comp => comp instanceof ctor) as ComponentGetter<T> | undefined;
        if(typeof comp !== "undefined") {
            return comp.data();
        } else {
            // fetch from db
            const temp = new ctor();
            const typeId = temp.getTypeID();
            try {
                const rows = await db`SELECT id, data FROM components WHERE entity_id = ${this.id} AND type_id = ${typeId} AND deleted_at IS NULL`;
                if (rows.length > 0) {
                    const row = rows[0];
                    const comp = new ctor();
                    Object.assign(comp, row.data);
                    comp.id = row.id;
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
     * @returns Component instance or null if not found
     */
    public async getComponent<T extends BaseComponent>(ctor: new (...args: any[]) => T): Promise<T | null> {
        const comp = Array.from(this.components.values()).find(comp => comp instanceof ctor) as T | undefined;
        if(typeof comp !== "undefined") {
            return comp;
        } else {
            // fetch from db
            const temp = new ctor();
            const typeId = temp.getTypeID();
            try {
                const rows = await db`SELECT id, data FROM components WHERE entity_id = ${this.id} AND type_id = ${typeId} AND deleted_at IS NULL`;
                if (rows.length > 0) {
                    const row = rows[0];
                    const comp = new ctor();
                    Object.assign(comp, row.data);
                    comp.id = row.id;
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
    public save() {
        return new Promise<boolean>((resolve, reject) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                logger.error(`Entity save timeout for entity ${this.id}`);
                reject(new Error(`Entity save timeout for entity ${this.id}`));
            }, 30000); // 30 second timeout

            this.doSave()
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    

    public doSave() {
        return new Promise<boolean>(async resolve => {
            if(!this._dirty) {
                logger.trace("Entity is not dirty, no need to save.");
                return resolve(true); 
            }

            const wasNew = !this._persisted;
            const changedComponents = this.getDirtyComponents();

            await db.transaction(async (trx) => {
                if(!this._persisted) {
                    await trx`INSERT INTO entities (id) VALUES (${this.id}) ON CONFLICT DO NOTHING`;
                    this._persisted = true;
                }
                
                // Delete removed components from database
                if (this.removedComponents.size > 0) {
                    const typeIds = Array.from(this.removedComponents);
                    await trx`DELETE FROM components WHERE entity_id = ${this.id} AND type_id IN ${sql(typeIds)}`;
                    await trx`DELETE FROM entity_components WHERE entity_id = ${this.id} AND type_id IN ${sql(typeIds)}`;
                    this.removedComponents.clear();
                }
                
                if(this.components.size === 0) {
                    logger.trace(`No components to save for entity ${this.id}`);
                    return;
                }
                const waitable = [];
                for(const comp of this.components.values()) {
                    waitable.push(comp.save(trx, this.id));
                }
                await Promise.all(waitable);
            });

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
                console.log("Entity is not persisted, cannot delete.");
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

        const components = await db`
            SELECT c.id, c.entity_id, c.type_id, c.data
            FROM components c
            WHERE c.entity_id IN ${sql(ids)} AND c.deleted_at IS NULL
        `;

        const entitiesMap = new Map<string, Entity>();

        for (const id of ids) {
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
                Object.assign(comp, data);
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

        const entityIds = entities.map(e => e.id);

        const components = await db`
            SELECT c.id, c.entity_id, c.type_id, c.data
            FROM components c
            WHERE c.entity_id IN ${sql(entityIds)} AND c.type_id IN ${sql(componentIds)} AND c.deleted_at IS NULL
        `;

        for (const row of components) {
            const { id, entity_id, type_id, data } = row;
            const entity = entities.find(e => e.id === entity_id);
            if (entity) {
                const ctor = ComponentRegistry.getConstructor(type_id);
                if (ctor) {
                    const comp = new ctor();
                    Object.assign(comp, data);
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
        const { default: Query } = await import("./Query");
        const entities = await new Query().findById(id).populate().exec()
        if(entities.length === 1) {
            return entities[0]!;
        }
        return null;
    }
}