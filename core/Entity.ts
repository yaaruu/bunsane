import type { ComponentDataType, BaseComponent } from "./components";
import { uuidv7 } from "../utils/uuid";
import { SQL } from "bun";
import { timed } from "./Decorators";
import type { IEntity } from "./EntityInterface";
import EntityManager from "./EntityManager";
import * as pendingOps from "./entity/pendingOps";
import * as componentAccess from "./entity/componentAccess";
import * as saveEntity from "./entity/saveEntity";
import * as finders from "./entity/finders";

export class Entity implements IEntity {
    id: string;
    public _persisted: boolean = false;
    /** @internal Promoted from private for the core/entity/ submodule split (RFC §3.2). Not part of the public API. */
    public components: Map<string, BaseComponent> = new Map<string, BaseComponent>();
    /** @internal Promoted from private for the core/entity/ submodule split (RFC §3.2). Not part of the public API. */
    public removedComponents: Set<string> = new Set<string>();
    // Track components that were removed and already saved to DB
    // This persists after save() so resolvers can detect removed components
    /** @internal Promoted from private for the core/entity/ submodule split (RFC §3.2). Not part of the public API. */
    public savedRemovedComponents: Set<string> = new Set<string>();
    /**
     * @internal Type IDs confirmed absent from the DB during this entity's
     * lifetime. Used as a negative cache in loadComponent() so repeated
     * get() probes for optional components skip the SELECT. Invalidated
     * whenever a component is added (addComponent) or the entity is
     * reloaded. Not part of the public API.
     */
    public _missingComponents: Set<string> = new Set<string>();
    protected _dirty: boolean = false;

    constructor(id?: string) {
        // Use || instead of ?? to also handle empty strings
        this.id = (id && id.trim() !== '') ? id : uuidv7();
        this._dirty = true;
    }

    public static Create(): Entity {
        return new Entity();
    }

    public static CreateWithId(id: string): Entity {
        return new Entity(id);
    }

    // --- Drainable background-work delegates (core/entity/pendingOps.ts) ---

    /**
     * Await all pending background cache operations. Call during shutdown
     * after HTTP drain but before cache.disconnect so setImmediate'd cache
     * writes are not lost. Bounded by `timeoutMs`.
     */
    public static drainPendingCacheOps(timeoutMs: number = 5_000): Promise<void> {
        return pendingOps.drainPendingCacheOps(timeoutMs);
    }

    /**
     * Await all pending post-commit side effects (cache invalidation +
     * lifecycle hooks scheduled via queueMicrotask from save()). Call from
     * test setup/teardown hooks under PGlite to guarantee prior-file
     * background work has settled before the next file's saves run. Bounded
     * by `timeoutMs`. Safe to call repeatedly; no-op when the set is empty.
     */
    public static drainPendingSideEffects(timeoutMs: number = 5_000): Promise<void> {
        return pendingOps.drainPendingSideEffects(timeoutMs);
    }

    /**
     * Track a fire-and-forget cache promise in the drainable set. Public so
     * other framework read paths (e.g. Query.populateComponents cache
     * warming) share the same drain semantics (H-CACHE-1).
     */
    public static trackCacheOp(p: Promise<void>): void {
        pendingOps.trackCacheOp(p);
    }

    // --- Component access (core/entity/componentAccess.ts) ---

    /** @internal Promoted from protected for the core/entity/ submodule split (RFC §3.2). Query.ts / RequestLoaders.ts already cast to call this. */
    public addComponent(component: BaseComponent): Entity {
        return componentAccess.addComponent(this, component);
    }

    public componentList(): BaseComponent[] {
        return componentAccess.componentList(this);
    }

    /**
     * Synchronously check if a component is already loaded in memory.
     * This does NOT trigger a database fetch - use get() for that.
     */
    public getInMemory<T extends BaseComponent>(ctor: new (...args: any[]) => T): T | undefined {
        return componentAccess.getInMemory(this, ctor);
    }

    /**
     * Check if a component exists in memory (synchronous, no DB fetch).
     */
    public hasInMemory<T extends BaseComponent>(ctor: new (...args: any[]) => T): boolean {
        return componentAccess.hasInMemory(this, ctor);
    }

    /**
     * Check if a component was explicitly removed from this entity (pending or already saved deletion).
     */
    public wasRemoved<T extends BaseComponent>(ctor: new (...args: any[]) => T): boolean {
        return componentAccess.wasRemoved(this, ctor);
    }

