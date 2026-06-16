import type { BaseComponent, ComponentDataType } from "./components";
import type { ComponentPropertyMetadata } from "./metadata/definitions/Component";
import type { ArcheTypeFieldOptions, ArcheTypeFunctionMetadata } from "./metadata/definitions/ArcheType";
import type { GetEntityOptions } from "../types/archetype.types";
import { Entity } from "./Entity";
import { getMetadataStorage } from "./metadata";
import { z, ZodObject } from "zod";
import { weave } from "@gqloom/core";
import { ZodWeaver, asEnumType, asUnionType, asObjectType } from "@gqloom/zod";
import { printSchema } from "graphql";
import "reflect-metadata";
import { Query, type FilterSchema } from "../query";
import { compNameToFieldName, shouldUnwrapComponent, primitiveTypes } from "./archetype/helpers";
import {
    customTypeRegistry,
    customTypeNameRegistry,
    registeredCustomTypes,
    customTypeSilks,
    customTypeResolvers,
    inputTypeRegistry,
    structuralSignatureRegistry,
    registerCustomZodType,
    findMatchingInputType,
    getRegisteredCustomTypes,
    getStructuralSignatureRegistry,
} from "./archetype/customTypes";
import {
    componentSchemaCache,
    enumSchemaCache,
    getOrCreateComponentSchema,
} from "./archetype/schemaBuilder";
import {
    archetypeSchemaCache,
    allArchetypeZodObjects,
    getArchetypeSchema,
    getAllArchetypeSchemas,
    weaveAllArchetypes,
} from "./archetype/weaver";
import {
    archetypeFunctionsSymbol,
    archetypeFieldsSymbol,
    archetypeUnionFieldsSymbol,
    archetypeRelationsSymbol,
    ArcheTypeFunction,
    ArcheType,
    ArcheTypeField,
    ArcheTypeUnionField,
    HasMany,
    BelongsTo,
    HasOne,
    BelongsToMany,
    ArcheTypeRelation,
} from "./archetype/decorators";

export type ArcheTypeOptions = {
    name?: string;
};

export interface RelationOptions {
    nullable?: boolean;
    foreignKey?: string;
    through?: string;
    cascade?: boolean;
}

const InputFilterSchema = z.object({
    field: z.string(),
    op: z.string().default("eq"),
    value: z.string(),
}).register(asObjectType, { name: "InputFilter" });

export {asEnumType, asUnionType, asObjectType};
export {
    ArcheTypeFunction,
    ArcheType,
    ArcheTypeField,
    ArcheTypeUnionField,
    HasMany,
    BelongsTo,
    HasOne,
    BelongsToMany,
    ArcheTypeRelation,
} from "./archetype/decorators";
export { compNameToFieldName, shouldUnwrapComponent } from "./archetype/helpers";
export {
    registerCustomZodType,
    findMatchingInputType,
    getRegisteredCustomTypes,
    getStructuralSignatureRegistry,
} from "./archetype/customTypes";
export {
    getArchetypeSchema,
    getAllArchetypeSchemas,
    weaveAllArchetypes,
} from "./archetype/weaver";

export interface HasManyOptions extends RelationOptions {
    // Additional HasMany specific options
}

export interface BelongsToOptions extends RelationOptions {
    // Additional BelongsTo specific options
}

export interface HasOneOptions extends RelationOptions {
    // Additional HasOne specific options
}

export interface BelongsToManyOptions extends RelationOptions {
    through: string; // Required for many-to-many
}


export type ArcheTypeResolver = {
    resolver?: string;
    component?: new (...args: any[]) => BaseComponent;
    field?: string;
    filter?: { [key: string]: any };
};

export type ArcheTypeCreateInfo = {
    name: string;
    components: Array<new (...args: any[]) => BaseComponent>;
};

export type ArcheTypeOwnProperties<T extends BaseArcheType> = Omit<T, keyof BaseArcheType>;

/**
 * Result type that provides direct typed access to archetype fields.
 * Wraps an entity with its archetype's component data exposed as properties.
 */
