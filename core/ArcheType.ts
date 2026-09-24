import type { BaseComponent, ComponentDataType } from "./components";
import type { ComponentPropertyMetadata } from "./metadata/definitions/Component";
import type { ArcheTypeFieldOptions } from "./metadata/definitions/ArcheType";
import type { GetEntityOptions } from "../types/archetype.types";
import { Entity } from "./Entity";
import { getMetadataStorage } from "./metadata";
import { type ZodObject, type ZodType } from "zod";
import { asEnumType, asUnionType, asObjectType } from "@gqloom/zod";
import type { FilterSchema } from "../query";
import { compNameToFieldName } from "./archetype/helpers";
import { archetypeFunctionsSymbol } from "./archetype/decorators";
import type { ArchetypeFunctionOptions } from "./archetype/functionReturn";
import { buildFieldResolvers } from "./archetype/fieldResolvers";
import { buildZodObjectSchema } from "./archetype/zodSchemaBuilder";
import { populateRelations as loadRelations } from "./archetype/relationLoader";
import type { RelationTarget } from "./archetype/relationTarget";
import {
    fillArchetype,
    updateArchetypeEntity,
    createEntityFromArchetype,
    getEntityWithID as loadEntityWithID,
    unwrapArchetype,
    withValidation as applyValidation,
    filterSchemaFor,
    buildFilterBranches as branchesFor,
    selectComponentsToLoad,
    type ArchetypeComponentHost,
} from "./archetype/entityOps";
import { ArcheTypeQuery } from "./archetype/ArcheTypeQuery";

export type { ArcheTypeOwnProperties, ArcheTypeResult } from "./archetype/ArcheTypeQuery";
export { ArcheTypeQuery } from "./archetype/ArcheTypeQuery";

export type ArcheTypeOptions = {
    name?: string;
};

export interface RelationOptions {
    nullable?: boolean;
    foreignKey?: string;
    through?: string;
    cascade?: boolean;
}

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
export type { BatchArchetypeMethod } from "./archetype/decorators";
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

export interface HasManyOptions extends RelationOptions {}
export interface BelongsToOptions extends RelationOptions {}
export interface HasOneOptions extends RelationOptions {}
export interface BelongsToManyOptions extends RelationOptions {
    through: string;
}

export type ArcheTypeResolver = {
    resolver?: string;
    component?: new (...args: never[]) => BaseComponent;
    field?: string;
    filter?: { [key: string]: unknown };
};

export type ArcheTypeCreateInfo = {
    name: string;
    components: Array<new (...args: never[]) => BaseComponent>;
};

export type ArchetypeFillInput<T> = Partial<{
    [K in keyof T]: T[K] extends BaseComponent ? Partial<ComponentDataType<T[K]>> : unknown;
}>;

export class BaseArcheType {
    protected components: Set<{
        ctor: new (...args: never[]) => BaseComponent;
        data: unknown;
    }> = new Set();
    public componentMap: Record<string, typeof BaseComponent> = {};
    protected fieldOptions: Record<string, ArcheTypeFieldOptions> = {};
    protected fieldTypes: Record<string, unknown> = {};
    public relationMap: Record<string, RelationTarget> = {};
    protected relationOptions: Record<string, RelationOptions> = {};
    protected relationTypes: Record<string, "hasMany" | "belongsTo" | "hasOne" | "belongsToMany"> = {};
    public unionMap: Record<string, (new (...args: never[]) => BaseComponent)[]> = {};
    protected unionOptions: Record<string, ArcheTypeFieldOptions> = {};
    public functions: Array<{ propertyKey: string; options?: ArchetypeFunctionOptions }> = [];

    public resolver?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor() {
        const storage = getMetadataStorage();
        const archetypeId = storage.getComponentId(this.constructor.name);
        const archetypeMetadata = storage.archetypes.find((a) => a.typeId === archetypeId);
        const archetypeName = archetypeMetadata?.name || this.constructor.name.replace(/ArcheType$/, "");

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
            for (const { fieldName, components, options } of unions) {
                this.unionMap[fieldName] = components;
                if (options) this.unionOptions[fieldName] = options;
            }
        }

        const relations = storage.archetypes_relations_map.get(archetypeName);
        if (relations) {
            for (const { fieldName, relatedArcheType, relationType, options } of relations) {
                this.relationMap[fieldName] = relatedArcheType as RelationTarget;
                this.relationTypes[fieldName] = relationType;
                if (options) this.relationOptions[fieldName] = options;
            }
        }

