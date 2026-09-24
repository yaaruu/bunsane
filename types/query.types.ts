import type { BaseComponent, ComponentDataType } from "../core/components";
import type { Entity } from "../core/Entity";

/**
 * Type constructor for a component class
 */
export type ComponentConstructor<T extends BaseComponent = BaseComponent> = new (...args: any[]) => T;

/**
 * Extracts the component class name from a constructor
 */
export type ComponentName<T extends ComponentConstructor> = T extends (new (...args: any[]) => infer C) & { name: infer N }
    ? N
    : string;

/**
 * Extracts component data types from a tuple of component classes.
 * Maps [PositionCtor, VelocityCtor] -> [PositionData, VelocityData]
 */
export type ExtractComponentData<T extends readonly ComponentConstructor[]> = {
    [K in keyof T]: T[K] extends ComponentConstructor<infer C>
        ? C extends BaseComponent ? ComponentDataType<C> : never
        : never;
};

/**
 * Maps component constructors to a record of { ComponentName: ComponentData }.
 * Enables access like: entity.componentData.Position.x
 */
export type ComponentRecord<T extends readonly ComponentConstructor[]> = {
    [K in T[number] as K extends (new (...args: any[]) => any) & { name: infer N extends string }
        ? N
        : never]: K extends ComponentConstructor<infer C>
            ? C extends BaseComponent ? ComponentDataType<C> : never
            : never;
};

/**
 * Union of all component constructor types in a tuple.
 * Useful for constraining getTyped() to only accept components from the query.
 */
export type ComponentUnion<T extends readonly ComponentConstructor[]> = T[number];

/**
 * Component rows are loaded only when the query called `.populate()`.
 * Without it, each `.with()` component is optional — `exec()` returns ids
 * and does not issue the component SELECT.
 */
export type LoadedComponentData<
    TComponents extends readonly ComponentConstructor[],
    TPopulated extends boolean,
> = TPopulated extends true
    ? ComponentRecord<TComponents>
    : Partial<ComponentRecord<TComponents>>;

/**
 * Entity with typed component access based on components included in query.
 *
 * `TPopulated` is true only after `Query.populate()`. `componentData` is then
 * the loaded record. Otherwise each component property is optional / possibly
 * undefined — reading it without `.populate()` is a type error under strict
 * null checks, matching the runtime (no component SELECT was issued).
 */
export type TypedEntity<
    TComponents extends readonly ComponentConstructor[] = [],
    TPopulated extends boolean = false,
> = Entity & {
    /**
     * Type-safe async component getter - only available for components in the query.
     * Unlike regular get(), this returns non-null since query guarantees component exists.
     * This still hits the component cache / DB when `.populate()` was not called.
     */
    getTyped<T extends ComponentUnion<TComponents>>(
        ctor: T
    ): Promise<T extends ComponentConstructor<infer C>
        ? C extends BaseComponent ? ComponentDataType<C> : never
        : never>;

    /**
     * Synchronous component data for the `.with()` set.
     *
     * Fully typed only after `.populate()` — that is the call that loads rows.
     * Without it, each component is optional and may be undefined. Do not treat
     * this as "available immediately after query execution".
     */
    componentData: LoadedComponentData<TComponents, TPopulated>;

    /**
     * The component constructors that were included in this query.
     * Useful for runtime reflection.
     */
    readonly _queriedComponents: TComponents;
};

/**
 * Result type for ArcheType queries that provides direct typed access to archetype fields.
 * Maps archetype field names to their component data types.
 */
export type ArcheTypeResult<T extends object> = {
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
 * Options for ArcheType queries
 */
export interface ArcheTypeQueryOptions {
    /** Skip cache for this query */
    noCache?: boolean;
    /** Include specific relations */
    populateRelations?: boolean;
}

/**
 * Filter operators for typed queries
 */
export type TypedFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'like' | 'ilike';

/**
 * A typed filter for archetype queries
 */
export interface TypedFilter<T, K extends keyof T = keyof T> {
    field: K;
    operator: TypedFilterOperator;
    value: T[K] extends object ? Partial<T[K]> : T[K];
}
