import type { ComponentConstructor } from "../components/ComponentRegistry";
import DataLoader from "dataloader";
import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { Query } from "../../query";
import { logger } from "../Logger";
import { compNameToFieldName, shouldUnwrapComponent } from "./helpers";
import {
    customTypeRegistry,
    customTypeNameRegistry,
    registeredCustomTypes,
} from "./customTypes";
import { ensureEntity } from "./ensureEntity";
import { componentMapOf, memoResolveFk, requireImplicitFk, type FkResolution } from "./fkResolve";
import { archetypeGraphqlName, resolveRelationTarget, type RelationTarget } from "./relationTarget";
import {
    functionOutputAllowsNull,
    functionOutputZod,
    rejectBatchMiss,
    type ArchetypeFunctionOptions,
} from "./functionReturn";
import "reflect-metadata";

export interface FieldResolverEntry {
    typeName: string;
    fieldName: string;
    resolver: (parent: unknown, args: unknown, context: unknown) => unknown;
}

type ComponentCtor = ComponentConstructor;

interface ComponentLoaders {
    componentsByEntityType?: {
        load: (key: { entityId: string; typeId: string }) => Promise<{ data?: Record<string, unknown> } | null>;
    };
    entityById?: {
        load: (id: string) => Promise<Entity | null>;
    };
    relationsByComponentFk?: {
        load: (key: { entityId: string; componentTypeId: string; foreignKeyField: string }) => Promise<unknown>;
    };
    archetypeFunctionBatches?: Map<string, DataLoader<Entity, unknown, string>>;
}

interface ResolverContext {
    loaders?: ComponentLoaders;
}

interface ArchetypeForResolvers {
    constructor: { name: string; prototype: object };
    componentMap: Record<string, ComponentCtor>;
    fieldTypes: Record<string, unknown>;
    unionMap: Record<string, ComponentCtor[]>;
    relationMap: Record<string, RelationTarget>;
    relationTypes: Record<string, string>;
    relationOptions: Record<string, { foreignKey?: string; nullable?: boolean } | undefined>;
    functions: Array<{ propertyKey: string; options?: ArchetypeFunctionOptions }>;
}

function firstRelation(rows: unknown): unknown {
    return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}


