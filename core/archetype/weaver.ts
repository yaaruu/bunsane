import { ZodObject, type ZodType } from "zod";
import { weave } from "@gqloom/core";
import { ZodWeaver } from "@gqloom/zod";
import { printSchema } from "graphql";
import { getMetadataStorage } from "../metadata";
import { logger } from "../Logger";
import { GraphQLDate, isZodDateSchema } from "./graphqlDate";
import { archetypeFieldResolver } from "./sdlEmit";
import { archetypeGraphqlName } from "./relationTarget";
import type { ArchetypeFunctionOptions } from "./functionReturn";
import type { RelationTarget } from "./relationTarget";

export const archetypeSchemaCache = new Map<
    string,
    { zodSchema: ZodObject<Record<string, ZodType>>; graphqlSchema: string }
>();
export const allArchetypeZodObjects = new Map<string, ZodObject<Record<string, ZodType>>>();

let weaveGeneration = 0;
let weaveMemo: { stamp: string; sdl: string | null } | null = null;

/** Drop the woven SDL memo. Called when an archetype is registered. */
export function invalidateArchetypeWeaveCache(): void {
    weaveGeneration++;
    weaveMemo = null;
}

export function getArchetypeSchema(archetypeName: string, excludeRelations = false, excludeFunctions = false) {
    const cacheKey = `${archetypeName}_${excludeRelations}_${excludeFunctions}`;
    return archetypeSchemaCache.get(cacheKey);
}

export function getAllArchetypeSchemas() {
    return Array.from(archetypeSchemaCache.entries())
        .filter(([key]) => key.endsWith("_false_false"))
        .map(([, value]) => value);
}

function registryStamp(): string {
    const storage = getMetadataStorage();
    const arch = storage.archetypes.map((a) => {
        const fns = (a.functions ?? [])
            .map((f) => `${f.propertyKey}:${f.options?.returnType ?? ""}:${f.options?.args?.length ?? 0}`)
            .join(",");
        return `${a.typeId}:${a.name}:${fns}`;
    }).join("|");
    const zod = [...allArchetypeZodObjects.keys()].sort().join(",");
    return `${weaveGeneration}|${arch}|${zod}`;
}

interface WeaveArchetype {
    constructor: { name: string; prototype: object };
    relationMap: Record<string, RelationTarget>;
    relationTypes: Record<string, string>;
    relationOptions: Record<string, { nullable?: boolean } | undefined>;
    functions: Array<{ propertyKey: string; options?: ArchetypeFunctionOptions }>;
    getZodObjectSchema: () => ZodObject<Record<string, ZodType>>;
}

function loadArchetype(target: unknown): WeaveArchetype {
    if (typeof target !== "function") {
        throw new Error("Archetype metadata target is not a constructor");
    }
    const Ctor = target as new () => WeaveArchetype;
    return new Ctor();
}

function ensureZodSchemas(): WeaveArchetype[] {
    const storage = getMetadataStorage();
    const instances: WeaveArchetype[] = [];
    for (const archetypeMetadata of storage.archetypes) {
        const instance = loadArchetype(archetypeMetadata.target);
        instances.push(instance);
        const fullSchemaCacheKey = `${archetypeMetadata.name}_false_false`;
        if (!archetypeSchemaCache.has(fullSchemaCacheKey)) {
            instance.getZodObjectSchema();
        }
    }
    return instances;
}

const zodWeaverConfig = ZodWeaver.config({
    presetGraphQLType(schema) {
        if (isZodDateSchema(schema)) return GraphQLDate;
        return undefined;
    },
});

function parentZod(instance: WeaveArchetype): ZodObject<Record<string, ZodType>> | undefined {
    return allArchetypeZodObjects.get(archetypeGraphqlName(instance));
}

function weaveInputs(instances: WeaveArchetype[], includeAllZod: boolean): unknown[] {
    const inputs: unknown[] = [zodWeaverConfig];
    if (includeAllZod) {
        inputs.push(...allArchetypeZodObjects.values());
    }
    for (const instance of instances) {
        const parent = parentZod(instance);
        if (!parent) continue;
        if (!includeAllZod) inputs.push(parent);
        const extra = archetypeFieldResolver(instance, parent, allArchetypeZodObjects);
        if (extra) inputs.push(extra);
    }
    return inputs;
}
function printWoven(instances: WeaveArchetype[], includeAllZod: boolean): string {
    const inputs = weaveInputs(instances, includeAllZod);
    return printSchema(weave(ZodWeaver, ...(inputs as Parameters<typeof weave>)));
}

/**
 * Weave every registered archetype into one SDL string.
 * Relation and computed fields are real GraphQL types (GQLoom field + silk),
 * not describe-then-regex replacements. Memoized until the archetype registry
 * or canonical Zod objects change.
 */
export function weaveAllArchetypes(): string | null {
    const instances = ensureZodSchemas();
    if (allArchetypeZodObjects.size === 0) {
        return null;
    }
    const stamp = registryStamp();
    if (weaveMemo && weaveMemo.stamp === stamp) {
        return weaveMemo.sdl;
    }

    try {
        const sdl = printWoven(instances, true);
        weaveMemo = { stamp: registryStamp(), sdl };
        return sdl;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // graphql-js rejects two same-named types. Per-archetype weaves stay
        // valid; SchemaGeneratorVisitor dedupes the concatenated SDL.
        if (/multiple types named|uniquely named types/i.test(msg)) {
            logger.debug(
                { scope: "weaver" },
                `Duplicate GraphQL type during archetype weave — emitting per archetype: ${msg}`
            );
            const sdl = instances.map((instance) => printWoven([instance], false)).join("\n");
            weaveMemo = { stamp: registryStamp(), sdl };
            return sdl;
        }
        logger.warn({ scope: "weaver", error }, "Failed to weave all archetypes");
        throw error;
    }
}