export type ArcheTypeResult<T extends BaseArcheType> = {
    /** The underlying entity */
    entity: Entity;
    /** Entity ID shorthand */
    id: string;
    /** Save changes to the entity */
    save(): Promise<void>;
} & {
    [K in keyof T as T[K] extends BaseComponent ? K : never]:
        T[K] extends BaseComponent ? ComponentDataType<T[K]> : never;
};

/**
 * Query builder for ArcheTypes that returns fully-typed results.
 * Auto-includes all archetype components and provides typed filter methods.
 *
 * @example
 * ```typescript
 * const players = await Player.query()
 *   .filter('health', 'gt', { current: 50 })
 *   .exec();
 *
 * for (const player of players) {
 *   console.log(player.position.x, player.health.current);
 * }
 * ```
 */
export class ArcheTypeQuery<T extends BaseArcheType> {
    private innerQuery: Query<any>;
    private archetypeInstance: T;
    private archetypeCtor: new () => T;
    private selectedFields: string[] | null = null;

    constructor(archetypeCtor: new () => T) {
        this.archetypeCtor = archetypeCtor;
        this.archetypeInstance = new archetypeCtor();
        this.innerQuery = new Query();

        // Auto-add all archetype components to the query
        for (const [_, componentCtor] of Object.entries(this.archetypeInstance.componentMap)) {
            this.innerQuery = this.innerQuery.with(componentCtor as any);
        }
    }

    /**
     * Add a filter on an archetype field.
     * @param field The archetype field name (maps to a component)
     * @param operator Filter operator: eq, neq, gt, gte, lt, lte, in, like
     * @param value The value to filter by (partial component data)
     */
    public filter<K extends keyof ArcheTypeOwnProperties<T>>(
        field: K,
        operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'like',
        value: Partial<T[K] extends BaseComponent ? ComponentDataType<T[K]> : never>
    ): this {
        const componentCtor = this.archetypeInstance.componentMap[field as string];
        if (!componentCtor) {
            throw new Error(`Field '${String(field)}' is not a component field on this archetype`);
        }

        // Map operator to FilterOp
        const opMap: Record<string, string> = {
            'eq': '=', 'neq': '!=', 'gt': '>', 'gte': '>=',
            'lt': '<', 'lte': '<=', 'in': 'IN', 'notIn': 'NOT IN', 'like': 'LIKE', 'ilike': 'ILIKE'
        };
        const filterOp = opMap[operator] || '=';

        // Build filters from the partial value
        const filters = Object.entries(value as object).map(([propKey, propValue]) => ({
            field: propKey,
            operator: filterOp,
            value: propValue
        }));

        // Re-add the component with filters
        this.innerQuery = this.innerQuery.with(componentCtor as any, { filters });

        return this;
    }

    /**
     * Limit the number of results
     */
    public take(limit: number): this {
        this.innerQuery = this.innerQuery.take(limit);
        return this;
    }

    /**
     * Skip a number of results (for pagination)
     */
    public offset(offset: number): this {
        this.innerQuery = this.innerQuery.offset(offset);
        return this;
    }

    /**
     * Sort results by a component field
     */
    public sortBy<K extends keyof ArcheTypeOwnProperties<T>>(
        field: K,
        property: T[K] extends BaseComponent ? keyof ComponentDataType<T[K]> : never,
        direction: 'ASC' | 'DESC' = 'ASC'
    ): this {
        const componentCtor = this.archetypeInstance.componentMap[field as string];
        if (!componentCtor) {
            throw new Error(`Field '${String(field)}' is not a component field on this archetype`);
        }
        // Cast needed because innerQuery has dynamic component types
        (this.innerQuery as any).sortBy(componentCtor, property, direction);
        return this;
    }

