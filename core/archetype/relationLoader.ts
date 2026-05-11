import { Entity } from "../Entity";
import { getMetadataStorage } from "../metadata";
import { Query } from "../../query";

/**
 * Populate relation fields on an entity according to the archetype's relationMap.
 * Extracted from BaseArcheType.populateRelations().
 */
export async function populateRelations(archetype: any, entity: Entity): Promise<void> {
    const storage = getMetadataStorage();

    for (const [fieldName, relatedArchetype] of Object.entries(archetype.relationMap)) {
        const relationType = archetype.relationTypes[fieldName];
        const relationOptions = archetype.relationOptions[fieldName];

        if (relationType === "belongsTo") {
            const foreignKey = relationOptions?.foreignKey;
            if (foreignKey) {
                let foreignId: string | undefined;

                if (foreignKey.includes('.')) {
                    const [innerField, propName] = foreignKey.split('.');
                    const compCtor = archetype.componentMap[innerField!];
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
                        const typeId = storage.getComponentId(compCtorAny.name);
                        const componentProps = storage.getComponentProperties(typeId);
                        const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
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

                if (foreignId) {
                    let relatedArchetypeInstance: any;
                    if (typeof relatedArchetype === "function") {
                        relatedArchetypeInstance = new (relatedArchetype as any)();
                    } else {
                        const relatedArchetypeMetadata = storage.archetypes.find((a) => a.name === relatedArchetype);
                        if (relatedArchetypeMetadata) {
                            relatedArchetypeInstance = new (relatedArchetypeMetadata.target as any)();
                        } else {
                            continue;
                        }
                    }

                    const relatedEntity = await relatedArchetypeInstance.getEntityWithID(foreignId);
                    if (relatedEntity) {
                        (entity as any)[fieldName] = relatedEntity;
                    }
                }
            }
        } else if (relationType === "hasMany") {
            const foreignKey = relationOptions?.foreignKey;
            if (foreignKey) {
                let relatedArchetypeInstance: any;
                if (typeof relatedArchetype === "function") {
                    relatedArchetypeInstance = new (relatedArchetype as any)();
                } else {
                    const relatedArchetypeMetadata = storage.archetypes.find((a) => a.name === relatedArchetype);
                    if (relatedArchetypeMetadata) {
                        relatedArchetypeInstance = new (relatedArchetypeMetadata.target as any)();
                    } else {
                        continue;
                    }
                }

                let foreignKeyComponent: any = null;
                for (const compCtor of Object.values(relatedArchetypeInstance.componentMap)) {
                    const compCtorAny = compCtor as any;
                    const typeId = storage.getComponentId(compCtorAny.name);
                    const componentProps = storage.getComponentProperties(typeId);
                    const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                    if (hasForeignKey) {
                        foreignKeyComponent = compCtorAny;
                        break;
                    }
                }

                if (foreignKeyComponent) {
                    const matchingEntities = await new Query()
                        .with(foreignKeyComponent, {
                            filters: [{ field: foreignKey, operator: '=', value: entity.id }]
                        })
                        .exec();

                    (entity as any)[fieldName] = matchingEntities;
                }
            }
        }
    }
}
