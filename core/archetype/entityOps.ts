import type { ComponentConstructor } from "../components/ComponentRegistry";
import type { BaseComponent, ComponentDataType } from "../components";
import type { ComponentPropertyMetadata } from "../metadata/definitions/Component";
import type { GetEntityOptions } from "../../types/archetype.types";
import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { z, ZodObject, type ZodType } from "zod";
import { asObjectType } from "@gqloom/zod";
import { Query, type FilterSchema } from "../../query";
import { compNameToFieldName, shouldUnwrapComponent } from "./helpers";
import { populateRelations } from "./relationLoader";

const InputFilterSchema = z.object({
    field: z.string(),
    op: z.string().default("eq"),
    value: z.string(),
}).register(asObjectType, { name: "InputFilter" });

export interface ArchetypeComponentHost {
    componentMap: Record<string, ComponentConstructor>;
    unionMap: Record<string, ComponentConstructor[]>;
    fieldOptions: Record<string, { nullable?: boolean; filterable?: boolean } | undefined>;
    unionOptions: Record<string, { nullable?: boolean; filterable?: boolean } | undefined>;
    fieldTypes: Record<string, unknown>;
    components: Set<{ ctor: ComponentConstructor; data: unknown }>;
}

function propertyKeysFor(
    host: ArchetypeComponentHost,
    ctor: ComponentConstructor
): string[] {
    const keys: string[] = [];
    for (const [field, mapped] of Object.entries(host.componentMap)) {
        if (mapped === ctor) keys.push(field);
    }
    for (const [field, ctors] of Object.entries(host.unionMap)) {
        if (ctors.includes(ctor)) keys.push(field);
    }
    return keys;
}

/**
 * Components to load for getEntityWithID. include/exclude match archetype
 * property keys (componentMap / unionMap), not class-name derivatives.
 */
export function selectComponentsToLoad(
    host: ArchetypeComponentHost,
    options?: GetEntityOptions
): Array<ComponentConstructor> {
    const seen = new Set<ComponentConstructor>();
    const ctors: Array<ComponentConstructor> = [];
    const push = (ctor: ComponentConstructor) => {
        if (seen.has(ctor)) return;
        seen.add(ctor);
        ctors.push(ctor);
    };
    for (const ctor of Object.values(host.componentMap)) push(ctor);
    for (const list of Object.values(host.unionMap)) {
        for (const ctor of list) push(ctor);
    }

    let selected = ctors;
    if (options?.includeComponents) {
        const include = new Set(options.includeComponents);
        selected = selected.filter((ctor) => propertyKeysFor(host, ctor).some((key) => include.has(key)));
    }
    if (options?.excludeComponents) {
        const exclude = new Set(options.excludeComponents);
        selected = selected.filter((ctor) => !propertyKeysFor(host, ctor).some((key) => exclude.has(key)));
    }
    if (!options?.includeComponents) {
        selected = selected.filter((ctor) => {
            const keys = propertyKeysFor(host, ctor);
            const nullable = keys.some((key) => host.fieldOptions[key]?.nullable === true);
            return !nullable;
        });
    }
    return selected;
}

function determineUnionComponent(
    value: unknown,
    unionComponents: Array<ComponentConstructor>
): (ComponentConstructor) | null {
    const storage = getMetadataStorage();
    if (value && typeof value === "object" && "__typename" in value && typeof value.__typename === "string") {
        for (const component of unionComponents) {
            if (compNameToFieldName(component.name) === value.__typename) return component;
        }
    }
    if (value && typeof value === "object") {
        for (const component of unionComponents) {
            const typeId = storage.getComponentId(component.name);
            const componentProps = storage.getComponentProperties(typeId);
            const hasMatchingProps = componentProps.some((prop) =>
                Object.prototype.hasOwnProperty.call(value, prop.propertyKey)
            );
            if (hasMatchingProps) return component;
        }
    }
    return unionComponents[0] ?? null;
}