function loadersOf(context: unknown): ComponentLoaders | undefined {
    if (!context || typeof context !== "object" || !("loaders" in context)) return undefined;
    return (context as ResolverContext).loaders;
}
function entityIdOf(parent: unknown): string | undefined {
    if (!parent || typeof parent !== "object" || !("id" in parent)) return undefined;
    const id = parent.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Plain objects and ArcheTypeResult already carry the field — do not refetch. */
function presentValue(parent: unknown, field: string): { hit: true; value: unknown } | { hit: false } {
    if (parent == null || typeof parent !== "object" || parent instanceof Entity) return { hit: false };
    const record = parent as unknown as Record<string, unknown>;
    if (!(field in record) || record[field] === undefined) return { hit: false };
    return { hit: true, value: record[field] };
}

function asDate(value: unknown): string | unknown {
    return value instanceof Date ? value.toISOString() : value;
}

function recordData(row: { data?: Record<string, unknown> } | null | undefined): Record<string, unknown> | undefined {
    return row?.data;
}

async function loadComponentData(
    context: unknown,
    entityId: string,
    typeId: string
): Promise<Record<string, unknown> | undefined> {
    const loader = loadersOf(context)?.componentsByEntityType;
    if (!loader) return undefined;
    const row = await loader.load({ entityId, typeId });
    return recordData(row);
}

function foreignIdFromData(data: Record<string, unknown> | undefined, field: string): string | undefined {
    if (!data || data[field] === undefined || data[field] === null) return undefined;
    const value = data[field];
    return typeof value === "string" ? value : String(value);
}

/**
 * Build GraphQL field resolvers for an archetype instance.
 * In-memory hits and already-populated parents return synchronously.
 * Leaf resolvers are installed only for Date props.
 */
export function buildFieldResolvers(archetype: ArchetypeForResolvers): FieldResolverEntry[] {
    const storage = getMetadataStorage();
    const resolvers: FieldResolverEntry[] = [];
    const archetypeName = archetypeGraphqlName(archetype);

    resolvers.push({
        typeName: archetypeName,
        fieldName: "id",
        resolver: (parent) => (parent && typeof parent === "object" && "id" in parent ? parent.id : undefined),
    });

    for (const [field, ctor] of Object.entries(archetype.componentMap)) {
        const typeId = storage.getComponentId(ctor.name);
        const componentProps = storage.getComponentProperties(typeId);
        if (componentProps.length === 0) continue;

        const fieldType = archetype.fieldTypes[field];
        const isUnwrapped = shouldUnwrapComponent(componentProps, fieldType);
        const unwrappedValueProp = componentProps.find((p) => p.propertyKey === "value");
        const isUnwrappedDate = isUnwrapped && unwrappedValueProp?.propertyType === Date;

        resolvers.push({
            typeName: archetypeName,
            fieldName: field,
            resolver: (parent, _args, context) => {
                const present = presentValue(parent, field);
                if (present.hit) {
                    return isUnwrappedDate ? asDate(present.value) : present.value;
                }
                if (parent instanceof Entity) {
                    if (parent.wasRemoved(ctor as never)) return null;
                    const inMemory = parent.getInMemory(ctor as never);
                    if (inMemory) {
                        if (isUnwrapped) {
                            const value = "value" in inMemory ? inMemory.value : undefined;
                            return isUnwrappedDate ? asDate(value) : value;
                        }
                        return inMemory;
                    }
                }
                const entityId = entityIdOf(parent);
                if (!entityId) {
                    return undefined;
                }
                if (loadersOf(context)?.componentsByEntityType) {
                    return loadComponentData(context, entityId, typeId).then((data) => {
                        if (isUnwrapped) {
                            const value = data?.value;
                            return isUnwrappedDate ? asDate(value) : value;
                        }
                        return data ?? null;
                    });
                }
                return ensureEntity(parent, context).then(async (entity) => {
                    const comp = await entity.get(ctor as never);
                    if (isUnwrapped) {
                        const value = comp && typeof comp === "object" && "value" in comp ? comp.value : undefined;
                        return isUnwrappedDate ? asDate(value) : value;
                    }
                    return comp;
                });
            },
        });

        if (isUnwrapped) continue;
        const componentTypeName = compNameToFieldName(ctor.name);
        for (const prop of componentProps) {
            if (prop.propertyType !== Date) continue;
            resolvers.push({
                typeName: componentTypeName,
                fieldName: prop.propertyKey,
                resolver: (parent) => {
                    if (!parent || typeof parent !== "object") return undefined;
                    const record = parent as unknown as Record<string, unknown>;
                    return asDate(record[prop.propertyKey]);
                },
            });
        }
    }

    for (const [field, components] of Object.entries(archetype.unionMap)) {
        resolvers.push({
            typeName: archetypeName,
            fieldName: field,
            resolver: (parent, _args, context) => {
                const present = presentValue(parent, field);
                if (present.hit) return present.value;
                const entityId = entityIdOf(parent);
                if (!entityId) return null;

                if (parent instanceof Entity) {
                    for (const component of components) {
                        if (parent.wasRemoved(component as never)) continue;
                        const inMemory = parent.getInMemory(component as never);
                        if (!inMemory) continue;
                        const data = typeof inMemory.data === "function" ? inMemory.data() : inMemory;
                        return {
                            __typename: compNameToFieldName(component.name),
                            ...(data && typeof data === "object" ? data : {}),
                        };
                    }
                }

                const loader = loadersOf(context)?.componentsByEntityType;
                if (loader) {
                    return Promise.all(components.map(async (component) => {
                        const row = await loader.load({
                            entityId,
                            typeId: storage.getComponentId(component.name),
                        });
                        if (!row?.data) return null;
                        return {
                            __typename: compNameToFieldName(component.name),
                            ...row.data,
                        };
                    })).then((hits) => hits.find((hit) => hit != null) ?? null);
                }

                return Promise.all(components.map(async (component) => {
                    const entity = await ensureEntity(parent, context);
                    const comp = await entity.get(component as never);
                    if (!comp || typeof comp !== "object") return null;
                    return {
                        __typename: compNameToFieldName(component.name),
                        ...comp,
                    };
                })).then((hits) => hits.find((hit) => hit != null) ?? null);
            },
        });
    }

    for (const [field, relatedArcheType] of Object.entries(archetype.relationMap)) {
        const relationType = archetype.relationTypes[field];
        const relationOptions = archetype.relationOptions[field];
        const isArray = relationType === "hasMany" || relationType === "belongsToMany";
        const isSingleChild = relationType === "hasOne";
        const resolved = resolveRelationTarget(relatedArcheType);
        const owning = relationType === "belongsTo"
            ? archetype.componentMap
            : componentMapOf(new resolved.ctor());
        const explicitFk = relationOptions?.foreignKey;
        // Absent foreignKey is inferred once so LIST partitions can prune.
        const fk: FkResolution | null = explicitFk
            ? memoResolveFk(() => owning, explicitFk)()
            : requireImplicitFk(archetypeName, field, owning);

        if (isArray || isSingleChild) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: (parent, _args, context) => {
                    const present = presentValue(parent, field);
                    if (present.hit) return present.value;
                    const entityId = entityIdOf(parent);
                    if (!entityId) return isArray ? [] : null;
                    if (!fk) {
                        logger.warn(
                            { scope: "fieldResolvers", archetype: resolved.name, foreignKey: explicitFk },
                            `No component found with foreign key ${explicitFk}`
                        );
                        return isArray ? [] : null;
                    }
                    const rows = loadRelatedByFk(context, entityId, fk);
                    return isArray ? rows : Promise.resolve(rows).then((found) => firstRelation(found));
                },
            });
            continue;
        }

        resolvers.push({
            typeName: archetypeName,
            fieldName: field,
            resolver: (parent, _args, context) => {
                const present = presentValue(parent, field);
                if (present.hit) return present.value;
                const entityId = entityIdOf(parent);
                if (!entityId) return null;
                if (!fk) {
                    logger.warn(
                        { scope: "fieldResolvers", archetype: archetypeName, field, foreignKey: explicitFk },
                        `No component found with foreign key ${explicitFk}`
                    );
                    return null;
                }
                // belongsTo stores the FK on the parent; the component loader pins type_id.
                return readSingleForeignId(
                    parent,
                    entityId,
                    context,
                    () => fk,
                    relationType === "belongsTo" && explicitFk === "id"
                ).then(async (foreignId) => {
                    if (!foreignId) return null;
                    const byId = loadersOf(context)?.entityById;
                    if (byId) return (await byId.load(foreignId)) ?? null;
                    return Entity.FindById(foreignId);
                });
            },
        });
    }

    for (const { propertyKey, options } of archetype.functions) {
        if (options?.batch === true) {
            resolvers.push(batchFunctionResolver(archetype, archetypeName, propertyKey, options));
            continue;
        }
        resolvers.push({
            typeName: archetypeName,
            fieldName: propertyKey,
            resolver: (parent, args, context) => {
                const present = presentValue(parent, propertyKey);
                if (present.hit) return present.value;
                return invokeArchetypeFunction(archetype, archetypeName, propertyKey, options, parent, args, context);
            },
        });
    }

    return resolvers;
}