        this.functions = this.constructor.prototype[archetypeFunctionsSymbol] || [];
    }

    static ResolveField<T extends BaseComponent>(
        component: new (...args: never[]) => T,
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

    public fill(input: ArchetypeFillInput<this>, strict = false): this {
        const host = this.asHost();
        fillArchetype(host, input, strict);
        for (const [key, value] of Object.entries(input)) {
            if (value === undefined) continue;
            if (!this.componentMap[key] && !this.unionMap[key]) {
                Object.assign(this, { [key]: value });
            }
        }
        return this;
    }

    async updateEntity<T extends object>(entity: Entity, updates: Partial<T>): Promise<Entity> {
        await updateArchetypeEntity(this.asHost(), entity, updates);
        for (const key of Object.keys(updates)) {
            if (key === "id" || key === "_id") continue;
            if (!this.componentMap[key] && !this.unionMap[key]) {
                const value = updates[key as keyof T];
                if (value !== undefined) Object.assign(this, { [key]: value });
            }
        }
        return entity;
    }

    public createEntity(): Entity {
        return createEntityFromArchetype(this.asHost());
    }

    public async createAndSaveEntity(): Promise<Entity> {
        const entity = this.createEntity();
        await entity.save();
        return entity;
    }

    public async getEntityWithID(id: string, options?: GetEntityOptions): Promise<Entity | null> {
        return loadEntityWithID(this.asHost(), id, options);
    }

    private getComponentsToLoad(options?: GetEntityOptions) {
        return selectComponentsToLoad(this.asHost(), options);
    }

    private async populateRelations(entity: Entity): Promise<void> {
        return loadRelations(this, entity);
    }

    static async getEntityWithID<T extends BaseArcheType>(
        archetypeClass: new () => T,
        id: string,
        options?: GetEntityOptions
    ): Promise<Entity | null> {
        return new archetypeClass().getEntityWithID(id, options);
    }

    static query<T extends BaseArcheType>(this: new () => T): ArcheTypeQuery<T> {
        return new ArcheTypeQuery<T>(this);
    }

    public async Unwrap(entity: Entity, exclude: string[] = []): Promise<Record<string, unknown>> {
        const result = await unwrapArchetype(this.asHost(), entity, exclude);
        for (const field of Object.keys(this.fieldTypes)) {
            if (exclude.includes(field)) continue;
            if (!this.componentMap[field] && !this.unionMap[field]) {
                result[field] = (this as unknown as Record<string, unknown>)[field];
            }
        }
        return result;
    }

    public getComponentProperties(): Record<string, ComponentPropertyMetadata[]> {
        const storage = getMetadataStorage();
        const result: Record<string, ComponentPropertyMetadata[]> = {};
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            result[field] = storage.getComponentProperties(storage.getComponentId(ctor.name));
        }
        for (const [field, components] of Object.entries(this.unionMap)) {
            const allProps: ComponentPropertyMetadata[] = [];
            for (const component of components) {
                allProps.push(...storage.getComponentProperties(storage.getComponentId(component.name)));
            }
            result[field] = allProps;
        }
        return result;
    }
    public generateFieldResolvers() {
        return buildFieldResolvers({
            constructor: this.constructor,
            componentMap: this.componentMap,
            fieldTypes: this.fieldTypes,
            unionMap: this.unionMap,
            relationMap: this.relationMap,
            relationTypes: this.relationTypes,
            relationOptions: this.relationOptions,
            functions: this.functions,
        });
    }

    /**
     * Attach this archetype's field resolvers to a service.
     * Schema build also installs them; calling this is idempotent and does not
     * double-register a type.field pair.
     */
    public registerFieldResolvers(service: { __graphqlFields?: Array<{ type: string; field: string; propertyKey: string }> } & Record<string, unknown>): void {
        this.getZodObjectSchema();
        const resolvers = this.generateFieldResolvers();
        if (!service.__graphqlFields) service.__graphqlFields = [];
        const seen = new Set(service.__graphqlFields.map((f) => `${f.type}.${f.field}`));
        for (const { typeName, fieldName, resolver } of resolvers) {
            const key = `${typeName}.${fieldName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const methodName = `_autoResolver_${typeName}_${fieldName}`;
            service[methodName] = resolver;
            service.__graphqlFields.push({
                type: typeName,
                field: fieldName,
                propertyKey: methodName,
            });
        }
    }
    public getZodObjectSchema(options?: { excludeRelations?: boolean; excludeFunctions?: boolean }): ZodObject<Record<string, ZodType>> {
        return buildZodObjectSchema({
            constructor: this.constructor,
            componentMap: this.componentMap,
            fieldTypes: this.fieldTypes,
            fieldOptions: this.fieldOptions,
            unionMap: this.unionMap,
            unionOptions: this.unionOptions,
            relationMap: this.relationMap,
            relationTypes: this.relationTypes,
            relationOptions: this.relationOptions,
            functions: this.functions,
        }, options);
    }

    public getInputSchema(): ZodObject<Record<string, ZodType>> {
        return this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true });
    }

    public withValidation(validations: Record<string, ZodType>): ZodObject<Record<string, ZodType>> {
        return applyValidation(this.getInputSchema(), validations);
    }

    public getFilterSchema(): ZodObject<Record<string, ZodType>> {
        return filterSchemaFor(this.asHost(), this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true }));
    }

    public buildFilterBranches(filter?: FilterSchema<Record<string, unknown>>) {
        return branchesFor(this.asHost(), filter);
    }

    private asHost(): ArchetypeComponentHost {
        return this as unknown as ArchetypeComponentHost;
    }
}

export default BaseArcheType;
