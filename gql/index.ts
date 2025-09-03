import {createSchema, createYoga} from 'graphql-yoga';
import { GraphQLSchema, GraphQLError } from 'graphql';
import { GraphQLType, GraphQLField, GraphQLOperation } from './Generator';
import {GraphQLTypes} from "./types"
export {
    GraphQLType,
    GraphQLField,
    GraphQLOperation,
    GraphQLTypes
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

export function createYogaInstance(schema?: GraphQLSchema) {
    if (schema) {
        return createYoga({
            schema,
            // Configure error handling to preserve error messages for clients
            maskedErrors: {
                // In development, show full error details
                // In production, you might want to mask sensitive information
                maskError: (error: any, message: string): GraphQLError => {
                    if (process.env.NODE_ENV === 'production') {
                        // Mask sensitive error details in production
                        return new GraphQLError('Internal server error', {
                            extensions: {
                                code: 'INTERNAL_SERVER_ERROR',
                            },
                        });
                    }
                    // In development, return the original error
                    return error instanceof GraphQLError ? error : new GraphQLError(message, { originalError: error });
                },
            },
        });
    } else {
        return createYoga({
            schema: createSchema({
                typeDefs: staticTypeDefs,
                resolvers: staticResolvers,
            }),
            maskedErrors: {
                maskError: (error: any, message: string): GraphQLError => {
                    if (process.env.NODE_ENV === 'production') {
                        return new GraphQLError('Internal server error', {
                            extensions: {
                                code: 'INTERNAL_SERVER_ERROR',
                            },
                        });
                    }
                    return error instanceof GraphQLError ? error : new GraphQLError(message, { originalError: error });
                },
            },
        });
    }
}

export const yoga = createYogaInstance();