function addFilledComponent(
    host: ArchetypeComponentHost,
    ctor: ComponentConstructor,
    data: unknown
): void {
    host.componentMap[compNameToFieldName(ctor.name)] = ctor;
    host.components.add({ ctor, data });
}

export function fillArchetype(host: ArchetypeComponentHost, input: object, strict = false): void {
    const storage = getMetadataStorage();
    for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        const compCtor = host.componentMap[key];
        if (compCtor) {
            const typeId = storage.getComponentId(compCtor.name);
            const componentProps = storage.getComponentProperties(typeId);
            if (shouldUnwrapComponent(componentProps, host.fieldTypes[key])) {
                addFilledComponent(host, compCtor, { value });
            } else {
                addFilledComponent(host, compCtor, value);
            }
        } else if (host.unionMap[key]) {
            const selected = determineUnionComponent(value, host.unionMap[key]!);
            if (selected) {
                addFilledComponent(host, selected, value);
            } else if (strict) {
                throw new Error(`Could not determine component type for union field '${key}'`);
            }
        } else if (key in host) {
            // direct property assigned by the caller via the class method
        }
    }
    for (const [field, ctor] of Object.entries(host.componentMap)) {
        void field;
        const alreadyAdded = Array.from(host.components).some((c) => c.ctor === ctor);
        if (!alreadyAdded) addFilledComponent(host, ctor, {});
    }
}

export async function updateArchetypeEntity(
    host: ArchetypeComponentHost,
    entity: Entity,
    updates: object
): Promise<Entity> {
    const storage = getMetadataStorage();
    for (const key of Object.keys(updates)) {
        if (key === "id" || key === "_id") continue;
        const value = (updates as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const compCtor = host.componentMap[key];
        if (compCtor) {
            const typeId = storage.getComponentId(compCtor.name);
            const componentProps = storage.getComponentProperties(typeId);
            if (shouldUnwrapComponent(componentProps, host.fieldTypes[key])) {
                await entity.set(compCtor, { value } as ComponentDataType<BaseComponent>);
            } else {
                await entity.set(compCtor, value as ComponentDataType<BaseComponent>);
            }
        } else if (host.unionMap[key]) {
            const selected = determineUnionComponent(value, host.unionMap[key]!);
            if (selected) await entity.set(selected, value as ComponentDataType<BaseComponent>);
        }
    }
    return entity;
}

export function createEntityFromArchetype(host: ArchetypeComponentHost): Entity {
    const entity = Entity.Create();
    for (const { ctor, data } of host.components) {
        entity.add(ctor, data as ComponentDataType<BaseComponent>);
    }
    return entity;
}

export async function getEntityWithID(
    host: ArchetypeComponentHost,
    id: string,
    options?: GetEntityOptions
): Promise<Entity | null> {
    if (!id || typeof id !== "string" || id.trim() === "") {
        if (options?.throwOnNotFound) {
            throw new Error(`Invalid entity ID provided: "${id}"`);
        }
        return null;
    }

    type RunnableQuery = {
        with(ctor: ComponentConstructor): RunnableQuery;
        exec(): Promise<Entity[]>;
    };
    const query = selectComponentsToLoad(host, options).reduce<RunnableQuery>(
        (current, componentCtor) => current.with(componentCtor),
        new Query().findById(id) as unknown as RunnableQuery,
    );
    const entities = await query.exec();
    const entity = entities[0];
    if (!entity) {
        if (options?.throwOnNotFound) {
            throw new Error(`Entity with ID ${id} not found`);
        }
        return null;
    }
    if (options?.populateRelations) {
        await populateRelations(host, entity);
    }
    return entity;
}

export async function unwrapArchetype(
    host: ArchetypeComponentHost,
    entity: Entity,
    exclude: string[] = []
): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { id: entity.id };
    for (const [field, ctor] of Object.entries(host.componentMap)) {
        if (exclude.includes(field)) continue;
        const comp = await entity.get(ctor);
        if (comp && typeof comp === "object" && "value" in comp) {
            result[field] = comp.value;
        }
    }
    for (const [field, components] of Object.entries(host.unionMap)) {
        if (exclude.includes(field)) continue;
        for (const component of components) {
            const comp = await entity.get(component);
            if (comp && typeof comp === "object") {
                result[field] = {
                    __typename: compNameToFieldName(component.name),
                    ...comp,
                };
                break;
            }
        }
    }
    return result;
}

