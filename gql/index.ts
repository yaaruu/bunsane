import {createSchema, createYoga, type Plugin} from 'graphql-yoga';
import { GraphQLSchema, GraphQLError } from 'graphql';
import { GraphQLObjectType, GraphQLField, GraphQLOperation, GraphQLScalarType } from './Generator';
import {GraphQLFieldTypes} from "./types"
import {logger as MainLogger} from "core/Logger"
import { isFieldRequested } from './helpers';

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
    GraphQLFieldTypes,
    isValidGraphQLType,
    GraphQLScalarType,
    isFieldRequested
}
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
    console.log("MASKED ERROR:", message);
    console.log(JSON.stringify(error.extensions));
    // Handle JWT authentication errors specifically
    if (error.extensions?.code === 'DOWNSTREAM_SERVICE_ERROR' && error.extensions?.http?.status === 401) {
        return new GraphQLError('Error: Unauthorized', {
            extensions: {
                code: 'UNAUTHORIZED',
                http: { status: 401 }
            }
        });
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

export function createYogaInstance(schema?: GraphQLSchema, plugins: Plugin[] = []) {
    if (schema) {
        return createYoga({
            schema,
            plugins,
            maskedErrors: {
                maskError,
            },
        });
    } else {
        return createYoga({
            schema: createSchema({
                typeDefs: staticTypeDefs,
                resolvers: staticResolvers,
            }),
            plugins,
            maskedErrors: {
                maskError,
            },
        });
    }
}

export const yoga = createYogaInstance();