    /**
     * Adds a new component to the entity.
     * Use like: entity.add(Component, { value: "Test" })
     */
    public add<T extends BaseComponent>(ctor: new (...args: any[]) => T, data?: Partial<ComponentDataType<T>>): this {
        componentAccess.add(this, ctor, data);
        return this;
    }

    /**
     * Sets/updates a component on the entity.
     */
    public async set<T extends BaseComponent>(ctor: new (...args: any[]) => T, data: Partial<ComponentDataType<T>>, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<this> {
        await componentAccess.set(this, ctor, data, context);
        return this;
    }

    /**
     * Removes a component from the entity.
     * Use like: entity.remove(Component)
     * WARNING: This will delete the component from the database upon saving the entity.
     */
    public remove<T extends BaseComponent>(ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): boolean {
        return componentAccess.remove(this, ctor, context);
    }

    /**
     * Get component data from entity. Loads from DB if not cached.
     */
    public get<T extends BaseComponent>(ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<ComponentDataType<T> | null> {
        return componentAccess.get(this, ctor, context);
    }

    /**
     * Check if entity has a component (type guard).
     * Uses in-memory check only - does not query database.
     */
    public has<T extends BaseComponent>(ctor: new (...args: any[]) => T): boolean {
        return componentAccess.has(this, ctor);
    }

    /**
     * Get component data or throw if not found.
     */
    public getOrThrow<T extends BaseComponent>(
        ctor: new (...args: any[]) => T,
        context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }
    ): Promise<ComponentDataType<T>> {
        return componentAccess.getOrThrow(this, ctor, context);
    }

    /**
     * Get component data synchronously if already loaded in memory.
     * Does NOT trigger a database fetch - returns undefined if not cached.
     */
    public getCached<T extends BaseComponent>(ctor: new (...args: any[]) => T): ComponentDataType<T> | undefined {
        return componentAccess.getCached(this, ctor);
    }

    /**
     * Get component instance from entity. Loads from DB if not cached.
     */
    public getInstanceOf<T extends BaseComponent>(ctor: new (...args: any[]) => T, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<T | null> {
        return componentAccess.getInstanceOf(this, ctor, context);
    }

    /**
     * Discard in-memory component state and re-hydrate from the database.
     * Preserves entity identity — callers holding a reference see fresh data
     * on the same instance.
     */
    public async reload(opts?: { trx?: SQL; signal?: AbortSignal }): Promise<this> {
        await componentAccess.reload(this, opts);
        return this;
    }

    /**
     * Ensure the given components are hydrated on this entity's in-memory
     * componentList. No-op for components already loaded.
     */
    public requireComponents(ctors: Array<new (...args: any[]) => BaseComponent>): Promise<void> {
        return componentAccess.requireComponents(this, ctors);
    }

    // --- Persistence (core/entity/saveEntity.ts) ---

    @timed("Entity.save")
    public save(trx?: SQL, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<boolean> {
        return saveEntity.saveEntity(this, trx, context);
    }

    public doSave(trx: SQL, signal?: AbortSignal): Promise<boolean> {
        return saveEntity.doSave(this, trx, signal);
    }

    public delete(force: boolean = false) {
        return EntityManager.deleteEntity(this, force);
    }

    public doDelete(force: boolean = false): Promise<boolean> {
        return saveEntity.doDelete(this, force);
    }

    public setPersisted(persisted: boolean) {
        this._persisted = persisted;
    }

    public setDirty(dirty: boolean) {
        this._dirty = dirty;
    }

    // --- Loaders / factories / (de)serialization (core/entity/finders.ts) ---

    @timed("Entity.LoadMultiple")
    public static LoadMultiple(ids: string[]): Promise<Entity[]> {
        return finders.loadMultiple(ids);
    }

    public static LoadComponents(entities: Entity[], componentIds: string[], skipCache: boolean = false): Promise<void> {
        return finders.loadComponents(entities, componentIds, skipCache);
    }

    /**
     * Find an entity by its ID. Returning populated with all components. Or null if not found.
     */
    public static FindById(id: string, trx?: SQL): Promise<Entity | null> {
        return finders.findById(id, trx);
    }

    public static Clone(entity: Entity): Entity {
        return finders.clone(entity);
    }

    public static MakeRef(entity: Entity): Entity {
        return finders.makeRef(entity);
    }

    /**
     * Serialize the entity with only the currently loaded components
     */
    public serialize(): { id: string; components: Record<string, any> } {
        return finders.serialize(this);
    }

    /**
     * Deserialize/reconstitute an Entity from cached/serialized data.
     */
    public static deserialize(data: any): Entity {
        return finders.deserialize(data);
    }
}

export default Entity;
