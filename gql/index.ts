import {createSchema, createYoga, type Plugin, type YogaServerInstance} from 'graphql-yoga';
export type YogaInstance = YogaServerInstance<Record<string, unknown>, Record<string, unknown>>;
import { useValidationRule } from '@envelop/core';
import { GraphQLSchema, GraphQLError, NoSchemaIntrospectionCustomRule } from 'graphql';
import { depthLimitRule } from './depthLimit';
import { useComplexityLimit } from './complexityLimit';
import { GraphQLObjectType, GraphQLField, GraphQLOperation, GraphQLScalarType, GraphQLSubscription } from './Generator';
import {logger as MainLogger} from "../core/Logger"
import { isVerboseErrors } from "../core/envMode"
import { isFieldRequested } from './helpers';
import { t, type InferInput } from "./schema";
import * as z from "zod";

const logger = MainLogger.child({scope: "GQL"});

import {
    isValidGraphQLType,
} from "./helpers";
import type {
    GraphQLType,
} from "./helpers";
export {
    GraphQLObjectType,
    GraphQLField,
    GraphQLOperation,
    GraphQLSubscription,
    isValidGraphQLType,
    GraphQLScalarType,
    isFieldRequested
}
export { GraphQLSchemaOrchestrator } from "./orchestration";
export { generateGraphQLSchemaV2 } from "./GeneratorV2";
export { maskError };
export { Middleware, composeOperationMiddleware } from "./middleware";
export type { OperationMiddleware } from "./middleware";
export type { GraphQLType };
export { t };
export type { InferInput };
interface Entity {
    id: string;
    name: string;
    description: string;
}

const staticTypeDefs = `
    type Query {
        greetings: String
        entities: [Entity]
        entity(id: ID!): Entity
    }

    type Entity {
        id: ID!
        name: String!
        description: String
    }
`;

const staticResolvers = {
    Query: {
        greetings: (): string => "Hello, world!",
        entities: (): Entity[] => {
            // Fetch entities from the database or any other source
            return [
                {
                    id: "1",
                    name: "Entity 1",
                    description: "Description for Entity 1"
                }
            ];
        },
        entity: (_parent: any, args: { id: string }): Entity | null => {
            const { id } = args;
            // Fetch a single entity by ID from the database or any other source
            return null;
        }
    }
};

const maskError = (error: any, message: string): GraphQLError => {
    // SEC-08: a thrown non-Error (string, plain object) has no message —
    // guard before touching it so the masker itself can never crash.
    const rawMessage = typeof error?.message === 'string' ? error.message : String(message ?? 'Error');

    // Handle authentication errors
    if (rawMessage === 'Unauthenticated' || error.extensions?.http?.status === 401 || error.extensions?.code === 'UNAUTHENTICATED') {
        return new GraphQLError('Unauthorized', {
            extensions: {
                code: 'UNAUTHORIZED',
                http: { status: 401 }
            }
        });
    }
    
    // Handle JWT authentication errors specifically
    if (error.extensions?.code === 'DOWNSTREAM_SERVICE_ERROR' && error.extensions?.http?.status === 401) {
        return new GraphQLError('Unauthorized', {
            extensions: {
                code: 'UNAUTHORIZED',
                http: { status: 401 }
            }
        });
    }

    // Handle GraphQL validation errors for missing required fields
    if (rawMessage.includes('was not provided')) {
        const match = rawMessage.match(/Field "([^"]+)" of required type "([^"]+)" was not provided/);
        if (match) {
            const fieldName = match[1];
            return new GraphQLError(`Missing required field: ${fieldName}`, {
                extensions: {
                    code: 'VALIDATION_ERROR',
                    field: fieldName,
                    // SEC-08: the raw validation message can carry type names;
                    // include it only when verbosity is explicitly on.
                    originalMessage: isVerboseErrors() ? rawMessage : undefined
                }
            });
        }
    }

    // Pass through known application-level GraphQL error codes
    const isGQLError = (e: any): e is { message: string; extensions?: Record<string, unknown> } =>
        e instanceof GraphQLError ||
        (e !== null && typeof e === 'object' && 'extensions' in e && typeof e.message === 'string');
    const knownCodes = ['FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT', 'BAD_REQUEST'];
    if (isGQLError(error) && knownCodes.includes(error.extensions?.code as string)) {
        return error instanceof GraphQLError ? error : new GraphQLError(error.message, { extensions: error.extensions });
    }

    logger.error("GraphQL Error:", error);

    if (!isVerboseErrors()) {
        // SEC-08: fail closed. Only the exact value 'development' gets the
        // original error; unset, 'staging', 'test-server', typos — everything
        // else masks.
        return new GraphQLError('Internal server error', {
            extensions: {
                code: 'INTERNAL_SERVER_ERROR',
            },
        });
    }
    return isGQLError(error) ? (error instanceof GraphQLError ? error : new GraphQLError(error.message, { extensions: error.extensions })) : new GraphQLError(message, { originalError: error });
};

