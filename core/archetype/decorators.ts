import type { BaseComponent } from "../components";
import type { ArcheTypeFieldOptions } from "../metadata/definitions/ArcheType";
import type { BaseArcheType, ArcheTypeOptions, RelationOptions } from "../ArcheType";
import { getMetadataStorage } from "../metadata";
import "reflect-metadata";

export const archetypeFunctionsSymbol = Symbol.for("bunsane:archetypeFunctions");
export const archetypeFieldsSymbol = Symbol.for("bunsane:archetypeFields");
export const archetypeUnionFieldsSymbol = Symbol.for("bunsane:archetypeUnionFields");
export const archetypeRelationsSymbol = Symbol.for("bunsane:archetypeRelations");

export function ArcheTypeFunction(options?: {
    returnType?: string;
    args?: Array<{
        name: string;
        type: any;
        nullable?: boolean;
    }>;
}) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeFunctionsSymbol]) {
            target[archetypeFunctionsSymbol] = [];
        }
        target[archetypeFunctionsSymbol].push({ propertyKey, options });
    };
}

export function ArcheType<T extends new () => BaseArcheType>(
    nameOrOptions?: string | ArcheTypeOptions
) {
    return function (target: T): T {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(target.name);

        let archetype_name = target.name;

        if (typeof nameOrOptions === "string") {
            archetype_name = nameOrOptions;
        } else if (nameOrOptions) {
            archetype_name = nameOrOptions.name || target.name;
        }

        storage.collectArcheTypeMetadata({
            name: archetype_name,
            typeId: typeId,
            target: target,
        });

        const prototype = target.prototype;
        const fields = prototype[archetypeFieldsSymbol];
        if (fields) {
            for (const { propertyKey, component, options } of fields) {
                const type = Reflect.getMetadata(
                    "design:type",
                    target.prototype,
                    propertyKey
                );
                storage.collectArchetypeField(
                    archetype_name,
                    propertyKey,
                    component,
                    options,
                    type
                );
            }
        }

        const unions = prototype[archetypeUnionFieldsSymbol];
        if (unions) {
            for (const { propertyKey, components, options } of unions) {
                storage.collectArchetypeUnion(
                    archetype_name,
                    propertyKey,
                    components,
                    options,
                    "union"
                );
            }
        }

        const relations = prototype[archetypeRelationsSymbol];
        if (relations) {
            for (const {
                propertyKey,
                relatedArcheType,
                relationType,
                options,
            } of relations) {
                const type = Reflect.getMetadata(
                    "design:type",
                    target.prototype,
                    propertyKey
                );
                storage.collectArchetypeRelation(
                    archetype_name,
                    propertyKey,
                    relatedArcheType,
                    relationType,
                    options,
                    type
                );
            }
        }

        const functions = prototype[archetypeFunctionsSymbol];
        if (functions) {
            storage.collectArcheTypeMetadata({
                name: archetype_name,
                typeId: typeId,
                target: target,
                functions: functions,
            });
        }

        return target;
    };
}

export function ArcheTypeField<T extends BaseComponent>(
    component: new (...args: any[]) => T,
    options?: ArcheTypeFieldOptions
) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeFieldsSymbol]) {
            target[archetypeFieldsSymbol] = [];
        }
        target[archetypeFieldsSymbol].push({ propertyKey, component, options });
    };
}

export function ArcheTypeUnionField(
    components: (new (...args: any[]) => any)[],
    options?: ArcheTypeFieldOptions
) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeUnionFieldsSymbol]) {
            target[archetypeUnionFieldsSymbol] = [];
        }
        target[archetypeUnionFieldsSymbol].push({
            propertyKey,
            components,
            options,
        });
    };
}

function createRelationDecorator(
    relationType: "hasMany" | "belongsTo" | "hasOne" | "belongsToMany"
) {
    return function (relatedArcheType: string, options?: RelationOptions) {
        return function (target: any, propertyKey: string) {
            if (!target[archetypeRelationsSymbol]) {
                target[archetypeRelationsSymbol] = [];
            }
            target[archetypeRelationsSymbol].push({
                propertyKey,
                relatedArcheType,
                relationType,
                options,
            });
        };
    };
}

export const HasMany = createRelationDecorator("hasMany");
export const BelongsTo = createRelationDecorator("belongsTo");
export const HasOne = createRelationDecorator("hasOne");
export const BelongsToMany = createRelationDecorator("belongsToMany");

// Keep ArcheTypeRelation as alias for backwards compatibility
export const ArcheTypeRelation = HasMany;