async function readSingleForeignId(
    parent: unknown,
    entityId: string,
    context: unknown,
    resolveFk: () => FkResolution | null,
    belongsToIdFallback: boolean
): Promise<string | undefined> {
    const fk = resolveFk();
    let foreignId: string | undefined;
    const componentLoader = loadersOf(context)?.componentsByEntityType;
    if (fk && componentLoader) {
        const data = recordData(await componentLoader.load({ entityId, typeId: fk.componentTypeId }));
        foreignId = foreignIdFromData(data, fk.foreignKeyField);
    } else if (fk && !componentLoader) {
        const entity = await ensureEntity(parent, context);
        const component = await entity.get(fk.componentCtor as never);
        if (component && typeof component === "object" && fk.foreignKeyField in component) {
            foreignId = foreignIdFromData(component as Record<string, unknown>, fk.foreignKeyField);
        }
    }
    if (!foreignId && belongsToIdFallback) {
        foreignId = entityId;
    }
    return foreignId;
}

function isCustomArgType(type: unknown): type is new (...args: never[]) => object {
    return typeof type === "function" && type !== String && type !== Number && type !== Boolean && type !== Date;
}

function convertArg(type: unknown, argValue: unknown): unknown {
    if (!isCustomArgType(type)) return argValue;
    const registered = customTypeRegistry.has(type)
        || customTypeNameRegistry.has(type)
        || registeredCustomTypes.has(type.name);
    if (!registered || typeof argValue !== "object" || argValue === null || Array.isArray(argValue)) {
        return argValue;
    }
    const proto = type.prototype;
    if (!proto) return argValue;
    try {
        const assigned = Object.assign(Object.create(proto), argValue);
        if (assigned instanceof type) return assigned;
        const ctor = proto.constructor as new (...args: unknown[]) => object;
        const paramCount = ctor.length;
        const values = Object.values(argValue);
        if (paramCount === 2 && values.length >= 2) return new ctor(values[0], values[1]);
        if (paramCount === 1 && values.length >= 1) return new ctor(values[0]);
        return assigned;
    } catch {
        return argValue;
    }
}