    /**
     * Project: load data only for the given archetype fields (components).
     *
     * Membership filtering is unaffected — matching the archetype still requires
     * all its components. This only limits which component DATA is fetched, so a
     * wide archetype read with a narrow selection skips the JSONB wire+parse cost
     * of unselected components. Unselected fields are absent from results; they
     * remain lazy-loadable later via entity.get() under a request scope.
     *
     * Backward-compatible: without select(), exec()/first() load all components.
     *
     * @example
     * ```typescript
     * const players = await Player.query().select('position', 'health').exec();
     * // only position + health component data loaded; velocity etc. skipped
     * ```
     */
    public select<K extends keyof ArcheTypeOwnProperties<T>>(...fields: K[]): this {
        this.selectedFields = fields.map((f) => {
            const name = String(f);
            if (!this.archetypeInstance.componentMap[name]) {
                throw new Error(`Field '${name}' is not a component field on this archetype`);
            }
            return name;
        });
        return this;
    }

    private selectedComponentCtors(): Array<new () => BaseComponent> {
        return (this.selectedFields ?? []).map(
            (f) => this.archetypeInstance.componentMap[f] as unknown as new () => BaseComponent
        );
    }

    /**
     * Apply the load strategy: projected (eager-load selected components) when
     * select() was used, otherwise populate() all archetype components.
     */
    private withLoadStrategy(): Query<any> {
        return this.selectedFields
            ? this.innerQuery.eagerLoadComponents(this.selectedComponentCtors())
            : this.innerQuery.populate();
    }

    /**
     * Enable populate mode to load all component data
     */
    public populate(): this {
        this.innerQuery = this.innerQuery.populate();
        return this;
    }

    /**
     * Bypass cache for this query
     */
    public noCache(): this {
        this.innerQuery = this.innerQuery.noCache();
        return this;
    }

    /**
     * Execute the query and return typed archetype results
     */
    public async exec(): Promise<ArcheTypeResult<T>[]> {
        const entities = await this.withLoadStrategy().exec();
        return entities.map(entity => this.wrapAsArchetype(entity as Entity));
    }

    /**
     * Execute the query and return the first result (or null)
     */
    public async first(): Promise<ArcheTypeResult<T> | null> {
        const results = await this.withLoadStrategy().take(1).exec();
        return results[0] ? this.wrapAsArchetype(results[0] as Entity) : null;
    }

    /**
     * Get the count of matching entities
     */
    public count(): Promise<number> {
        return this.innerQuery.count();
    }

    /**
     * Wrap an entity as an ArcheTypeResult with direct property access
     */
    private wrapAsArchetype(entity: Entity): ArcheTypeResult<T> {
        const result: any = {
            entity,
            id: entity.id,
            save: async () => {
                await entity.save();
            }
        };

        // Add component data as direct properties
        for (const [fieldName, componentCtor] of Object.entries(this.archetypeInstance.componentMap)) {
            const comp = entity.getInMemory(componentCtor as any);
            if (comp) {
                result[fieldName] = (comp as any).data();
            }
        }

        return result as ArcheTypeResult<T>;
    }
}

export class BaseArcheType {
    protected components: Set<{
        ctor: new (...args: any[]) => BaseComponent;
        data: any;
    }> = new Set();
    public componentMap: Record<string, typeof BaseComponent> = {};
    protected fieldOptions: Record<string, ArcheTypeFieldOptions> = {};
    protected fieldTypes: Record<string, any> = {};
    public relationMap: Record<string, typeof BaseArcheType | string> = {};
    protected relationOptions: Record<string, RelationOptions> = {};
    protected relationTypes: Record<
        string,
        "hasMany" | "belongsTo" | "hasOne" | "belongsToMany"
    > = {};
    public unionMap: Record<string, (new (...args: any[]) => BaseComponent)[]> =
        {};
    protected unionOptions: Record<string, ArcheTypeFieldOptions> = {};
    public functions: Array<{ propertyKey: string; options?: { returnType?: string, args?: [{name: string, type: any, nullable: boolean}] } }> = [];

