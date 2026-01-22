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
 * Entity with typed component access based on components included in query.
 * Provides both async getTyped() and synchronous componentData access.
 */
export type TypedEntity<TComponents extends readonly ComponentConstructor[]> = Entity & {
    /**
     * Type-safe async component getter - only available for components in the query.
     * Unlike regular get(), this returns non-null since query guarantees component exists.
     */
    getTyped<T extends ComponentUnion<TComponents>>(
        ctor: T
    ): Promise<T extends ComponentConstructor<infer C>
        ? C extends BaseComponent ? ComponentDataType<C> : never
        : never>;

    /**
     * Synchronous access to already-loaded component data.
     * Available immediately after query execution without additional DB calls.
     */
    componentData: ComponentRecord<TComponents>;

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
export type TypedFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'like';

/**
 * A typed filter for archetype queries
 */
export interface TypedFilter<T, K extends keyof T = keyof T> {
    field: K;
    operator: TypedFilterOperator;
    value: T[K] extends object ? Partial<T[K]> : T[K];
}
