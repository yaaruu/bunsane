import type { ComponentConstructor } from "../components/ComponentRegistry";
import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { Query } from "../../query";
import { getRequestScope } from "../requestScope";
import { resolveRelationTarget, type RelationTarget } from "./relationTarget";
import { resolveFkOnMap } from "./fkResolve";
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
function resolveRelatedArchetypeInstance(relatedArchetype: RelationTarget): { componentMap: Record<string, ComponentConstructor>; getEntityWithID: (id: string) => Promise<Entity | null> } | null {
    try {
        const { ctor } = resolveRelationTarget(relatedArchetype);
        return new ctor() as unknown as { componentMap: Record<string, ComponentConstructor>; getEntityWithID: (id: string) => Promise<Entity | null> };
    } catch {
        return null;
    }
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
        const fk = resolveFkOnMap(archetype.componentMap, foreignKey);
        if (fk) {
            const componentInstance = await entity.get(fk.componentCtor as never);
            if (componentInstance && typeof componentInstance === "object" && fk.foreignKeyField in componentInstance) {
                const value = (componentInstance as Record<string, unknown>)[fk.foreignKeyField];
                if (typeof value === "string") foreignId = value;
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

    const relatedArchetypeInstance = resolveRelatedArchetypeInstance(relatedArchetype);
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

    const relatedArchetypeInstance = resolveRelatedArchetypeInstance(relatedArchetype);
    if (!relatedArchetypeInstance) return;

    const fk = resolveFkOnMap(relatedArchetypeInstance.componentMap, foreignKey);
    if (!fk) return;

    const scope = getRequestScope();
    if (scope?.loaders?.relationsByComponentFk) {
        (entity as unknown as Record<string, unknown>)[fieldName] = await scope.loaders.relationsByComponentFk.load({
            entityId: entity.id,
            componentTypeId: fk.componentTypeId,
            foreignKeyField: fk.foreignKeyField,
        });
        return;
    }
    const query = new Query() as unknown as {
        with(ctor: ComponentConstructor, options: { filters: Array<{ field: string; operator: "="; value: string }> }): { exec(): Promise<unknown[]> };
    };
    const matchingEntities = await query.with(fk.componentCtor as unknown as ComponentConstructor, {
        filters: [{ field: fk.foreignKeyField, operator: "=", value: entity.id }],
    }).exec();

    (entity as unknown as Record<string, unknown>)[fieldName] = matchingEntities;
}