export const DEFAULT_MAX_DEPTH = 15;
export const DEFAULT_MAX_COMPLEXITY = 1000;

export interface YogaCorsOptions {
    origin?: string | string[];
    credentials?: boolean;
    allowedHeaders?: string[];
    methods?: string[];
}

export interface YogaInstanceOptions {
    /** `false` disables Yoga's CORS plugin. Omit to leave Yoga's default. */
    cors?: false | YogaCorsOptions;
    maxDepth?: number;
    /** Maximum query complexity. Must be an integer >= 1. Omit for 1000. */
    maxComplexity?: number;
    /** Override introspection. Omit to follow GRAPHQL_INTROSPECTION then isVerboseErrors(). */
    introspection?: boolean;
    /** Override GraphiQL. Omit to follow GRAPHQL_GRAPHIQL then isVerboseErrors(). */
    graphiql?: boolean;
}

function assertPositiveInt(name: string, value: number): number {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(
            `${name} ${String(value)} is invalid. Pass an integer >= 1. The limit cannot be disabled.`,
        );
    }
    return value;
}

function parseOnOff(name: string, raw: string | undefined): boolean | undefined {
    if (raw === undefined || raw === "") return undefined;
    const value = raw.trim().toLowerCase();
    if (value === "on" || value === "true" || value === "1") return true;
    if (value === "off" || value === "false" || value === "0") return false;
    throw new Error(`${name}=${raw} is invalid. Use on or off.`);
}

function resolveReconFlag(explicit: boolean | undefined, envName: string): boolean {
    if (typeof explicit === "boolean") return explicit;
    const fromEnv = parseOnOff(envName, process.env[envName]);
    if (fromEnv !== undefined) return fromEnv;
    return isVerboseErrors();
}

/**
 * A schema provider may be a concrete `GraphQLSchema` or a factory returning
 * the current schema. A factory is read per-request by Yoga, which lets the
 * schema be swapped at runtime (e.g. ServiceRegistry.rebuildSchema()) without
 * recreating the Yoga instance. Returning `null`/`undefined` falls back to the
 * static placeholder schema.
 */
export type SchemaProvider =
    | GraphQLSchema
    | (() => GraphQLSchema | null | undefined);

export function createYogaInstance(
    schema?: SchemaProvider,
    plugins: Plugin[] = [],
    contextFactory?: (context: unknown) => unknown,
    options?: YogaInstanceOptions
): YogaInstance {
    const effectiveDepth = assertPositiveInt(
        "GraphQL maxDepth",
        options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    );
    const complexityBudget = assertPositiveInt(
        "GraphQL maxComplexity",
        options?.maxComplexity ?? DEFAULT_MAX_COMPLEXITY,
    );
    const introspection = resolveReconFlag(options?.introspection, "GRAPHQL_INTROSPECTION");
    const graphiql = resolveReconFlag(options?.graphiql, "GRAPHQL_GRAPHIQL");

    const allPlugins: Plugin[] = [];
    allPlugins.push(useValidationRule(depthLimitRule(effectiveDepth)) as Plugin);
    allPlugins.push(useComplexityLimit(complexityBudget));
    if (!introspection) {
        allPlugins.push(useValidationRule(NoSchemaIntrospectionCustomRule) as Plugin);
    }
    if (!graphiql) {
        allPlugins.push({
            onRequest({ request, endResponse, fetchAPI }) {
                const accept = request.headers.get("accept") ?? "";
                if (request.method === "GET" && accept.includes("text/html")) {
                    endResponse(new fetchAPI.Response(null, { status: 404, statusText: "Not Found" }));
                }
            },
        });
    }
    allPlugins.push(...plugins);

    const yogaConfig: {
        plugins: Plugin[];
        maskedErrors: { maskError: typeof maskError };
        cors?: false | YogaCorsOptions;
        context?: (context: unknown) => unknown;
        graphiql?: boolean;
        landingPage?: false;
        schema?: GraphQLSchema | (() => GraphQLSchema);
    } = {
        plugins: allPlugins,
        maskedErrors: { maskError },
        graphiql,
        landingPage: false,
    };

    if (options?.cors === false) {
        yogaConfig.cors = false;
    } else if (options?.cors) {
        yogaConfig.cors = options.cors;
    }

    if (contextFactory) {
        yogaConfig.context = contextFactory;
    }

    let fallbackSchema: GraphQLSchema | undefined;
    const getFallback = (): GraphQLSchema => {
        if (!fallbackSchema) {
            fallbackSchema = createSchema({
                typeDefs: staticTypeDefs,
                resolvers: staticResolvers,
            });
        }
        return fallbackSchema;
    };

    if (typeof schema === "function") {
        yogaConfig.schema = () => schema() ?? getFallback();
    } else if (schema) {
        yogaConfig.schema = schema;
    } else {
        yogaConfig.schema = getFallback();
    }
    return createYoga(yogaConfig);
}

export const Upload = z.union([z.literal("Upload"), z.any()]);