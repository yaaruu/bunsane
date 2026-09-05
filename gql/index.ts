import {createSchema, createYoga, type Plugin} from 'graphql-yoga';
import { useValidationRule } from '@envelop/core';
import { GraphQLSchema, GraphQLError } from 'graphql';
import { depthLimitRule } from './depthLimit';
import { complexityLimitRule } from './complexityLimit';
import { GraphQLObjectType, GraphQLField, GraphQLOperation, GraphQLScalarType, GraphQLSubscription } from './Generator';
import {GraphQLFieldTypes} from "./types"
import {logger as MainLogger} from "../core/Logger"
import { isVerboseErrors } from "../core/envMode"
import { isFieldRequested } from './helpers';
import * as z from "zod";

const logger = MainLogger.child({scope: "GQL"});

import {
    isValidGraphQLType,
} from "./helpers";
import type {
    GraphQLType,
    TypeFromGraphQL,
    ResolverInput
} from "./helpers";
export {
    GraphQLObjectType,
    GraphQLField,
    GraphQLOperation,
    GraphQLSubscription,
    GraphQLFieldTypes,
    isValidGraphQLType,
    GraphQLScalarType,
    isFieldRequested
}
export { GraphQLSchemaOrchestrator } from "./orchestration";
export { generateGraphQLSchemaV2 } from "./GeneratorV2";
export { maskError };
export { Middleware, composeOperationMiddleware } from "./middleware";
export type { OperationMiddleware } from "./middleware";
export type {
    GraphQLType,
    TypeFromGraphQL,
    ResolverInput
}
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

export interface YogaInstanceOptions {
    cors?: {
        origin?: string | string[] | ((origin: string) => boolean);
        credentials?: boolean;
        allowedHeaders?: string[];
        methods?: string[];
    };
    maxDepth?: number;
    /** Maximum query complexity (default: 1000). 0 disables. */
    maxComplexity?: number;
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
    contextFactory?: (context: any) => any,
    options?: YogaInstanceOptions
) {
    // Prepend depth limit plugin. Enforce a hard minimum so maxDepth: 0 or
    // undefined cannot silently disable the guard (C06). If a deployment
    // explicitly needs a higher bound, raise it — but we never allow it off.
    const HARD_MIN_DEPTH = 15;
    const effectiveDepth = Math.max(options?.maxDepth ?? HARD_MIN_DEPTH, HARD_MIN_DEPTH);
    const allPlugins: Plugin[] = [];
    allPlugins.push(useValidationRule(depthLimitRule(effectiveDepth)) as Plugin);

    // Complexity budget: count per-field cost with `first`/`limit`/`take`
    // multipliers. 0 disables, undefined defaults to 1000.
    const complexityBudget = options?.maxComplexity ?? 1000;
    if (complexityBudget > 0) {
        allPlugins.push(useValidationRule(complexityLimitRule(complexityBudget)) as Plugin);
    }
    allPlugins.push(...plugins);

    const yogaConfig: any = {
        plugins: allPlugins,
        maskedErrors: {
            maskError,
        },
    };

    // Add CORS if provided
    if (options?.cors) {
        yogaConfig.cors = options.cors;
    }

    // Add context factory if provided
    if (contextFactory) {
        yogaConfig.context = contextFactory;
    }

    // Memoized static placeholder schema. Kept stable so Yoga's per-schema
    // internal caches (parse/validate) are not thrashed when a factory falls
    // back to it across requests.
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
        // Factory form: read per request so runtime swaps reflect live.
        // Stable refs keep Yoga's caches warm; only a changed ref re-primes.
        yogaConfig.schema = () => schema() ?? getFallback();
    } else if (schema) {
        yogaConfig.schema = schema;
    } else {
        yogaConfig.schema = getFallback();
    }
    return createYoga(yogaConfig);
}

export const Upload = z.union([z.literal("Upload"), z.any()]);

export const yoga = createYogaInstance();