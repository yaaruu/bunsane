import {createSchema, createYoga, type Plugin} from 'graphql-yoga';
import { GraphQLSchema, GraphQLError } from 'graphql';
import { GraphQLObjectType, GraphQLField, GraphQLOperation, GraphQLScalarType, GraphQLSubscription } from './Generator';
import {GraphQLFieldTypes} from "./types"
import {logger as MainLogger} from "core/Logger"
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
    // Handle authentication errors
    if (error.message === 'Unauthenticated' || error.extensions?.http?.status === 401 || error.extensions?.code === 'UNAUTHENTICATED') {
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
    if (error.message.includes('was not provided')) {
        const match = error.message.match(/Field "([^"]+)" of required type "([^"]+)" was not provided/);
        if (match) {
            const fieldName = match[1];
            return new GraphQLError(`Missing required field: ${fieldName}`, {
                extensions: {
                    code: 'VALIDATION_ERROR',
                    field: fieldName,
                    originalMessage: error.message
                }
            });
        }
    }
    
    if (process.env.NODE_ENV === 'production') {
        logger.error("GraphQL Error:", error);
        // Mask sensitive error details in production
        return new GraphQLError('Internal server error', {
            extensions: {
                code: 'INTERNAL_SERVER_ERROR',
            },
        });
    }
    // In development, return the original error
    return error instanceof GraphQLError ? error : new GraphQLError(message, { originalError: error });
};

export interface YogaInstanceOptions {
    cors?: {
        origin?: string | string[] | ((origin: string) => boolean);
        credentials?: boolean;
        allowedHeaders?: string[];
        methods?: string[];
    };
}

export function createYogaInstance(
    schema?: GraphQLSchema,
    plugins: Plugin[] = [],
    contextFactory?: (context: any) => any,
    options?: YogaInstanceOptions
) {
    const yogaConfig: any = {
        plugins,
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

    if (schema) {
        yogaConfig.schema = schema;
        return createYoga(yogaConfig);
    } else {
        yogaConfig.schema = createSchema({
            typeDefs: staticTypeDefs,
            resolvers: staticResolvers,
        });
        return createYoga(yogaConfig);
    }
}

export const Upload = z.union([z.literal("Upload"), z.any()]);

export const yoga = createYogaInstance();