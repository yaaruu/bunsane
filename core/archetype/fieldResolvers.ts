import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { Query } from "../../query";
import { compNameToFieldName, shouldUnwrapComponent } from "./helpers";
import {
    customTypeRegistry,
    customTypeNameRegistry,
    registeredCustomTypes,
} from "./customTypes";

let _ensureEntity: ((parent: any, context: any) => Promise<Entity>) | null = null;
function ensureEntity(parent: any, context: any): Promise<Entity> {
    if (!_ensureEntity) {
        const { BaseArcheType } = require("../ArcheType");
        _ensureEntity = (BaseArcheType as any).ensureEntity.bind(BaseArcheType);
    }
    return _ensureEntity!(parent, context);
}

export interface FieldResolverEntry {
    typeName: string;
    fieldName: string;
    resolver: (parent: any, args: any, context: any) => any;
}

/**
 * Build GraphQL field resolvers for an archetype instance.
 * Extracted from BaseArcheType.generateFieldResolvers().
 */
export function buildFieldResolvers(archetype: any): FieldResolverEntry[] {
    const storage = getMetadataStorage();
    const resolvers: FieldResolverEntry[] = [];
    const archetypeId = storage.getComponentId(archetype.constructor.name);
    const archetypeName =
        storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
        archetype.constructor.name;

    resolvers.push({
        typeName: archetypeName,
        fieldName: "id",
        resolver: (parent: any) => {
            return parent.id;
        },
    });

    for (const [field, ctor] of Object.entries(archetype.componentMap)) {
        const componentCtor = ctor as any;
        const typeId = storage.getComponentId(componentCtor.name);
        const typeIdHex = typeId;
        const componentName = componentCtor.name;
        const fieldType = archetype.fieldTypes[field];

        const componentProps = storage.getComponentProperties(typeId);
        if (componentProps.length === 0) {
            continue;
        }

        const isUnwrapped = shouldUnwrapComponent(componentProps, fieldType);

        // Detect whether the unwrapped 'value' prop is a Date so we can
        // normalize Date instances to ISO strings before they reach
        // gqloom's GraphQLString coercion (which would call .valueOf() and
        // emit epoch ms instead).
        const unwrappedValueProp = componentProps.find(p => p.propertyKey === 'value');
        const isUnwrappedDate = isUnwrapped && unwrappedValueProp?.propertyType === Date;
        const normalizeDateValue = (v: any) =>
            isUnwrappedDate && v instanceof Date ? v.toISOString() : v;

        if (isUnwrapped) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;
                    if (!entityId) return normalizeDateValue((parent as any)[field]);

                    if (parent instanceof Entity) {
                        if (parent.wasRemoved(componentCtor)) {
                            return null;
                        }
                        const inMemoryComp = parent.getInMemory(componentCtor);
                        if (inMemoryComp) {
                            return normalizeDateValue((inMemoryComp as any)?.value);
                        }
                    }

                    if (context?.loaders?.componentsByEntityType) {
                        const componentData =
                            await context.loaders.componentsByEntityType.load({
                                entityId: entityId,
                                typeId: typeIdHex,
                            });
                        if (componentData?.data?.value !== undefined) {
                            return normalizeDateValue(componentData.data.value);
                        }
                    }

                    const entity = await ensureEntity(parent, context);
                    const comp = await entity.get(componentCtor);
                    return normalizeDateValue((comp as any)?.value);
                },
            });
        } else {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;
                    if (!entityId) return (parent as any)[field];

                    if (parent instanceof Entity) {
                        if (parent.wasRemoved(componentCtor)) {
                            return null;
                        }
                        const inMemoryComp = parent.getInMemory(componentCtor);
                        if (inMemoryComp) {
                            return inMemoryComp;
                        }
                    }

                    if (context?.loaders?.componentsByEntityType) {
                        const componentData =
                            await context.loaders.componentsByEntityType.load({
                                entityId: entityId,
                                typeId: typeIdHex,
                            });
                        if (componentData?.data) {
                            return componentData.data;
                        }
                    }

                    const entity = await ensureEntity(parent, context);
                    const comp = await entity.get(componentCtor);
                    return comp;
                },
            });

            const componentTypeName = compNameToFieldName(componentName);

            for (const prop of componentProps) {
                const isDateProp = prop.propertyType === Date;
                resolvers.push({
                    typeName: componentTypeName,
                    fieldName: prop.propertyKey,
                    resolver: (parent: any) => {
                        const v = parent[prop.propertyKey];
                        if (isDateProp && v instanceof Date) {
                            return v.toISOString();
                        }
                        return v;
                    },
                });
            }
        }
    }

    for (const [field, components] of Object.entries(archetype.unionMap)) {
        const componentList = components as any[];
        resolvers.push({
            typeName: archetypeName,
            fieldName: field,
            resolver: async (parent: any, args: any, context: any) => {
                const entityId = parent?.id;
                if (!entityId) return null;

                for (const component of componentList) {
                    const typeId = storage.getComponentId(component.name);

                    if (parent instanceof Entity) {
                        if (parent.wasRemoved(component)) {
                            continue;
                        }
                        const inMemoryComp = parent.getInMemory(component);
                        if (inMemoryComp) {
                            return {
                                __typename: compNameToFieldName(component.name),
                                ...(inMemoryComp as any).data?.() ?? inMemoryComp,
                            };
                        }
                    }

                    if (context?.loaders?.componentsByEntityType) {
                        const componentData =
                            await context.loaders.componentsByEntityType.load({
                                entityId: entityId,
                                typeId: typeId,
                            });
                        if (componentData?.data) {
                            return {
                                __typename: compNameToFieldName(component.name),
                                ...componentData.data,
                            };
                        }
                    } else {
                        const entity = await ensureEntity(parent, context);
                        const comp = await entity.get(component);
                        if (comp) {
                            return {
                                __typename: compNameToFieldName(component.name),
                                ...(comp as any),
                            };
                        }
                    }
                }

                return null;
            },
        });
    }

    for (const [field, relatedArcheType] of Object.entries(archetype.relationMap)) {
        const relationType = archetype.relationTypes[field];
        const relationOptions = archetype.relationOptions[field];
        const isArray =
            relationType === "hasMany" || relationType === "belongsToMany";

        let relatedTypeName: string;
        if (typeof relatedArcheType === "string") {
            relatedTypeName = relatedArcheType;
        } else {
            const relatedArchetypeId = storage.getComponentId(
                (relatedArcheType as any).name
            );
            const relatedArchetypeMetadata = storage.archetypes.find(
                (a) => a.typeId === relatedArchetypeId
            );
            relatedTypeName =
                relatedArchetypeMetadata?.name ||
                (relatedArcheType as any).name.replace(/ArcheType$/, "");
        }

        if (
            !isArray &&
            relationType === "belongsTo" &&
            relationOptions?.foreignKey
        ) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;
                    if (!entityId) {
                        return null;
                    }

                    let foreignId: string | undefined;

                    if (context?.loaders?.componentsByEntityType) {
                        const foreignKey = relationOptions.foreignKey;
                        if (foreignKey && foreignKey.includes('.')) {
                            const [fieldName, propName] = foreignKey.split('.');
                            const compCtor = archetype.componentMap[fieldName!];
                            if (compCtor) {
                                const typeIdForComponent = storage.getComponentId(compCtor.name);
                                const componentData = await context.loaders.componentsByEntityType.load({
                                    entityId: entityId,
                                    typeId: typeIdForComponent,
                                });
                                if (componentData?.data && componentData.data[propName!] !== undefined) {
                                    foreignId = componentData.data[propName!];
                                }
                            }
                        } else {
                            for (const [componentField, compCtor] of Object.entries(archetype.componentMap)) {
                                const compCtorAny = compCtor as any;
                                const typeIdForComponent = storage.getComponentId(compCtorAny.name);
                                const componentProps = storage.getComponentProperties(typeIdForComponent);
                                const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                if (!hasForeignKey || !foreignKey) continue;

                                const componentData = await context.loaders.componentsByEntityType.load({
                                    entityId: entityId,
                                    typeId: typeIdForComponent,
                                });

                                if (componentData?.data && componentData.data[foreignKey] !== undefined) {
                                    foreignId = componentData.data[foreignKey];
                                    break;
                                }
                            }
                        }
                    }

                    if (!foreignId) {
                        const entity = await ensureEntity(parent, context);
                        const foreignKey = relationOptions.foreignKey;
                        if (foreignKey && foreignKey.includes('.')) {
                            const [fieldName, propName] = foreignKey.split('.');
                            const compCtor = archetype.componentMap[fieldName!];
                            if (compCtor) {
                                const componentInstance = await entity.get(compCtor as any);
                                if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                                    foreignId = (componentInstance as any)[propName!];
                                }
                            }
                        } else {
                            for (const compCtor of Object.values(archetype.componentMap)) {
                                const compCtorAny = compCtor as any;
                                const typeIdForComponent = storage.getComponentId(compCtorAny.name);
                                const componentProps = storage.getComponentProperties(typeIdForComponent);
                                const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                if (!hasForeignKey || !foreignKey) continue;
                                const componentInstance = await entity.get(compCtorAny);
                                if (componentInstance && (componentInstance as any)[foreignKey] !== undefined) {
                                    foreignId = (componentInstance as any)[foreignKey];
                                    break;
                                }
                            }
                        }
                    }

                    if (!foreignId && relationOptions.foreignKey === 'id') {
                        foreignId = entityId;
                    }

                    if (!foreignId) {
                        return null;
                    }

                    if (context.loaders?.entityById) {
                        const relatedEntity =
                            await context.loaders.entityById.load(foreignId);
                        if (relatedEntity) {
                            return relatedEntity;
                        }
                    }

                    return Entity.FindById(foreignId);
                },
            });
        } else if (isArray) {
            // Resolve the FK-bearing component + field ONCE (lazily, then
            // memoized) rather than re-instantiating the related archetype and
            // walking its component metadata on every parent row. The result is
            // captured in the resolver closure.
            let fkResolution:
                | { componentCtor: any; componentTypeId: string; foreignKeyField: string }
                | null
                | undefined;
            const resolveFk = () => {
                if (fkResolution !== undefined) return fkResolution;
                fkResolution = null;
                if (!relationOptions?.foreignKey) return fkResolution;

                let relatedArchetypeInstance: any = null;
                if (typeof relatedArcheType === "function") {
                    relatedArchetypeInstance = new (relatedArcheType as any)();
                } else if (typeof relatedArcheType === "string") {
                    const meta = storage.archetypes.find((a) => a.name === relatedArcheType);
                    if (meta) relatedArchetypeInstance = new (meta.target as any)();
                }
                if (!relatedArchetypeInstance) return fkResolution;

                let componentCtor: any = null;
                let foreignKeyField: string = relationOptions.foreignKey;
                if (relationOptions.foreignKey.includes('.')) {
                    const [fieldName, propName] = relationOptions.foreignKey.split('.');
                    componentCtor = relatedArchetypeInstance.componentMap[fieldName!];
                    foreignKeyField = propName!;
                } else {
                    for (const comp of Object.values(relatedArchetypeInstance.componentMap) as any[]) {
                        const typeId = storage.getComponentId(comp.name);
                        const props = storage.getComponentProperties(typeId);
                        if (props.some(p => p.propertyKey === relationOptions.foreignKey)) {
                            componentCtor = comp;
                            break;
                        }
                    }
                }
                if (componentCtor) {
                    fkResolution = {
                        componentCtor,
                        componentTypeId: storage.getComponentId(componentCtor.name),
                        foreignKeyField,
                    };
                }
                return fkResolution;
            };

            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;
                    if (!entityId) return [];

                    if (relationOptions?.foreignKey) {
                        const r = resolveFk();
                        if (!r) {
                            console.warn(`No component found with foreign key ${relationOptions.foreignKey} in ${relatedTypeName}`);
                            return [];
                        }
                        // Batched path: dedups across sibling parents in the
                        // same request via the type-scoped FK loader (was N+1).
                        if (context?.loaders?.relationsByComponentFk) {
                            return await context.loaders.relationsByComponentFk.load({
                                entityId,
                                componentTypeId: r.componentTypeId,
                                foreignKeyField: r.foreignKeyField,
                            });
                        }
                        // Fallback for non-request contexts (direct service
                        // calls with no loaders mounted): single query.
                        const query = new Query();
                        query.with(r.componentCtor, Query.filters(Query.filter(r.foreignKeyField, Query.filterOp.EQ, entityId)));
                        return await query.exec();
                    } else {
                        if (context?.loaders?.relationsByEntityField) {
                            return context.loaders.relationsByEntityField.load({
                                entityId: entityId,
                                relationField: field,
                                relatedType: relatedTypeName,
                                foreignKey: relationOptions?.foreignKey,
                            });
                        }

                        console.warn(
                            `No relationsByEntityField loader found for array relation ${field} on ${archetypeName}`
                        );
                        return [];
                    }
                },
            });
        } else {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;

                    if (relationOptions?.foreignKey) {
                        if (!entityId) {
                            return null;
                        }

                        let foreignId: string | undefined;

                        if (context?.loaders?.componentsByEntityType) {
                            const foreignKey = relationOptions.foreignKey;
                            if (foreignKey && foreignKey.includes('.')) {
                                const [fieldName, propName] = foreignKey.split('.');
                                const compCtor = archetype.componentMap[fieldName!];
                                if (compCtor) {
                                    const typeIdForComponent = storage.getComponentId(compCtor.name);
                                    const componentData = await context.loaders.componentsByEntityType.load({
                                        entityId: entityId,
                                        typeId: typeIdForComponent,
                                    });
                                    if (componentData?.data && componentData.data[propName!] !== undefined) {
                                        foreignId = componentData.data[propName!];
                                    }
                                }
                            } else {
                                const candidateLoads: Array<{ compCtor: any; typeId: string }> = [];
                                for (const [componentField, compCtor] of Object.entries(archetype.componentMap)) {
                                    const compCtorAny = compCtor as any;
                                    const typeIdForComponent = storage.getComponentId(compCtorAny.name);
                                    const componentProps = storage.getComponentProperties(typeIdForComponent);
                                    const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                    if (hasForeignKey && foreignKey) {
                                        candidateLoads.push({ compCtor: compCtorAny, typeId: typeIdForComponent });
                                    }
                                }

                                if (candidateLoads.length > 0) {
                                    const componentDataResults = await Promise.all(
                                        candidateLoads.map(({ typeId }) =>
                                            context.loaders.componentsByEntityType.load({
                                                entityId: entityId,
                                                typeId: typeId,
                                            })
                                        )
                                    );

                                    for (const componentData of componentDataResults) {
                                        if (componentData?.data && componentData.data[foreignKey] !== undefined) {
                                            foreignId = componentData.data[foreignKey];
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        if (!foreignId) {
                            const entity = await ensureEntity(parent, context);
                            const foreignKey = relationOptions.foreignKey;
                            if (foreignKey && foreignKey.includes('.')) {
                                const [fieldName, propName] = foreignKey.split('.');
                                const compCtor = archetype.componentMap[fieldName!];
                                if (compCtor) {
                                    const componentInstance = await entity.get(compCtor as any);
                                    if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                                        foreignId = (componentInstance as any)[propName!];
                                    }
                                }
                            } else {
                                const candidateComponents: Array<{ compCtor: any }> = [];
                                for (const compCtor of Object.values(archetype.componentMap)) {
                                    const compCtorAny = compCtor as any;
                                    const typeIdForComponent = storage.getComponentId(compCtorAny.name);
                                    const componentProps = storage.getComponentProperties(typeIdForComponent);
                                    const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                    if (hasForeignKey && foreignKey) {
                                        candidateComponents.push({ compCtor: compCtorAny });
                                    }
                                }

                                if (candidateComponents.length > 0) {
                                    const componentInstances = await Promise.all(
                                        candidateComponents.map(({ compCtor }) => entity.get(compCtor as any))
                                    );

                                    for (const componentInstance of componentInstances) {
                                        if (componentInstance && (componentInstance as any)[foreignKey] !== undefined) {
                                            foreignId = (componentInstance as any)[foreignKey];
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        if (!foreignId) {
                            return null;
                        }

                        if (context?.loaders?.entityById) {
                            const relatedEntity = await context.loaders.entityById.load(foreignId);
                            if (relatedEntity) {
                                return relatedEntity;
                            }
                        }

                        return Entity.FindById(foreignId);
                    } else {
                        if (context?.loaders?.relationsByEntityField) {
                            const results =
                                await context.loaders.relationsByEntityField.load({
                                    entityId: entityId,
                                    relationField: field,
                                    relatedType: relatedTypeName,
                                    foreignKey: relationOptions?.foreignKey,
                                });
                            if (results.length > 0) {
                                return results[0];
                            }
                        }

                        console.warn(
                            `No relationsByEntityField loader found for single relation ${field} on ${archetypeName}`
                        );
                        return null;
                    }
                },
            });
        }
    }

    for (const { propertyKey, options } of archetype.functions) {
        resolvers.push({
            typeName: archetypeName,
            fieldName: propertyKey,
            resolver: async (parent: any, args: any, context: any) => {
                let entity: Entity;
                if (parent instanceof Entity) {
                    entity = parent;
                } else if (parent && parent.id) {
                    if (context.loaders?.entityById) {
                        const loadedEntity = await context.loaders.entityById.load(parent.id);
                        if (loadedEntity) {
                            entity = loadedEntity;
                        } else {
                            entity = new Entity(parent.id);
                            entity.setPersisted(true);
                        }
                    } else {
                        entity = new Entity(parent.id);
                        entity.setPersisted(true);
                    }
                } else {
                    throw new Error(`Invalid parent for ${archetypeName}.${propertyKey}: parent must have an 'id' property`);
                }

                if (options?.args && options.args.length > 0 && args) {
                    const functionArgs: any[] = [];

                    for (const argDef of options.args) {
                        const argValue = args[argDef.name];

                        if (argValue === undefined || argValue === null) {
                            if (!argDef.nullable) {
                                throw new Error(`Required argument '${argDef.name}' is missing for ${archetypeName}.${propertyKey}`);
                            }
                            functionArgs.push(null);
                            continue;
                        }

                        let convertedValue: any = argValue;

                        if (argDef.type && typeof argDef.type === 'function' && argDef.type !== String && argDef.type !== Number && argDef.type !== Boolean && argDef.type !== Date) {
                            const isCustomType = customTypeRegistry.has(argDef.type) ||
                                                customTypeNameRegistry.has(argDef.type) ||
                                                (argDef.type?.name && registeredCustomTypes.has(argDef.type.name));

                            if (isCustomType && typeof argValue === 'object' && !Array.isArray(argValue)) {
                                try {
                                    if (argDef.type.prototype && argDef.type.prototype.constructor) {
                                        convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);

                                        if (!convertedValue || !(convertedValue instanceof argDef.type)) {
                                            const constructor = argDef.type.prototype.constructor;
                                            const paramCount = constructor.length;

                                            if (paramCount === 2) {
                                                if (argValue.latitude !== undefined && argValue.longitude !== undefined) {
                                                    convertedValue = new argDef.type(argValue.latitude, argValue.longitude);
                                                } else if (argValue.x !== undefined && argValue.y !== undefined) {
                                                    convertedValue = new argDef.type(argValue.x, argValue.y);
                                                } else {
                                                    const values = Object.values(argValue);
                                                    if (values.length >= 2) {
                                                        convertedValue = new argDef.type(values[0], values[1]);
                                                    }
                                                }
                                            } else if (paramCount === 1) {
                                                const values = Object.values(argValue);
                                                if (values.length >= 1) {
                                                    convertedValue = new argDef.type(values[0]);
                                                }
                                            } else if (paramCount === 0) {
                                                convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);
                                            }

                                            if (!convertedValue || !(convertedValue instanceof argDef.type)) {
                                                convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);
                                            }
                                        }
                                    } else {
                                        convertedValue = argValue;
                                    }
                                } catch (e) {
                                    try {
                                        convertedValue = Object.assign(Object.create(argDef.type.prototype || {}), argValue);
                                    } catch (e2) {
                                        convertedValue = argValue;
                                    }
                                }
                            } else {
                                convertedValue = argValue;
                            }
                        }

                        functionArgs.push(convertedValue);
                    }

                    return await archetype[propertyKey](entity, ...functionArgs);
                } else {
                    return await archetype[propertyKey](entity);
                }
            },
        });
    }

    return resolvers;
}