    public resolver?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor() {
        const storage = getMetadataStorage();
        const archetypeId = storage.getComponentId(this.constructor.name);

        // Look up the custom name from metadata (e.g., from @ArcheType("CustomName"))
        const archetypeMetadata = storage.archetypes.find(
            (a) => a.typeId === archetypeId
        );
        const archetypeName =
            archetypeMetadata?.name ||
            this.constructor.name.replace(/ArcheType$/, "");

        const fields = storage.archetypes_field_map.get(archetypeName);
        if (fields) {
            for (const { fieldName, component, options, type } of fields) {
                this.componentMap[fieldName] = component;
                if (options) this.fieldOptions[fieldName] = options;
                if (type) this.fieldTypes[fieldName] = type;
            }
        }

        const unions = storage.archetypes_union_map.get(archetypeName);
        if (unions) {
            for (const { fieldName, components, options, type } of unions) {
                this.unionMap[fieldName] = components;
                if (options) this.unionOptions[fieldName] = options;
            }
        }

        // Process relations
        const relations = storage.archetypes_relations_map.get(archetypeName);
        if (relations) {
            for (const {
                fieldName,
                relatedArcheType,
                relationType,
                options,
                type,
            } of relations) {
                this.relationMap[fieldName] = relatedArcheType as any;
                this.relationTypes[fieldName] = relationType;
                if (options) this.relationOptions[fieldName] = options;
            }
        }

        // Collect archetype functions
        this.functions = this.constructor.prototype[archetypeFunctionsSymbol] || [];
    }

    // constructor(components: Array<new (...args: any[]) => BaseComponent>) {
    //     for (const ctor of components) {
    //         this.componentMap[compNameToFieldName(ctor.name)] = ctor;
    //     }
    // }

    static ResolveField<T extends BaseComponent>(
        component: new (...args: any[]) => T,
        field: keyof T
    ): ArcheTypeResolver {
        return { component, field: field as string };
    }

    static Create(info: ArcheTypeCreateInfo): BaseArcheType {
        const archetype = new BaseArcheType();
        archetype.components = new Set();
        for (const ctor of info.components) {
            archetype.componentMap[compNameToFieldName(ctor.name)] = ctor;
        }
        return archetype;
    }

    private addComponent<T extends BaseComponent>(
        ctor: new (...args: any[]) => T,
        data: ComponentDataType<T>
    ) {
        this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        this.components.add({ ctor, data });
    }