const archetypeReceivers = new WeakMap<object, object>();

function resolveArchetypeMethod(
    archetype: ArchetypeForResolvers,
    archetypeName: string,
    propertyKey: string,
): { receiver: object; method: (...args: unknown[]) => unknown } {
    const ctor = archetype.constructor as { prototype?: object; new (): object };
    const proto = ctor.prototype;
    const fromProto = proto && typeof proto === "object"
        ? (proto as Record<string, unknown>)[propertyKey]
        : undefined;
    const fromObject = (archetype as unknown as Record<string, unknown>)[propertyKey];
    const method = typeof fromProto === "function" ? fromProto : fromObject;
    if (typeof method !== "function") {
        throw new Error(`${archetypeName}.${propertyKey} is not a function`);
    }
    let receiver = archetypeReceivers.get(archetype);
    if (!receiver) {
        // generateFieldResolvers passes a plain view; methods expect the class instance.
        receiver = typeof ctor === "function" ? new ctor() : archetype;
        archetypeReceivers.set(archetype, receiver);
    }
    return { receiver, method: method as (...args: unknown[]) => unknown };
}

async function invokeArchetypeFunction(
    archetype: ArchetypeForResolvers,
    archetypeName: string,
    propertyKey: string,
    options: ArchetypeFunctionOptions | undefined,
    parent: unknown,
    args: unknown,
    context: unknown
): Promise<unknown> {
    const entity = await parentEntity(archetypeName, propertyKey, parent, context);
    const { receiver, method } = resolveArchetypeMethod(archetype, archetypeName, propertyKey);
    const argDefs = options?.args ?? [];
    if (argDefs.length === 0 || !args || typeof args !== "object") {
        return method.call(receiver, entity);
    }
    const argRecord = readArgRecord(archetypeName, propertyKey, options, args);
    const functionArgs = argDefs.map((argDef) => argRecord?.[argDef.name]);
    return method.call(receiver, entity, ...functionArgs);
}

function loadRelatedByFk(context: unknown, entityId: string, fk: FkResolution): Promise<unknown> {
    const batched = loadersOf(context)?.relationsByComponentFk;
    if (batched) {
        return batched.load({
            entityId,
            componentTypeId: fk.componentTypeId,
            foreignKeyField: fk.foreignKeyField,
        });
    }
    // Query's filter tuple is compile-time only; the runtime builder accepts this shape.
    const query = new Query() as unknown as {
        with(ctor: ComponentCtor, options: { filters: Array<{ field: string; operator: string; value: string }> }): { exec(): Promise<unknown> };
    };
    return query.with(fk.componentCtor, {
        filters: [{ field: fk.foreignKeyField, operator: "=", value: entityId }],
    }).exec();
}

