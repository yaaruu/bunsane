import { GraphQLSchema, GraphQLError } from "graphql";
import { createSchema } from "graphql-yoga";
import { logger as MainLogger } from "core/Logger";
import type { GraphQLType } from "./helpers";
import { generateArchetypeOperations } from "./ArchetypeOperations";
import { weaveAllArchetypes, getArchetypeSchema } from "../core/ArcheType";
import BaseArcheType from "../core/ArcheType";
import { getMetadataStorage } from "../core/metadata";

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

export function GraphQLScalarType(name: string) {
    return (target: any) => {
        if (!target.__graphqlScalarTypes) target.__graphqlScalarTypes = [];
        target.__graphqlScalarTypes.push(name);
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

/**
 * Helper function to get the registered GraphQL type name from an archetype instance.
 * This respects the custom name set via @ArcheType("CustomName") decorator.
 * Falls back to inferring from class name if not found in registry.
 */
function getArchetypeTypeName(archetypeInstance: any): string | null {
    if (!archetypeInstance || !(archetypeInstance instanceof BaseArcheType)) {
        return null;
    }
    
    const storage = getMetadataStorage();
    const className = archetypeInstance.constructor.name;
    
    // Look up the archetype metadata by class name to get the custom name
    const archetypeMetadata = storage.archetypes.find(a => a.target?.name === className);
    
    if (archetypeMetadata?.name) {
        // Use the custom name from @ArcheType("CustomName") decorator
        logger.trace(`Found custom archetype name: ${archetypeMetadata.name} for class ${className}`);
        
        // Ensure schema is generated and cached
        try {
            if (!getArchetypeSchema(archetypeMetadata.name)) {
                archetypeInstance.getZodObjectSchema();
            }
        } catch (error) {
            logger.warn(`Failed to generate schema for archetype ${archetypeMetadata.name}:`, error);
        }
        
        return archetypeMetadata.name;
    }
    
    // Fallback: infer from class name
    const inferredName = className.replace(/ArcheType$/, '');
    logger.trace(`Using inferred archetype name: ${inferredName} for class ${className}`);
    
    try {
        if (!getArchetypeSchema(inferredName)) {
            archetypeInstance.getZodObjectSchema();
        }
    } catch (error) {
        logger.warn(`Failed to generate schema for archetype ${inferredName}:`, error);
    }
    
    return inferredName;
}

export function generateGraphQLSchema(services: any[], options?: { enableArchetypeOperations?: boolean }): { schema: GraphQLSchema | null; resolvers: any } {
    let typeDefs = `
    `;
    const scalarTypes: Set<string> = new Set();
    const resolvers: any = {};
    const queryFields: string[] = [];
    const mutationFields: string[] = [];

    // Generate archetype operations if enabled
    if (options?.enableArchetypeOperations !== false) {
        try {
            // Option 1: Use individual archetype schemas with auto-generated CRUD
            const archetypeOps = generateArchetypeOperations();
            typeDefs += archetypeOps.typeDefs;
            queryFields.push(...archetypeOps.queryFields);
            mutationFields.push(...archetypeOps.mutationFields);
            Object.assign(resolvers, archetypeOps.resolvers);
            logger.trace(`Added archetype operations: ${archetypeOps.queryFields.length} queries, ${archetypeOps.mutationFields.length} mutations`);
            
            // Option 2: Or use the unified schema from weaveAllArchetypes (no CRUD yet)
            // const unifiedSchema = weaveAllArchetypes();
            // if (unifiedSchema) {
            //     typeDefs += "\n# Unified Archetype Schemas\n" + unifiedSchema;
            // }
        } catch (error) {
            logger.error(`Failed to generate archetype operations: ${error}`);
        }
    }

    services.forEach(service => {
        logger.trace(`Processing service: ${service.constructor.name}`);
        if(service.constructor.__graphqlScalarTypes) {
            for (const scalarName of service.constructor.__graphqlScalarTypes) {
                if (!scalarTypes.has(scalarName)) {
                    scalarTypes.add(scalarName);
                    typeDefs += `scalar ${scalarName}\n`;
                }
            }
        }
        if (service.constructor.__graphqlObjectType) {
            for (const meta of service.constructor.__graphqlObjectType) {
                const { name, fields } = meta;
                typeDefs += `type ${name} {\n${Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
            }
        }
        if (service.__graphqlOperations) {
            service.__graphqlOperations.forEach((op: any) => {
                const { type, name, input, output, propertyKey } = op;
                if (!resolvers[type]) resolvers[type] = {};
                let fieldDef = `${name}`;
                if (input) {
                    const inputName = `${name}Input`;
                    typeDefs += `input ${inputName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                    fieldDef += `(input: ${inputName}!)`;
                    resolvers[type][name] = async (_: any, args: any, context: any, info: any) => {
                        try {
                            return await service[propertyKey](args.input || args, context, info);
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
                    resolvers[type][name] = async (_: any, args: any, context: any, info: any) => {
                        try {
                            return await service[propertyKey]({}, context, info);
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
                } else if (Array.isArray(output)) {
                    // Handle array of archetypes: [serviceAreaArcheType]
                    const archetypeInstance = output[0];
                    const typeName = getArchetypeTypeName(archetypeInstance);
                    if (typeName) {
                        fieldDef += `: [${typeName}]`;
                    } else {
                        logger.warn(`Invalid array output type for ${name}, expected archetype instance`);
                        fieldDef += `: [Any]`;
                    }
                } else if (output instanceof BaseArcheType) {
                    // Handle single archetype instance: serviceAreaArcheType
                    const typeName = getArchetypeTypeName(output);
                    if (typeName) {
                        fieldDef += `: ${typeName}`;
                    } else {
                        logger.warn(`Could not determine type name for archetype in ${name}`);
                        fieldDef += `: Any`;
                    }
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
                resolvers[type][field] = async (parent: any, args: any, context: any, info: any) => {
                    try {
                        return await service[propertyKey](parent, args, context, info);
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
    // Check if typeDefs contains actual schema definitions, not just whitespace
    if(typeDefs.trim() !== "" && (queryFields.length > 0 || mutationFields.length > 0 || scalarTypes.size > 0))  {
        schema = createSchema({ typeDefs, resolvers });
    }
    return { schema, resolvers };
}