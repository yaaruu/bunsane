import type { GraphQLType } from "./helpers";
import type { InferInput, SchemaType } from "./schema";
import BaseArcheType from "../core/ArcheType";
import type { BaseService } from "../service";

export interface GraphQLObjectTypeMeta {
    name: string;
    fields: Record<string, GraphQLType>;
}

export interface GraphQLOperationMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
    type: "Query" | "Mutation";
    propertyKey?: string;
    name?: string;
    input?: Record<string, SchemaType> | Record<string, GraphQLType> | object;
    output: GraphQLType | Record<string, GraphQLType> | BaseArcheType | BaseArcheType[] | (abstract new (...args: never[]) => BaseArcheType) | object | T;
}

export interface GraphQLSubscriptionMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
    propertyKey?: string;
    name?: string;
    input?: Record<string, SchemaType> | Record<string, GraphQLType> | object;
    output: GraphQLType | Record<string, GraphQLType> | T;
}

export interface GraphQLFieldMeta {
    type: GraphQLType;
    field: string;
}

type ArchetypeCtor<T extends BaseArcheType = BaseArcheType> = abstract new (...args: never[]) => T;

/** Output value a resolver should return for a decorator `output`. */
export type InferOperationOutput<O> =
    [O] extends [readonly (infer E)[]]
        ? InferOperationOutput<E>[]
        : [O] extends [ArchetypeCtor<infer T>]
            ? T
            : [O] extends [BaseArcheType]
                ? O
                : unknown;

type AllSchemaFields<T> = T extends object
    ? { [K in keyof T]: T[K] extends SchemaType ? true : false }[keyof T] extends false
        ? false
        : true
    : false;

/** `t.*` inputs infer; string-map / Zod / absent inputs stay loose so legacy methods compile. */
export type InferOperationInput<I> =
    AllSchemaFields<I> extends true
        ? InferInput<{ [K in keyof I]: I[K] extends SchemaType ? I[K] : never }>
        : unknown;

/**
 * Parameter positions are bivariant so a method may name its own context type.
 * The return type is still checked against `InferOperationOutput`.
 */
type OperationHandler<In, Out> = {
    bivarianceHack(input: In, ctx?: unknown, info?: unknown): Promise<Out> | Out;
}["bivarianceHack"];

type MethodSlot<T> = {
    value?: T;
    writable?: boolean;
    configurable?: boolean;
    enumerable?: boolean;
};

function isPlainObject(value: unknown): value is object {
    return value != null && typeof value === "object";
}

function storedOutput(output: unknown): GraphQLOperationMeta["output"] {
    if (typeof output === "string") return output;
    if (output instanceof BaseArcheType) return output;
    if (typeof output === "function" && output.prototype instanceof BaseArcheType) {
        return output as abstract new (...args: never[]) => BaseArcheType;
    }
    if (Array.isArray(output) && output.every((item) => item instanceof BaseArcheType || (typeof item === "function" && item.prototype instanceof BaseArcheType))) {
        return output as BaseArcheType[];
    }
    if (isPlainObject(output) && !Array.isArray(output)) return output;
    return "String";
}

function registerOperation(
    target: BaseService,
    propertyKey: string,
    meta: { name?: string; input?: unknown; output: unknown; type?: "Query" | "Mutation" },
    bucket: "__graphqlOperations" | "__graphqlSubscriptions",
    label: string,
): void {
    const operationName = meta.name ?? propertyKey;
    if (!operationName) {
        throw new Error(`${label}: Operation name is required (either meta.name or propertyKey must be defined)`);
    }
    const input = isPlainObject(meta.input) ? meta.input : undefined;
    const output = storedOutput(meta.output);
    if (bucket === "__graphqlOperations") {
        if (!target.__graphqlOperations) target.__graphqlOperations = [];
        target.__graphqlOperations.push({
            type: meta.type === "Mutation" ? "Mutation" : "Query",
            name: operationName,
            propertyKey,
            input,
            output,
        });
        return;
    }
    if (!target.__graphqlSubscriptions) target.__graphqlSubscriptions = [];
    target.__graphqlSubscriptions.push({
        name: operationName,
        propertyKey,
        input,
        output,
    });
}

export function GraphQLObjectType(meta: GraphQLObjectTypeMeta) {
    return (target: BaseService) => {
        if (!target.__graphqlObjectType) target.__graphqlObjectType = [];
        target.__graphqlObjectType.push(meta);
    };
}

type ScalarHost = { __graphqlScalarTypes?: string[] };

export function GraphQLScalarType(name: string) {
    return (target: ScalarHost) => {
        if (!target.__graphqlScalarTypes) target.__graphqlScalarTypes = [];
        target.__graphqlScalarTypes.push(name);
    };
}

export function GraphQLOperation<I, O>(meta: {
    type: "Query" | "Mutation";
    name?: string;
    input?: I;
    output: O;
}) {
    return function (
        target: BaseService,
        propertyKey: string,
        _descriptor: MethodSlot<OperationHandler<InferOperationInput<I>, InferOperationOutput<O>>>,
    ) {
        registerOperation(target, propertyKey, meta, "__graphqlOperations", "GraphQLOperation");
    };
}

type FieldHost = { __graphqlFields?: Array<GraphQLFieldMeta & { propertyKey: string }> };

/**
 * Field-resolver metadata. Archetype `registerFieldResolvers` (another slice)
 * still writes the same `__graphqlFields` list; keep this decorator until that
 * writer moves.
 */
export function GraphQLField(meta: GraphQLFieldMeta) {
    return function (target: FieldHost, propertyKey: string, _descriptor: PropertyDescriptor) {
        if (!target.__graphqlFields) target.__graphqlFields = [];
        target.__graphqlFields.push({ ...meta, propertyKey });
    };
}

export function GraphQLSubscription<I, O>(meta: {
    name?: string;
    input?: I;
    output: O;
}) {
    return function (
        target: BaseService,
        propertyKey: string,
        _descriptor: MethodSlot<OperationHandler<InferOperationInput<I>, InferOperationOutput<O>>>,
    ) {
        registerOperation(target, propertyKey, meta, "__graphqlSubscriptions", "GraphQLSubscription");
    };
}
