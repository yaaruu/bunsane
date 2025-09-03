import { GraphQLSchema, GraphQLError } from "graphql";
import {makeExecutableSchema} from "@graphql-tools/schema";
import { logger as MainLogger } from "core/Logger";
const logger = MainLogger.child({ scope: "GraphQLGenerator" });
export interface GraphQLTypeMeta {
    name: string;
    fields: Record<string, string>;
}

export interface GraphQLOperationMeta {
    type: "Query" | "Mutation";
    name?: string;
    input?: Record<string, string>;
    output: Record<string, string> | string;
}

export interface GraphQLFieldMeta {
    type: string;
    field: string;
}

export function GraphQLType(meta: GraphQLTypeMeta) {
    return (target: any) => {
        target.__graphqlType = meta;
    }
}

export function GraphQLOperation(meta: GraphQLOperationMeta) {
    return function (target: any, context: ClassMethodDecoratorContext) {
        if (!target.__graphqlOperations) target.__graphqlOperations = [];
        const operationName = meta.name ?? context;
        if (!operationName) {
            throw new Error("GraphQLOperation: Operation name is required (either meta.name or context.name must be defined)");
        }
        const operationMeta = { ...meta, name: operationName, propertyKey: context};
        target.__graphqlOperations.push(operationMeta);
    };
}

export function GraphQLField(meta: GraphQLFieldMeta) {
    return function (target: any, context: ClassMethodDecoratorContext) {
        if (!target.__graphqlFields) target.__graphqlFields = [];
        target.__graphqlFields.push({ ...meta, propertyKey: context });
    };
}

export function generateGraphQLSchema(systems: any[]): { schema: GraphQLSchema | null; resolvers: any } {
    let typeDefs = "";
    const resolvers: any = { Query: {}, Mutation: {} };
    const queryFields: string[] = [];
    const mutationFields: string[] = [];

    systems.forEach(system => {
        logger.trace(`Processing system: ${system.constructor.name}`);
        if (system.constructor.__graphqlType) {
            const { name, fields } = system.constructor.__graphqlType;
            typeDefs += `type ${name} {\n${Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
        }
        if (system.__graphqlOperations) {
            system.__graphqlOperations.forEach((op: any) => {
                const { type, name, input, output, propertyKey } = op;
                let fieldDef = `${name}`;
                if (input) {
                    const inputName = `${name}Input`;
                    typeDefs += `input ${inputName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                    fieldDef += `(input: ${inputName}!)`;
                    resolvers[type][name] = async (_: any, args: any, context: any) => {
                        try {
                            return await system[propertyKey](args.input || args, context);
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
                            return await system[propertyKey]({}, context);
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
    systems.forEach(system => {
        if (system.__graphqlFields) {
            system.__graphqlFields.forEach((fieldMeta: any) => {
                const { type, field, propertyKey } = fieldMeta;
                if (!resolvers[type]) resolvers[type] = {};
                resolvers[type][field] = async (parent: any, args: any, context: any) => {
                    try {
                        return await system[propertyKey](parent, args, context);
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