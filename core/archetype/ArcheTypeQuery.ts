import type { BaseComponent, ComponentDataType } from "../components";
import { Entity } from "../Entity";
import { Query } from "../../query";
import type { BaseArcheType } from "../ArcheType";

export type ArcheTypeOwnProperties<T extends BaseArcheType> = Omit<T, keyof BaseArcheType>;

export type ArcheTypeResult<T extends BaseArcheType> = {
    entity: Entity;
    id: string;
    save(): Promise<void>;
} & {
    [K in keyof T as T[K] extends BaseComponent ? K : never]:
        T[K] extends BaseComponent ? ComponentDataType<T[K]> : never;
};

/**
 * Query builder for ArcheTypes that returns fully-typed results.
 * Auto-includes all archetype components and provides typed filter methods.
 */
interface RuntimeQuery {
    with(ctor: new () => BaseComponent, options?: { filters: Array<{ field: string; operator: string; value: unknown }> }): RuntimeQuery;
    take(limit: number): RuntimeQuery;
    offset(offset: number): RuntimeQuery;
    sortBy(ctor: new () => BaseComponent, property: string, direction: "ASC" | "DESC"): RuntimeQuery;
    eagerLoadComponents(ctors: Array<new () => BaseComponent>): RuntimeQuery;
    populate(): RuntimeQuery;
    noCache(): RuntimeQuery;
    exec(): Promise<Entity[]>;
    count(): Promise<number>;
}

export class ArcheTypeQuery<T extends BaseArcheType> {
    private innerQuery: RuntimeQuery;
    private archetypeInstance: T;
    private selectedFields: string[] | null = null;

    constructor(archetypeCtor: new () => T) {
        this.archetypeInstance = new archetypeCtor();
        // Query's component tuple is compile-time only; archetype maps are runtime.
        this.innerQuery = new Query() as unknown as RuntimeQuery;

        for (const componentCtor of Object.values(this.archetypeInstance.componentMap)) {
            this.innerQuery = this.innerQuery.with(componentCtor);
        }
    }

    public filter<K extends keyof ArcheTypeOwnProperties<T>>(
        field: K,
        operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "like",
        value: Partial<T[K] extends BaseComponent ? ComponentDataType<T[K]> : never>
    ): this {
        const componentCtor = this.archetypeInstance.componentMap[field as string];
        if (!componentCtor) {
            throw new Error(`Field '${String(field)}' is not a component field on this archetype`);
        }

        const opMap: Record<string, string> = {
            eq: "=", neq: "!=", gt: ">", gte: ">=",
            lt: "<", lte: "<=", in: "IN", notIn: "NOT IN", like: "LIKE", ilike: "ILIKE",
        };
        const filterOp = opMap[operator] || "=";
        const filters = Object.entries(value as object).map(([propKey, propValue]) => ({
            field: propKey,
            operator: filterOp,
            value: propValue,
        }));

        this.innerQuery = this.innerQuery.with(componentCtor, { filters });
        return this;
    }

    public take(limit: number): this {
        this.innerQuery = this.innerQuery.take(limit);
        return this;
    }

    public offset(offset: number): this {
        this.innerQuery = this.innerQuery.offset(offset);
        return this;
    }

    public sortBy<K extends keyof ArcheTypeOwnProperties<T>>(
        field: K,
        property: T[K] extends BaseComponent ? keyof ComponentDataType<T[K]> : never,
        direction: "ASC" | "DESC" = "ASC"
    ): this {
        const componentCtor = this.archetypeInstance.componentMap[field as string];
        if (!componentCtor) {
            throw new Error(`Field '${String(field)}' is not a component field on this archetype`);
        }
        this.innerQuery.sortBy(componentCtor, String(property), direction);
        return this;
    }

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

    private withLoadStrategy(): RuntimeQuery {
        return this.selectedFields
            ? this.innerQuery.eagerLoadComponents(this.selectedComponentCtors())
            : this.innerQuery.populate();
    }

    public populate(): this {
        this.innerQuery = this.innerQuery.populate();
        return this;
    }

    public noCache(): this {
        this.innerQuery = this.innerQuery.noCache();
        return this;
    }

    public async exec(): Promise<ArcheTypeResult<T>[]> {
        const entities = await this.withLoadStrategy().exec();
        return entities.map((entity) => this.wrapAsArchetype(entity));
    }

    public async first(): Promise<ArcheTypeResult<T> | null> {
        const results = await this.withLoadStrategy().take(1).exec();
        const entity = results[0];
        return entity ? this.wrapAsArchetype(entity) : null;
    }

    public count(): Promise<number> {
        return this.innerQuery.count();
    }

    private wrapAsArchetype(entity: Entity): ArcheTypeResult<T> {
        const result: Record<string, unknown> = {
            entity,
            id: entity.id,
            save: async () => {
                await entity.save();
            },
        };

        for (const [fieldName, componentCtor] of Object.entries(this.archetypeInstance.componentMap)) {
            const comp = entity.getInMemory(componentCtor);
            if (comp) {
                result[fieldName] = comp.data();
            }
        }

        return result as ArcheTypeResult<T>;
    }
}
