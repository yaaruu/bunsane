import { GraphQLSchema, GraphQLError } from "graphql";
import {makeExecutableSchema} from "@graphql-tools/schema";
import { logger as MainLogger } from "core/Logger";
import type { GraphQLType } from "./helpers";
const logger = MainLogger.child({ scope: "GraphQLGenerator" });
export interface GraphQLObjectTypeMeta {
    name: string;
    fields: Record<string, GraphQLType>;
}

export interface GraphQLOperationMeta {
    type: "Query" | "Mutation";
    name?: string;
    input?: Record<string, GraphQLType>;
    output: GraphQLType | Record<string, GraphQLType>;
}

export interface GraphQLFieldMeta {
    type: GraphQLType;
    field: string;
}

export function GraphQLObjectType(meta: GraphQLObjectTypeMeta) {
    return (target: any) => {
        if (!target.__graphqlObjectType) target.__graphqlObjectType = [];
        target.__graphqlObjectType.push(meta);
    }
}

export function GraphQLOperation(meta: GraphQLOperationMeta) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlOperations) target.__graphqlOperations = [];
        const operationName = meta.name ?? propertyKey;
        if (!operationName) {
            throw new Error("GraphQLOperation: Operation name is required (either meta.name or propertyKey must be defined)");
        }
        const operationMeta = { ...meta, name: operationName, propertyKey };
        target.__graphqlOperations.push(operationMeta);
    };
}

export function GraphQLField(meta: GraphQLFieldMeta) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlFields) target.__graphqlFields = [];
        target.__graphqlFields.push({ ...meta, propertyKey });
    };
}

export function generateGraphQLSchema(services: any[]): { schema: GraphQLSchema | null; resolvers: any } {
    let typeDefs = "";
    const resolvers: any = { Query: {}, Mutation: {} };
    const queryFields: string[] = [];
    const mutationFields: string[] = [];

    services.forEach(service => {
        logger.trace(`Processing service: ${service.constructor.name}`);
        if (service.constructor.__graphqlObjectType) {
            for (const meta of service.constructor.__graphqlObjectType) {
                const { name, fields } = meta;
                typeDefs += `type ${name} {\n${Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
            }
        }
        if (service.__graphqlOperations) {
            service.__graphqlOperations.forEach((op: any) => {
                const { type, name, input, output, propertyKey } = op;
                let fieldDef = `${name}`;
                if (input) {
                    const inputName = `${name}Input`;
                    typeDefs += `input ${inputName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                    fieldDef += `(input: ${inputName}!)`;
                    resolvers[type][name] = async (_: any, args: any, context: any) => {
                        try {
                            return await service[propertyKey](args.input || args, context);
                        } catch (error) {
                            logger.error(`Error in ${type}.${name}:`);
                            logger.error(error);
                            if (error instanceof GraphQLError) {
                                throw error;
                            }
                            throw new GraphQLError(`Internal error in ${name}`, {
                                extensions: {
                                    code: "INTERNAL_ERROR",
                                    originalError: process.env.NODE_ENV === 'development' ? error : undefined
                                }
                            });
                        }
                    };
                } else {
                    resolvers[type][name] = async (_: any, args: any, context: any) => {
                        try {
                            return await service[propertyKey]({}, context);
                        } catch (error) {
                            logger.error(`Error in ${type}.${name}:`);
                            logger.error(error);
                            if (error instanceof GraphQLError) {
                                throw error;
                            }
                            throw new GraphQLError(`Internal error in ${name}`, {
                                extensions: {
                                    code: "INTERNAL_ERROR",
                                    originalError: process.env.NODE_ENV === 'development' ? error : undefined
                                }
                            });
                        }
                    };
                }
                if (typeof output === 'string') {
                    fieldDef += `: ${output}`;
                } else if (typeof output === 'object') {
                    const outputName = `${name}Output`;
                    typeDefs += `type ${outputName} {\n${Object.entries(output).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                    fieldDef += `: ${outputName}`;
                }
                if (type === 'Query') {
                    queryFields.push(fieldDef);
                } else if (type === 'Mutation') {
                    mutationFields.push(fieldDef);
                }
            });
        }
    });

    // Process field resolvers
    services.forEach(service => {
        if (service.__graphqlFields) {
            service.__graphqlFields.forEach((fieldMeta: any) => {
                const { type, field, propertyKey } = fieldMeta;
                if (!resolvers[type]) resolvers[type] = {};
                resolvers[type][field] = async (parent: any, args: any, context: any) => {
                    try {
                        return await service[propertyKey](parent, args, context);
                    } catch (error) {
                        logger.error(`Error in ${type}.${field}:`);
                        logger.error(error);
                        if (error instanceof GraphQLError) {
                            throw error;
                        }
                        throw new GraphQLError(`Internal error in ${field}`, {
                            extensions: {
                                code: "INTERNAL_ERROR",
                                originalError: process.env.NODE_ENV === 'development' ? error : undefined
                            }
                        });
                    }
                };
            });
        }
    });

    if (queryFields.length > 0) {
        typeDefs += `type Query {\n${queryFields.map(f => `  ${f}`).join('\n')}\n}\n`;
    }
    if (mutationFields.length > 0) {
        typeDefs += `type Mutation {\n${mutationFields.map(f => `  ${f}`).join('\n')}\n}\n`;
    }

    logger.trace(`System Type Defs: ${typeDefs}`);
    let schema : GraphQLSchema | null = null;
    if(typeDefs !== "")  {
        schema = makeExecutableSchema({ typeDefs, resolvers });
    }
    return { schema, resolvers };
}