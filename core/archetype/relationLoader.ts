import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { Query } from "../../query";
import { getRequestScope } from "../requestScope";

/**
 * Populate relation fields on an entity according to the archetype's relationMap.
 * Extracted from BaseArcheType.populateRelations().
 *
 * When called inside a request scope (GraphQL execution), relation loads go
 * through the request's DataLoaders so sibling entities resolved in the same
 * tick batch into single queries (previously: one `new Query()` per relation
 * per entity — a hard N+1). Relation fields of one entity are resolved
 * concurrently for the same reason.
 */
export async function populateRelations(archetype: any, entity: Entity): Promise<void> {
    const storage = getMetadataStorage();

    const fieldPromises: Promise<void>[] = [];
    for (const [fieldName, relatedArchetype] of Object.entries(archetype.relationMap)) {
        const relationType = archetype.relationTypes[fieldName];
        const relationOptions = archetype.relationOptions[fieldName];

        if (relationType === "belongsTo") {
            fieldPromises.push(populateBelongsTo(archetype, entity, fieldName, relatedArchetype, relationOptions, storage));
        } else if (relationType === "hasMany") {
            fieldPromises.push(populateHasMany(entity, fieldName, relatedArchetype, relationOptions, storage));
        }
    }
    await Promise.all(fieldPromises);
}

function resolveRelatedArchetypeInstance(relatedArchetype: any, storage: any): any | null {
    if (typeof relatedArchetype === "function") {
        return new (relatedArchetype as any)();
    }
    const meta = storage.archetypes.find((a: any) => a.name === relatedArchetype);
    return meta ? new (meta.target as any)() : null;
}

async function populateBelongsTo(
    archetype: any,
    entity: Entity,
    fieldName: string,
    relatedArchetype: any,
    relationOptions: any,
    storage: any,
): Promise<void> {
    const foreignKey = relationOptions?.foreignKey;
    if (!foreignKey) return;

    let foreignId: string | undefined;

    if (foreignKey.includes('.')) {
        const [innerField, propName] = foreignKey.split('.');
        const compCtor = archetype.componentMap[innerField!];
        if (compCtor) {
            // entity.get batches via the ambient request scope when present
            const componentInstance = await entity.get(compCtor as any);
            if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                foreignId = (componentInstance as any)[propName!];
            }
        }
    } else {
        const candidateComponents: Array<{ compCtor: any }> = [];
        for (const compCtor of Object.values(archetype.componentMap)) {
            const compCtorAny = compCtor as any;
            const typeId = storage.getComponentId(compCtorAny.name);
            const componentProps = storage.getComponentProperties(typeId);
            const hasForeignKey = componentProps.some((prop: any) => prop.propertyKey === foreignKey);
            if (hasForeignKey) {
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

    if (!foreignId && foreignKey === 'id') {
        foreignId = entity.id;
    }
    if (!foreignId) return;

    // Batched path: the request-scoped entityById loader dedups/batches
    // sibling lookups. The returned shell entity lazy-loads components
    // through the same scope's component loader.
    const scope = getRequestScope();
    if (scope?.loaders?.entityById) {
        const relatedEntity = await scope.loaders.entityById.load(foreignId);
        if (relatedEntity) {
            (entity as any)[fieldName] = relatedEntity;
        }
        return;
    }

    const relatedArchetypeInstance = resolveRelatedArchetypeInstance(relatedArchetype, storage);
    if (!relatedArchetypeInstance) return;
    const relatedEntity = await relatedArchetypeInstance.getEntityWithID(foreignId);
    if (relatedEntity) {
        (entity as any)[fieldName] = relatedEntity;
    }
}

async function populateHasMany(
    entity: Entity,
    fieldName: string,
    relatedArchetype: any,
    relationOptions: any,
    storage: any,
): Promise<void> {
    const foreignKey = relationOptions?.foreignKey;
    if (!foreignKey) return;

    const relatedArchetypeInstance = resolveRelatedArchetypeInstance(relatedArchetype, storage);
    if (!relatedArchetypeInstance) return;

    let foreignKeyComponent: any = null;
    for (const compCtor of Object.values(relatedArchetypeInstance.componentMap)) {
        const compCtorAny = compCtor as any;
        const typeId = storage.getComponentId(compCtorAny.name);
        const componentProps = storage.getComponentProperties(typeId);
        const hasForeignKey = componentProps.some((prop: any) => prop.propertyKey === foreignKey);
        if (hasForeignKey) {
            foreignKeyComponent = compCtorAny;
            break;
        }
    }
    if (!foreignKeyComponent) return;

    // Batched path: type-scoped FK loader collapses sibling parents sharing
    // the same (componentType, fkField) into one query.
    const scope = getRequestScope();
    if (scope?.loaders?.relationsByComponentFk) {
        const componentTypeId = storage.getComponentId(foreignKeyComponent.name);
        (entity as any)[fieldName] = await scope.loaders.relationsByComponentFk.load({
            entityId: entity.id,
            componentTypeId,
            foreignKeyField: foreignKey,
        });
        return;
    }

    const matchingEntities = await new Query()
        .with(foreignKeyComponent, {
            filters: [{ field: foreignKey, operator: '=', value: entity.id }]
        })
        .exec();

    (entity as any)[fieldName] = matchingEntities;
}