    // TODO: Can we make this type-safe?
    public fill(input: object, strict: boolean = false): this {
        const storage = getMetadataStorage();

        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    const fieldType = this.fieldTypes[key];
                    const typeId = storage.getComponentId(compCtor.name);
                    const componentProps =
                        storage.getComponentProperties(typeId);

                    // Check if this is a primitive field that should be unwrapped
                    if (shouldUnwrapComponent(componentProps, fieldType)) {
                        // For primitive types, wrap in { value }
                        this.addComponent(compCtor, { value } as any);
                    } else {
                        // For complex types, pass data directly
                        this.addComponent(compCtor, value as any);
                    }
                } else if (this.unionMap[key]) {
                    // Handle union fields
                    const unionComponents = this.unionMap[key];
                    const selectedComponent = this.determineUnionComponent(
                        value,
                        unionComponents,
                        storage
                    );

                    if (selectedComponent) {
                        this.addComponent(selectedComponent, value as any);
                    } else if (strict) {
                        throw new Error(
                            `Could not determine component type for union field '${key}'`
                        );
                    }
                } else {
                    // direct property
                    (this as any)[key] = value;
                }
            }
        }
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const alreadyAdded = Array.from(this.components).some(
                (c) => c.ctor === ctor
            );
            if (!alreadyAdded) {
                this.addComponent(ctor, {} as any);
            }
        }

        return this;
    }

    /**
     * Determines which component in a union should be used based on the input data.
     * @param value The input data for the union field
     * @param unionComponents Array of possible component constructors
     * @param storage Metadata storage
     * @returns The selected component constructor, or null if none match
     */
    private determineUnionComponent(
        value: any,
        unionComponents: (new (...args: any[]) => BaseComponent)[],
        storage: any
    ): (new (...args: any[]) => BaseComponent) | null {
        // If value has __typename, use it to determine the component
        if (value && typeof value === "object" && value.__typename) {
            const expectedTypeName = value.__typename;
            for (const component of unionComponents) {
                const componentTypeName = compNameToFieldName(component.name);
                if (componentTypeName === expectedTypeName) {
                    return component;
                }
            }
        }

        // Fallback: Try to infer based on property presence
        if (value && typeof value === "object") {
            for (const component of unionComponents) {
                const typeId = storage.getComponentId(component.name);
                const componentProps = storage.getComponentProperties(typeId);

                // Check if any properties of this component are present in the value
                const hasMatchingProps = componentProps.some(
                    (prop: ComponentPropertyMetadata) =>
                        value.hasOwnProperty(prop.propertyKey)
                );

                if (hasMatchingProps) {
                    return component;
                }
            }
        }

        // If no component matches, return the first one as default
        return unionComponents[0] || null;
    }
    async updateEntity<T>(entity: Entity, updates: Partial<T>) {
        const storage = getMetadataStorage();

        for (const key of Object.keys(updates)) {
            if (key === "id" || key === "_id") continue;
            const value = updates[key as keyof T];
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    const fieldType = this.fieldTypes[key];
                    const typeId = storage.getComponentId(compCtor.name);
                    const componentProps =
                        storage.getComponentProperties(typeId);

                    // Check if this is a primitive field that should be unwrapped
                    if (shouldUnwrapComponent(componentProps, fieldType)) {
                        // For primitive types, wrap in { value }
                        await entity.set(compCtor, { value });
                    } else {
                        // For complex types, pass data directly
                        await entity.set(compCtor, value as any);
                    }
                } else if (this.unionMap[key]) {
                    // Handle union fields
                    const unionComponents = this.unionMap[key];
                    const selectedComponent = this.determineUnionComponent(
                        value,
                        unionComponents,
                        storage
                    );

                    if (selectedComponent) {
                        await entity.set(selectedComponent, value as any);
                    }
                } else {
                    // direct, set on archetype
                    (this as any)[key] = value;
                }
            }
        }
        return entity;
    }

    /**
     * Creates a new entity with all the predefined components from this archetype.
     * @returns A new Entity instance with all archetype components added
     */
    public createEntity(): Entity {
        const entity = Entity.Create();
        for (const { ctor, data } of this.components) {
            entity.add(ctor, data);
        }
        return entity;
    }

    /**
     * Creates a new entity and immediately saves it to the database.
     * @returns A promise that resolves to the saved Entity
     */
    public async createAndSaveEntity(): Promise<Entity> {
        const entity = this.createEntity();
        await entity.save();
        return entity;
    }

    /**
     * Retrieves an entity by ID and populates it with all components defined in this archetype.
     * 
     * @param id The entity ID to retrieve
     * @param options Optional configuration for component loading and behavior
     * @returns A promise that resolves to the populated Entity or null if not found
     * 
     * @example
     * // Basic usage
     * const serviceArea = await serviceAreaArcheType.getEntityWithID('uuid-123');
     * 
     * @example
     * // With options
     * const serviceArea = await serviceAreaArcheType.getEntityWithID('uuid-123', {
     *   includeComponents: ['info', 'label'],
     *   populateRelations: true,
     *   throwOnNotFound: true
     * });
     */
    public async getEntityWithID(id: string, options?: GetEntityOptions): Promise<Entity | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            if (options?.throwOnNotFound) {
                throw new Error(`Invalid entity ID provided: "${id}"`);
            }
            return null;
        }
        
        const { Query } = await import("../query");

        // Build query with selected components for batch loading
        // Use `any` since components are dynamically added in loop
        let query: any = new Query().findById(id);

        // Determine which components to load
        const componentsToLoad = this.getComponentsToLoad(options);

        for (const componentCtor of componentsToLoad) {
            query = query.with(componentCtor as any);
        }
        
        const entities = await query.exec();
        if (entities.length === 0) {
            if (options?.throwOnNotFound) {
                throw new Error(`Entity with ID ${id} not found`);
            }
            return null;
        }
        
        const entity = entities[0]!;
        
        // Populate relations if requested
        if (options?.populateRelations) {
            await this.populateRelations(entity);
        }
        
        return entity;
    }

    /**
     * Determines which components should be loaded based on the options.
     * @param options The options specifying component inclusion/exclusion
     * @returns Array of component constructors to load
     */
    private getComponentsToLoad(options?: GetEntityOptions): (new (...args: any[]) => BaseComponent)[] {
        let componentsToLoad: (new (...args: any[]) => BaseComponent)[] = [];

        // Start with all regular components
        componentsToLoad.push(...Object.values(this.componentMap));

        // Add union components
        for (const componentCtors of Object.values(this.unionMap)) {
            componentsToLoad.push(...componentCtors);
        }

        // Apply include filter
        if (options?.includeComponents) {
            const includeSet = new Set(options.includeComponents);
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                return includeSet.has(fieldName);
            });
        }

        // Apply exclude filter
        if (options?.excludeComponents) {
            const excludeSet = new Set(options.excludeComponents);
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                return !excludeSet.has(fieldName);
            });
        }

        // Respect nullable options (skip nullable components by default unless explicitly included)
        if (!options?.includeComponents) {
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                const isNullable = this.fieldOptions[fieldName]?.nullable === true;
                return !isNullable;
            });
        }

        return componentsToLoad;
    }

    /**
     * Populates relations for the given entity.
     * @param entity The entity to populate relations for
     */
    private async populateRelations(entity: Entity): Promise<void> {
        const { populateRelations: doPopulateRelations } = require("./archetype/relationLoader");
        return doPopulateRelations(this, entity);
    }

    /**
     * Static convenience method to get an entity with ID using an archetype class.
     * 
     * @param archetypeClass The archetype class to use for loading
     * @param id The entity ID to retrieve
     * @param options Optional configuration for component loading and behavior
     * @returns A promise that resolves to the populated Entity or null if not found
     * 
     * @example
     * // Using static method
     * const serviceArea = await BaseArcheType.getEntityWithID(ServiceAreaArcheTypeClass, 'uuid-123');
     */
    static async getEntityWithID<T extends BaseArcheType>(
        archetypeClass: new () => T,
        id: string,
        options?: GetEntityOptions
    ): Promise<Entity | null> {
        const instance = new archetypeClass();
        return instance.getEntityWithID(id, options);
    }

    /**
     * Create a typed query builder for this archetype.
     * Auto-includes all archetype components and returns typed results.
     *
     * @example
     * ```typescript
     * // Subclass usage (most common)
     * class Player extends BaseArcheType {
     *   @ArcheTypeField(Position) position!: Position;
     *   @ArcheTypeField(Health) health!: Health;
     * }
     *
     * const players = await Player.query()
     *   .filter('health', 'gt', { current: 50 })
     *   .sortBy('position', 'x', 'ASC')
     *   .take(10)
     *   .exec();
     *
     * for (const player of players) {
     *   // Direct typed access - no async, no null checks
     *   console.log(player.position.x, player.health.current);
     *   // Access underlying entity when needed
     *   await player.save();
     * }
     * ```
     */
    static query<T extends BaseArcheType>(
        this: new () => T
    ): ArcheTypeQuery<T> {
        return new ArcheTypeQuery<T>(this);
    }

    /**
     * Unwraps an entity into a plain object containing the component data.
     * @param entity The entity to unwrap
     * @param exclude An optional array of field names to exclude from the result (e.g., sensitive data like passwords)
     * @returns A promise that resolves to an object with component data
     */
    public async Unwrap(
        entity: Entity,
        exclude: string[] = []
    ): Promise<Record<string, any>> {
        const result: any = { id: entity.id };

        // Handle regular components
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            if (exclude.includes(field)) continue;
            const comp = await entity.get(ctor as any);
            if (comp) {
                result[field] = (comp as any).value;
            }
        }

        // Handle union fields
        for (const [field, components] of Object.entries(this.unionMap)) {
            if (exclude.includes(field)) continue;
            for (const component of components) {
                const comp = await entity.get(component);
                if (comp) {
                    result[field] = {
                        __typename: compNameToFieldName(component.name),
                        ...(comp as any),
                    };
                    break; // Only take the first matching component
                }
            }
        }

        // for direct fields
        for (const field of Object.keys(this.fieldTypes)) {
            if (exclude.includes(field)) continue;
            if (!this.componentMap[field] && !this.unionMap[field]) {
                result[field] = (this as any)[field];
            }
        }
        return result;
    }

    /**
     * Gets the property metadata for all components in this archetype.
     * @returns A record mapping field names to their component property metadata arrays
     */
    public getComponentProperties(): Record<
        string,
        ComponentPropertyMetadata[]
    > {
        const storage = getMetadataStorage();
        const result: Record<string, ComponentPropertyMetadata[]> = {};

        // Regular components
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const typeId = storage.getComponentId(ctor.name);
            result[field] = storage.getComponentProperties(typeId);
        }

        // Union components (for each union field, include properties of all components)
        for (const [field, components] of Object.entries(this.unionMap)) {
            const allProps: ComponentPropertyMetadata[] = [];
            for (const component of components) {
                const typeId = storage.getComponentId(component.name);
                allProps.push(...storage.getComponentProperties(typeId));
            }
            result[field] = allProps;
        }

        return result;
    }

    /**
     * Helper to ensure we have a proper Entity instance for resolvers.
     * Handles cases where parent comes from GraphQL chain as a plain object.
     */
    private static async ensureEntity(parent: any, context: any): Promise<Entity> {
        if (parent instanceof Entity) {
            return parent;
        }
        if (parent && parent.id) {
            // Try to load via DataLoader first
            if (context?.loaders?.entityById) {
                const loaded = await context.loaders.entityById.load(parent.id);
                if (loaded) return loaded;
            }
            // Fallback: create Entity instance
            const entity = new Entity(parent.id);
            entity.setPersisted(true);
            return entity;
        }
        throw new Error('Invalid parent object: missing id property');
    }

    /**
     * Generates GraphQL field resolver functions for this archetype.
     * These resolvers handle both simple fields and component-based fields with DataLoader support.
     *
     * @returns An array of resolver metadata that can be registered with GraphQL
     *
     * @example
     * const resolvers = serviceAreaArcheType.generateFieldResolvers();
     * // Returns array of: { typeName, fieldName, resolver }
     */
    public generateFieldResolvers(): Array<{
        typeName: string;
        fieldName: string;
        resolver: (parent: any, args: any, context: any) => any;
    }> {
        const { buildFieldResolvers } = require("./archetype/fieldResolvers");
        return buildFieldResolvers(this);
    }

    /**
     * Registers all auto-generated field resolvers for this archetype with a service.
     * This eliminates the need to manually write @GraphQLField decorators.
     *
     * @param service The service instance to attach resolvers to
     *
     * @example
     * class AreaService extends BaseService {
     *     constructor(app: App) {
     *         super();
     *         // Auto-register all field resolvers!
     *         serviceAreaArcheType.registerFieldResolvers(this);
     *     }
     * }
     */
    public registerFieldResolvers(service: any): void {
        this.getZodObjectSchema(); // Ensure schema is generated
        const resolvers = this.generateFieldResolvers();

        if (!service.__graphqlFields) {
            service.__graphqlFields = [];
        }

        for (const { typeName, fieldName, resolver } of resolvers) {
            // Create a unique method name
            const methodName = `_autoResolver_${typeName}_${fieldName}`;

            // Attach resolver as a method
            service[methodName] = resolver;

            // Register with GraphQL metadata
            service.__graphqlFields.push({
                type: typeName,
                field: fieldName,
                propertyKey: methodName,
            });
        }
    }

    public getZodObjectSchema(options?: { excludeRelations?: boolean; excludeFunctions?: boolean }): ZodObject<any> {
        const { buildZodObjectSchema } = require("./archetype/zodSchemaBuilder");
        return buildZodObjectSchema(this, options);
    }

    /**
     * Get a Zod schema suitable for GraphQL input types (excludes relations and functions)
     */
    public getInputSchema(): ZodObject<any> {
        return this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true });
    }

    /**
     * Apply validations to specific fields in the input schema
     * @param validations - Object mapping field paths to Zod schemas or refinement functions
     * @returns Modified Zod schema with validations applied
     * 
     * @example
     * archetype.withValidation({
     *   name: z.string().min(3),
     *   'info.label': z.string().min(3)
     * })
     */
    public withValidation(validations: Record<string, any>): ZodObject<any> {
        const baseSchema = this.getInputSchema();
        const shape = { ...baseSchema.shape };

        for (const [path, validation] of Object.entries(validations)) {
            if (path.includes('.')) {
                // Handle nested fields like 'info.label'
                const [field, ...nestedPath] = path.split('.');
                
                if (shape[field!]) {
                    const currentField = shape[field!];
                    
                    // Check if it's an optional field and unwrap it
                    const isOptional = currentField._def?.typeName === 'ZodOptional';
                    const innerSchema = isOptional ? currentField.unwrap() : currentField;
                    
                    // Check if it's a ZodObject - handle both typeName and type property
                    const isZodObject = innerSchema._def?.typeName === 'ZodObject' || 
                                       innerSchema._def?.type === 'object' || 
                                       innerSchema.type === 'object';
                    
                    if (isZodObject && innerSchema.shape) {
                        // Deep clone the nested shape to avoid mutations
                        const nestedShape = { ...innerSchema.shape };
                        
                        // Apply validation to the nested field
                        if (nestedPath.length === 1 && nestedShape[nestedPath[0]!]) {
                            nestedShape[nestedPath[0]!] = validation;
                        } else if (nestedPath.length > 1) {
                            // Handle deeper nesting (e.g., 'info.data.label')
                            let current = nestedShape;
                            for (let i = 0; i < nestedPath.length - 1; i++) {
                                const key = nestedPath[i]!;
                                if (current[key] && current[key]._def?.typeName === 'ZodObject') {
                                    current[key] = { ...current[key].shape };
                                    current = current[key];
                                }
                            }
                            const lastKey = nestedPath[nestedPath.length - 1]!;
                            if (current[lastKey]) {
                                current[lastKey] = validation;
                            }
                        }
                        
                        const newNestedSchema = z.object(nestedShape);
                        // Preserve the optionality of the parent object
                        shape[field!] = isOptional ? newNestedSchema.optional() : newNestedSchema;
                    }
                }
            } else {
                // Handle top-level fields - directly replace with the validation
                shape[path] = validation;
            }
        }

        return z.object(shape);
    }

    public getFilterSchema(): ZodObject<any> {
        const baseSchema = this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true });
        const filterShape: Record<string, any> = {};
        for (const key of Object.keys(baseSchema.shape)) {
            // Only include fields that are explicitly set to filterable: true
            const isFilterable = this.fieldOptions[key]?.filterable === true || this.unionOptions[key]?.filterable === true;
            if (isFilterable) {
                filterShape[key] = InputFilterSchema.optional();
            }
        }
        const filterSchema = z.object(filterShape);
        return filterSchema;
    }

    public buildFilterBranches(filter?: FilterSchema<any>): any[] {
        if (!filter) return [];
        const branches = [];

        for (const [fieldName, componentCtor] of Object.entries(this.componentMap)) {
            const fieldOption = this.fieldOptions[fieldName];
            if (fieldOption?.filterable && filter[fieldName]?.value) {
                const filterPart = filter[fieldName];
                const defaultField = this.getDefaultFilterField(componentCtor);
                const operator = filterPart.op ? Query.filterOp[(filterPart.op.toUpperCase() as keyof typeof Query.filterOp)] : Query.filterOp.LIKE;

                branches.push({
                    component: componentCtor,
                    filters: [
                        {
                            field: filterPart.field || defaultField,
                            operator,
                            value: operator === Query.filterOp.LIKE ? `%${filterPart.value}%` : filterPart.value,
                        },
                    ],
                });
            }
        }

        return branches;
    }

    private getDefaultFilterField(componentCtor: any): string {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(componentCtor.name);
        const props = storage.getComponentProperties(typeId);
        const hasValue = props.some(p => p.propertyKey === 'value');
        const hasLabel = props.some(p => p.propertyKey === 'label');
        return hasValue ? 'value' : hasLabel ? 'label' : props[0]?.propertyKey || 'value';
    }
}





export default BaseArcheType;