function stableSerialize(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function readArgRecord(
    archetypeName: string,
    propertyKey: string,
    options: ArchetypeFunctionOptions | undefined,
    args: unknown,
): Record<string, unknown> | undefined {
    const argDefs = options?.args ?? [];
    if (argDefs.length === 0) return undefined;
    const argRecord = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const out: Record<string, unknown> = {};
    for (const argDef of argDefs) {
        const argValue = argRecord[argDef.name];
        if (argValue === undefined || argValue === null) {
            if (!argDef.nullable) {
                throw new Error(`Required argument '${argDef.name}' is missing for ${archetypeName}.${propertyKey}`);
            }
            out[argDef.name] = null;
            continue;
        }
        out[argDef.name] = convertArg(argDef.type, argValue);
    }
    return out;
}

async function parentEntity(
    archetypeName: string,
    propertyKey: string,
    parent: unknown,
    context: unknown,
): Promise<Entity> {
    if (parent instanceof Entity) return parent;
    const id = entityIdOf(parent);
    if (!id) {
        throw new Error(`Invalid parent for ${archetypeName}.${propertyKey}: parent must have an 'id' property`);
    }
    const loaded = loadersOf(context)?.entityById
        ? await loadersOf(context)!.entityById!.load(id)
        : null;
    if (loaded) return loaded;
    const entity = new Entity(id);
    entity.setPersisted(true);
    return entity;
}

interface FunctionBatchLoader {
    load(entity: Entity): Promise<unknown>;
}

function getFunctionBatchLoader(
    context: unknown,
    cacheKey: string,
    run: (entities: readonly Entity[]) => Promise<unknown[]>,
): FunctionBatchLoader {
    const map = loadersOf(context)?.archetypeFunctionBatches;
    if (!map) {
        return {
            load: async (entity) => {
                const values = await run([entity]);
                const value = values[0];
                if (value instanceof Error) throw value;
                return value;
            },
        };
    }
    const existing = map.get(cacheKey);
    if (existing) return existing;
    const loader = new DataLoader<Entity, unknown, string>(run, {
        cacheKeyFn: (entity) => entity.id,
    });
    map.set(cacheKey, loader);
    return loader;
}

async function runFunctionBatch(
    archetype: ArchetypeForResolvers,
    archetypeName: string,
    propertyKey: string,
    entities: readonly Entity[],
    context: unknown,
    argRecord: Record<string, unknown> | undefined,
    allowsNull: boolean,
): Promise<unknown[]> {
    const { receiver, method } = resolveArchetypeMethod(archetype, archetypeName, propertyKey);
    const result: unknown = await method.call(receiver, entities, context, argRecord);
    if (!(result instanceof Map)) {
        throw new Error(
            `@ArcheTypeFunction ${archetypeName}.${propertyKey} batch: true must return a Map keyed by entity id`
        );
    }
    return entities.map((entity) => {
        if (!result.has(entity.id)) {
            return rejectBatchMiss(allowsNull, archetypeName, propertyKey, entity.id);
        }
        const value = result.get(entity.id);
        if (value === undefined) {
            return rejectBatchMiss(allowsNull, archetypeName, propertyKey, entity.id);
        }
        return value;
    });
}

function batchFunctionResolver(
    archetype: ArchetypeForResolvers,
    archetypeName: string,
    propertyKey: string,
    options: ArchetypeFunctionOptions,
): FieldResolverEntry {
    const designReturn: unknown = Reflect.getMetadata(
        "design:returntype",
        archetype.constructor.prototype,
        propertyKey,
    );
    const allowsNull = functionOutputAllowsNull(
        functionOutputZod(archetypeName, propertyKey, options, designReturn),
    );
    return {
        typeName: archetypeName,
        fieldName: propertyKey,
        resolver: (parent, args, context) => {
            const present = presentValue(parent, propertyKey);
            if (present.hit) return present.value;
            const argRecord = readArgRecord(archetypeName, propertyKey, options, args);
            const cacheKey = `${archetypeName}\0${propertyKey}\0${argRecord === undefined ? "" : stableSerialize(argRecord)}`;
            const loader = getFunctionBatchLoader(context, cacheKey, (entities) =>
                runFunctionBatch(archetype, archetypeName, propertyKey, entities, context, argRecord, allowsNull),
            );
            if (parent instanceof Entity) return loader.load(parent);
            return parentEntity(archetypeName, propertyKey, parent, context).then((entity) => loader.load(entity));
        },
    };
}
