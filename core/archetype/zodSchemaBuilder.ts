import { z, ZodObject, type ZodType } from "zod";
import { SYMBOLS } from "@gqloom/core";
import { asField, asUnionType } from "@gqloom/zod";
import { GraphQLID } from "graphql";
import "reflect-metadata";
import type { ComponentConstructor } from "../components/ComponentRegistry";
import { getMetadataStorage } from "../metadata";
import { compNameToFieldName, shouldUnwrapComponent } from "./helpers";
import { getOrCreateComponentSchema } from "./schemaBuilder";
import { archetypeSchemaCache, allArchetypeZodObjects } from "./weaver";
import { functionOutputZod } from "./functionReturn";
import { archetypeGraphqlName, resolveRelationTarget, type RelationTarget } from "./relationTarget";

interface ArchetypeForZod {
    constructor: { name: string; prototype: object };
    componentMap: Record<string, ComponentConstructor>;
    fieldTypes: Record<string, unknown>;
    fieldOptions: Record<string, { nullable?: boolean } | undefined>;
    unionMap: Record<string, ComponentConstructor[]>;
    unionOptions: Record<string, { nullable?: boolean } | undefined>;
    relationMap: Record<string, RelationTarget>;
    functions: Array<{ propertyKey: string; options?: { returnType?: string; args?: Array<{ name: string; type: unknown; nullable?: boolean }> } }>;
}

const hiddenField = () => z.any().nullish().register(asField, { type: SYMBOLS.FIELD_HIDDEN });

/**
 * Build the Zod object schema for an archetype and register it in caches.
 * GraphQL relation/function fields are not string placeholders — they are
 * hidden here and emitted as real types by weaveAllArchetypes.
 */
export function buildZodObjectSchema(
    archetype: ArchetypeForZod,
    options?: { excludeRelations?: boolean; excludeFunctions?: boolean }
): ZodObject<Record<string, ZodType>> {
    const excludeRelations = options?.excludeRelations ?? false;
    const excludeFunctions = options?.excludeFunctions ?? false;
    const nameFromStorage = archetypeGraphqlName(archetype);
    const cacheKey = `${nameFromStorage}_${excludeRelations}_${excludeFunctions}`;
    const cached = archetypeSchemaCache.get(cacheKey);
    if (cached) return cached.zodSchema;

    const zodShapes: Record<string, ZodType> = {};
    const storage = getMetadataStorage();

    for (const [field, ctor] of Object.entries(archetype.componentMap)) {
        if (field.startsWith("union_")) {
            continue;
        }

        const type = archetype.fieldTypes[field];
        const typeId = storage.getComponentId(ctor.name);
        const componentProps = storage.getComponentProperties(typeId);

        if (shouldUnwrapComponent(componentProps, type)) {
            if (type === String) {
                zodShapes[field] = z.string();
            } else if (type === Number) {
                zodShapes[field] = z.number();
            } else if (type === Boolean) {
                zodShapes[field] = z.boolean();
            } else if (type === Date) {
                zodShapes[field] = z.date();
            }
        } else {
            const componentSchema = getOrCreateComponentSchema(
                ctor,
                typeId,
                archetype.fieldOptions[field]
            );
            if (componentSchema) {
                zodShapes[field] = componentSchema;
            } else {
                continue;
            }
        }

        const built = zodShapes[field];
        if (
            archetype.fieldOptions[field]?.nullable &&
            built &&
            !(built instanceof ZodObject)
        ) {
            zodShapes[field] = built.nullish();
        }
    }

    for (const [fieldName, components] of Object.entries(archetype.unionMap)) {
        const unionComponentSchemas: ZodType[] = [];
        const unionComponentCtors: Array<{ name: string }> = [];

        for (const component of components) {
            const typeId = storage.getComponentId(component.name);
            const componentSchema = getOrCreateComponentSchema(
                component,
                typeId,
                archetype.unionOptions[fieldName]
            );
            if (componentSchema) {
                unionComponentSchemas.push(componentSchema);
                unionComponentCtors.push(component);
            }
        }

        if (unionComponentSchemas.length > 0) {
            const unionSchema = z.union(unionComponentSchemas as [ZodType, ZodType, ...ZodType[]]).register(asUnionType, {
                name: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
                resolveType: (it: { __typename?: string }) => {
                    if (it.__typename) return it.__typename;
                    for (const component of unionComponentCtors) {
                        const componentProps = storage.getComponentProperties(
                            storage.getComponentId(component.name)
                        );
                        const hasUniqueProps = componentProps.some((prop) =>
                            Object.prototype.hasOwnProperty.call(it, prop.propertyKey)
                        );
                        if (hasUniqueProps) return compNameToFieldName(component.name);
                    }
                    return compNameToFieldName(unionComponentCtors[0]!.name);
                },
            });

            zodShapes[fieldName] = archetype.unionOptions[fieldName]?.nullable
                ? unionSchema.nullish()
                : unionSchema;
        }
    }

    if (!excludeRelations) {
        for (const [field, related] of Object.entries(archetype.relationMap)) {
            // Fail schema build here, not later via a missed regex.
            resolveRelationTarget(related);
            zodShapes[field] = hiddenField();
        }
    }

    if (!excludeFunctions) {
        for (const { propertyKey, options } of archetype.functions) {
            const designReturn: unknown = Reflect.getMetadata(
                "design:returntype",
                archetype.constructor.prototype,
                propertyKey
            );
            functionOutputZod(nameFromStorage, propertyKey, options, designReturn);
            zodShapes[propertyKey] = hiddenField();
        }
    }

    const shape: Record<string, ZodType> = {
        __typename: z.literal(nameFromStorage).nullish(),
        // Entity id only — not a global `id: String` rewrite, and not inputs.
        id: z.string().register(asField, { type: GraphQLID }).nullish(),
    };
    for (const [field, zodType] of Object.entries(zodShapes)) {
        const isNullable =
            archetype.fieldOptions[field]?.nullable ||
            archetype.unionOptions[field]?.nullable;
        shape[field] = isNullable ? zodType.optional() : zodType;
    }
    const r = z.object(shape);

    // graphqlSchema is no longer printed per archetype. The combined weave is
    // the SDL source; this string is only the fallback slot.
    archetypeSchemaCache.set(cacheKey, {
        zodSchema: r,
        graphqlSchema: "",
    });

    if (!excludeRelations && !excludeFunctions) {
        allArchetypeZodObjects.set(nameFromStorage, r);
    }

    return r;
}
