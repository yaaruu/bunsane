import { field, resolver, silk } from "@gqloom/core";
import { ZodWeaver } from "@gqloom/zod";
import {
    GraphQLList,
    GraphQLNonNull,
    isNonNullType,
    type GraphQLOutputType,
} from "graphql";
import { z, type ZodType } from "zod";
import {
    customTypeNameRegistry,
    customTypeRegistry,
    inputTypeRegistry,
    registeredCustomTypes,
} from "./customTypes";
import { functionOutputZod, type ArchetypeFunctionOptions } from "./functionReturn";
import { archetypeGraphqlName, resolveRelationTarget, type RelationTarget } from "./relationTarget";

interface RelationOptionsShape {
    nullable?: boolean;
    foreignKey?: string;
}

interface ArchetypeForEmit {
    constructor: { name: string; prototype: object };
    relationMap: Record<string, RelationTarget>;
    relationTypes: Record<string, string>;
    relationOptions: Record<string, RelationOptionsShape | undefined>;
    functions: Array<{ propertyKey: string; options?: ArchetypeFunctionOptions }>;
}

const noopResolve = () => null;

function unwrapOutput(type: GraphQLOutputType): GraphQLOutputType {
    return isNonNullType(type) ? type.ofType : type;
}

function registryZod(value: unknown): ZodType | undefined {
    if (value && typeof value === "object" && "safeParse" in value) {
        return value as ZodType;
    }
    return undefined;
}

function outputForRelation(
    relatedZod: ZodType,
    relationType: string,
    nullable: boolean | undefined
): GraphQLOutputType {
    const base = unwrapOutput(ZodWeaver.getGraphQLType(relatedZod));
    const isArray = relationType === "hasMany" || relationType === "belongsToMany";
    if (isArray) {
        const list = new GraphQLList(new GraphQLNonNull(base));
        // hasMany defaults to a nullable list; nullable: false makes the list required.
        return nullable === false ? new GraphQLNonNull(list) : list;
    }
    // hasOne child may be absent. Non-null only when the author sets nullable: false.
    // belongsTo stays non-null unless nullable is set (HEAD).
    if (relationType === "hasOne") {
        return nullable === false ? new GraphQLNonNull(base) : base;
    }
    return nullable ? base : new GraphQLNonNull(base);
}

function argZod(
    archetypeName: string,
    propertyKey: string,
    arg: { name: string; type: unknown; nullable?: boolean }
): ZodType {
    let schema: ZodType | undefined;
    if (arg.type === String) schema = z.string();
    else if (arg.type === Number) schema = z.number();
    else if (arg.type === Boolean) schema = z.boolean();
    else if (arg.type === Date) schema = z.date();
    else schema = registryZod(customTypeRegistry.get(arg.type));

    if (!schema && typeof arg.type === "function") {
        schema = registryZod(registeredCustomTypes.get(arg.type.name));
    }
    if (!schema) {
        const typeName = customTypeNameRegistry.get(arg.type);
        if (typeName) schema = registryZod(registeredCustomTypes.get(typeName));
    }
    if (!schema && inputTypeRegistry.has(arg.type)) {
        const inputName = inputTypeRegistry.get(arg.type);
        if (inputName) schema = registryZod(registeredCustomTypes.get(inputName));
    }
    if (!schema) {
        const label = typeof arg.type === "function" ? arg.type.name : String(arg.type);
        throw new Error(
            `@ArcheTypeFunction ${archetypeName}.${propertyKey} argument "${arg.name}" has unknown type ${label}. ` +
            `Use String, Number, Boolean, Date, or a registered custom type.`
        );
    }
    return arg.nullable ? schema.nullish() : schema;
}

function functionOutputType(
    archetypeName: string,
    propertyKey: string,
    options: ArchetypeFunctionOptions | undefined,
    designReturn: unknown,
    zodByName: ReadonlyMap<string, ZodType>
) {
    const named = options?.returnType;
    if (named && named !== "string" && named !== "number" && named !== "boolean" && named !== "date" && named !== "Date") {
        const related = zodByName.get(named);
        if (related) {
            return silk(() => unwrapOutput(ZodWeaver.getGraphQLType(related)));
        }
        const custom = registryZod(registeredCustomTypes.get(named));
        if (custom) {
            return silk(() => unwrapOutput(ZodWeaver.getGraphQLType(custom)));
        }
        throw new Error(
            `@ArcheTypeFunction ${archetypeName}.${propertyKey} returnType "${named}" is not a registered archetype or custom type.`
        );
    }
    return functionOutputZod(archetypeName, propertyKey, options, designReturn);
}

/**
 * GQLoom resolver that adds relation and @ArcheTypeFunction fields as real
 * GraphQL types. Placeholders in the Zod object are hidden; this is the only
 * emission path (no SDL regex).
 */
export function archetypeFieldResolver(
    archetype: ArchetypeForEmit,
    parentZod: ZodType,
    zodByName: ReadonlyMap<string, ZodType>
) {
    const archetypeName = archetypeGraphqlName(archetype);
    const fields: Record<string, object> = {};

    for (const [fieldName, target] of Object.entries(archetype.relationMap)) {
        const resolved = resolveRelationTarget(target);
        const relatedZod = zodByName.get(resolved.name);
        if (!relatedZod) {
            throw new Error(
                `Relation ${archetypeName}.${fieldName} targets "${resolved.name}", which has no GraphQL schema. ` +
                `Decorate it with @ArcheType before schema build.`
            );
        }
        const relationType = archetype.relationTypes[fieldName] ?? "";
        const nullable = archetype.relationOptions[fieldName]?.nullable;
        const output = silk(() => outputForRelation(relatedZod, relationType, nullable));
        fields[fieldName] = field(output)
            .description(`Reference to ${resolved.name} type`)
            .resolve(noopResolve);
    }

    const prototype = archetype.constructor.prototype;
    for (const { propertyKey, options } of archetype.functions) {
        const designReturn: unknown = Reflect.getMetadata("design:returntype", prototype, propertyKey);
        const output = functionOutputType(archetypeName, propertyKey, options, designReturn, zodByName);
        if (options?.args && options.args.length > 0) {
            const input: Record<string, ZodType> = {};
            for (const arg of options.args) {
                input[arg.name] = argZod(archetypeName, propertyKey, arg);
            }
            fields[propertyKey] = field(output).input(input).resolve(noopResolve);
        } else {
            fields[propertyKey] = field(output).resolve(noopResolve);
        }
    }

    if (Object.keys(fields).length === 0) return null;
    return resolver.of(parentZod, fields as unknown as Parameters<typeof resolver.of>[1]);
}
