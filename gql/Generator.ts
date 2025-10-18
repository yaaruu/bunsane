import { GraphQLSchema, GraphQLError, printSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { logger as MainLogger } from "core/Logger";
import type { GraphQLType } from "./helpers";
import { generateArchetypeOperations } from "./ArchetypeOperations";
import { getArchetypeSchema } from "../core/ArcheType";
import BaseArcheType from "../core/ArcheType";
import { getMetadataStorage } from "../core/metadata";
import type { BaseService } from "service";
import { type ZodType } from "zod";
import { ZodWeaver } from "@gqloom/zod";
import { weave } from "@gqloom/core";
import * as z from "zod";

const logger = MainLogger.child({ scope: "GraphQLGenerator" });
export interface GraphQLObjectTypeMeta {
    name: string;
    fields: Record<string, GraphQLType>;
}

export interface GraphQLOperationMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
    type: "Query" | "Mutation";
    propertyKey?: string;
    name?: string;
    input?: Record<string, GraphQLType> | any;
    output: GraphQLType | Record<string, GraphQLType> | T;
}

export interface GraphQLFieldMeta {
    type: GraphQLType;
    field: string;
}


export function GraphQLObjectType(meta: GraphQLObjectTypeMeta) {
    return (target: BaseService) => {
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

export function GraphQLOperation<T extends BaseArcheType | BaseArcheType[] | string = string>(meta: GraphQLOperationMeta<T>) {
    return function (target: BaseService, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlOperations) target.__graphqlOperations = [];
        const operationName = meta.name ?? propertyKey;
        if (!operationName) {
            throw new Error("GraphQLOperation: Operation name is required (either meta.name or propertyKey must be defined)");
        }
        const operationMeta = { ...meta, name: operationName, propertyKey } as GraphQLOperationMeta<any>;
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
            logger.warn(`Failed to generate schema for archetype ${archetypeMetadata.name}: ${error}`);
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
        logger.warn(`Failed to generate schema for archetype ${inferredName}: ${error}`);
    }
    
    return inferredName;
}

export function generateGraphQLSchema(services: any[], options?: { enableArchetypeOperations?: boolean }): { schema: GraphQLSchema | null; resolvers: any } {
    logger.trace(`generateGraphQLSchema called with ${services.length} services`);
    let typeDefs = `
    `;
    const scalarTypes: Set<string> = new Set();
    const resolvers: any = {};
    const queryFields: string[] = [];
    const mutationFields: string[] = [];

    // PRE-GENERATE ALL ARCHETYPE SCHEMAS
    // Scan all services for archetype instances and generate their schemas upfront
    logger.trace(`Pre-generating archetype schemas from service operations...`);
    services.forEach(service => {
        const operations = service.__graphqlOperations || service.constructor.prototype.__graphqlOperations;
        if (operations) {
            operations.forEach((op: any) => {
                const { output } = op;
                // Check if output is an archetype or array of archetypes
                if (Array.isArray(output) && output[0] instanceof BaseArcheType) {
                    const archetypeInstance = output[0];
                    getArchetypeTypeName(archetypeInstance); // This will cache the schema
                } else if (output instanceof BaseArcheType) {
                    getArchetypeTypeName(output); // This will cache the schema
                }
            });
        }
    });
    logger.trace(`Completed pre-generation of archetype schemas`);

    // Generate archetype operations if enabled
    if (options?.enableArchetypeOperations !== false) {
        try {
            const archetypeOps = generateArchetypeOperations();
            typeDefs += archetypeOps.typeDefs;
            queryFields.push(...archetypeOps.queryFields);
            mutationFields.push(...archetypeOps.mutationFields);
            Object.assign(resolvers, archetypeOps.resolvers);
            logger.trace(`Added archetype operations: ${archetypeOps.queryFields.length} queries, ${archetypeOps.mutationFields.length} mutations`);
        } catch (error) {
            logger.error(`Failed to generate archetype operations: ${error}`);
        }
    } else {
        // Still generate type definitions even if operations are disabled
        try {
            const archetypeOps = generateArchetypeOperations();
            typeDefs += archetypeOps.typeDefs;
            logger.trace(`Added archetype type definitions (without operations)`);
        } catch (error) {
            logger.error(`Failed to generate archetype type definitions: ${error}`);
        }
    }

    services.forEach(service => {
        logger.trace(`Processing service: ${service.constructor.name}`);
        // Check if service has graphql operations (either on instance or prototype)
        const operations = service.__graphqlOperations || service.constructor.prototype.__graphqlOperations;
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
        if (operations) {
            logger.trace(`Processing ${operations.length} operations for ${service.constructor.name}`);
            operations.forEach((op: any) => {
                try {
                    let { type, name, input, output, propertyKey } = op;
                    if (!resolvers[type]) resolvers[type] = {};
                    let fieldDef = `${name}`;
                    if (input) {
                        const inputName = `${name}Input`;
                        // Check if input is a Zod schema
                        if (input && typeof input === 'object' && '_def' in input) {
                            // It's a Zod schema - use GQLoom's weave to generate GraphQL type
                            try {
                                // Add __typename to input zod object
                                input = input.extend({ __typename: z.literal(inputName).nullish() });
                                logger.trace(`Weaving Zod schema for ${name}`);
                                const gqlInputSchema = weave(ZodWeaver, input as ZodType) as GraphQLSchema;
                                const schemaString = printSchema(gqlInputSchema);
                                logger.trace(`Schema string for ${name}: ${schemaString}`);
                                // Extract the type definition and convert it to an input type
                                // The schema will contain "type <TypeName> { ... }", we need to replace with "input <inputName> { ... }"
                                const typeMatch = schemaString.match(/type\s+(\w+)\s*\{([^}]*)\}/s);
                                if (typeMatch) {
                                    const fields = typeMatch[2];
                                    typeDefs += `input ${inputName} {${fields}}\n`;
                                    logger.trace(`Successfully generated input type ${inputName}`);
                                } else {
                                    logger.warn(`Could not extract type from Zod schema for ${name}, schema: ${schemaString}`);
                                    typeDefs += `input ${inputName} { _placeholder: String }\n`;
                                }
                            } catch (error) {
                                logger.error(`Failed to weave Zod schema for ${name}: ${error}`);
                                logger.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`);
                                // Fallback: generate basic input type
                                typeDefs += `input ${inputName} { _placeholder: String }\n`;
                            }
                        } else {
                            // Legacy Record<string, GraphQLType> format
                            typeDefs += `input ${inputName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                        }
                        fieldDef += `(input: ${inputName}!)`;
                        
                        // Store the Zod schema for validation if it's a Zod type
                        const zodSchema = (input && typeof input === 'object' && '_def' in input) ? input as ZodType : null;
                        
                        resolvers[type][name] = async (_: any, args: any, context: any, info: any) => {
                            try {
                                const inputArgs = args.input || args;
                                
                                // Automatically validate with Zod schema if provided
                                if (zodSchema) {
                                    try {
                                        const validated = zodSchema.parse(inputArgs);
                                        return await service[propertyKey](validated, context, info);
                                    } catch (error) {
                                        if (error instanceof z.ZodError) {
                                            // Let handleGraphQLError convert Zod errors to user-friendly messages
                                            const { handleGraphQLError } = await import("../core/ErrorHandler");
                                            handleGraphQLError(error);
                                        }
                                        throw error;
                                    }
                                } else {
                                    return await service[propertyKey](inputArgs, context, info);
                                }
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
                        logger.trace(`Added query field: ${fieldDef}`);
                    } else if (type === 'Mutation') {
                        mutationFields.push(fieldDef);
                        logger.trace(`Added mutation field: ${fieldDef}`);
                    }
                } catch (opError) {
                    logger.error(`Failed to process operation ${op.name || 'unknown'} in ${service.constructor.name}: ${opError}`);
                    logger.error(`Error stack: ${opError instanceof Error ? opError.stack : 'No stack'}`);
                }
            });

            logger.trace(`Completed processing operations for ${service.constructor.name}`);
        }
    });

    // Process field resolvers
    services.forEach(service => {
        const fields = service.__graphqlFields || service.constructor.prototype.__graphqlFields;
        if (fields) {
            fields.forEach((fieldMeta: any) => {
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

    logger.trace(`Query fields count: ${queryFields.length}, Mutation fields count: ${mutationFields.length}`);
    logger.trace(`System Type Defs: ${typeDefs}`);
    let schema : GraphQLSchema | null = null;
    // Check if typeDefs contains actual schema definitions, not just whitespace
    if(typeDefs.trim() !== "" && (queryFields.length > 0 || mutationFields.length > 0 || scalarTypes.size > 0))  {
        logger.trace(`Creating schema with resolvers: ${Object.keys(resolvers).join(', ')}`);
        schema = createSchema({ typeDefs, resolvers });
    } else {
        logger.warn(`No schema generated - queryFields: ${queryFields.length}, mutationFields: ${mutationFields.length}, scalarTypes: ${scalarTypes.size}`);
    }
    return { schema, resolvers };
}