function isZodObject(schema: unknown): schema is ZodObject<Record<string, ZodType>> {
    if (!schema || typeof schema !== "object") return false;
    return "shape" in schema && typeof schema.shape === "object";
}

export function withValidation(
    baseSchema: ZodObject<Record<string, ZodType>>,
    validations: Record<string, ZodType>
): ZodObject<Record<string, ZodType>> {
    const shape: Record<string, ZodType> = { ...baseSchema.shape };
    for (const [path, validation] of Object.entries(validations)) {
        if (!path.includes(".")) {
            shape[path] = validation;
            continue;
        }
        const [field, ...nestedPath] = path.split(".");
        if (!field || !shape[field]) continue;
        const currentField = shape[field];
        const def = "_def" in currentField ? currentField._def : undefined;
        const isOptional = !!def && typeof def === "object" && "typeName" in def && def.typeName === "ZodOptional";
        const innerSchema = isOptional && "unwrap" in currentField && typeof currentField.unwrap === "function"
            ? currentField.unwrap()
            : currentField;
        if (!isZodObject(innerSchema)) continue;
        const nestedShape: Record<string, ZodType> = { ...innerSchema.shape };
        if (nestedPath.length === 1 && nestedPath[0] && nestedShape[nestedPath[0]]) {
            nestedShape[nestedPath[0]] = validation;
        }
        const rebuilt = z.object(nestedShape);
        shape[field] = isOptional ? rebuilt.optional() : rebuilt;
    }
    return z.object(shape);
}

export function filterSchemaFor(
    host: ArchetypeComponentHost,
    baseSchema: ZodObject<Record<string, ZodType>>
): ZodObject<Record<string, ZodType>> {
    const filterShape: Record<string, ZodType> = {};
    for (const key of Object.keys(baseSchema.shape)) {
        const isFilterable = host.fieldOptions[key]?.filterable === true || host.unionOptions[key]?.filterable === true;
        if (isFilterable) filterShape[key] = InputFilterSchema.optional();
    }
    return z.object(filterShape);
}

export function buildFilterBranches(
    host: ArchetypeComponentHost,
    filter?: FilterSchema<Record<string, unknown>>
): Array<{ component: ComponentConstructor; filters: Array<{ field: string; operator: unknown; value: unknown }> }> {
    if (!filter) return [];
    const branches: Array<{ component: ComponentConstructor; filters: Array<{ field: string; operator: unknown; value: unknown }> }> = [];
    for (const [fieldName, componentCtor] of Object.entries(host.componentMap)) {
        const fieldOption = host.fieldOptions[fieldName];
        const filterPart = filter[fieldName];
        if (!fieldOption?.filterable || !filterPart || typeof filterPart !== "object" || !("value" in filterPart) || !filterPart.value) {
            continue;
        }
        const part = filterPart as { value: unknown; op?: string; field?: string };
        const operator = part.op
            ? Query.filterOp[part.op.toUpperCase() as keyof typeof Query.filterOp]
            : Query.filterOp.LIKE;
        branches.push({
            component: componentCtor,
            filters: [{
                field: part.field || defaultFilterField(componentCtor),
                operator,
                value: operator === Query.filterOp.LIKE ? `%${String(part.value)}%` : part.value,
            }],
        });
    }
    return branches;
}

function defaultFilterField(componentCtor: { name: string }): string {
    const storage = getMetadataStorage();
    const props = storage.getComponentProperties(storage.getComponentId(componentCtor.name));
    if (props.some((p: ComponentPropertyMetadata) => p.propertyKey === "value")) return "value";
    if (props.some((p: ComponentPropertyMetadata) => p.propertyKey === "label")) return "label";
    return props[0]?.propertyKey || "value";
}
