import { GraphQLSchema, GraphQLError, printSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { logger as MainLogger } from "core/Logger";
import type { GraphQLType } from "./helpers";
import { generateArchetypeOperations } from "./ArchetypeOperations";
import { getArchetypeSchema, weaveAllArchetypes, getAllArchetypeSchemas } from "../core/ArcheType";
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

export interface GraphQLSubscriptionMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
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


export function GraphQLSubscription<T extends BaseArcheType | BaseArcheType[] | string = string>(meta: GraphQLSubscriptionMeta<T>) {
    return function (target: BaseService, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlSubscriptions) target.__graphqlSubscriptions = [];
        const subscriptionName = meta.name ?? propertyKey;
        if (!subscriptionName) {
            throw new Error("GraphQLSubscription: Subscription name is required (either meta.name or propertyKey must be defined)");
        }
        const subscriptionMeta = { ...meta, name: subscriptionName, propertyKey } as GraphQLSubscriptionMeta<any>;
        target.__graphqlSubscriptions.push(subscriptionMeta);
    };
}


/**
 * Deduplicate input type definitions by tracking which types have already been defined.
 * @param inputTypeDefs - The input type definitions to deduplicate
 * @param definedTypes - Set of already defined type names
 * @returns Deduplicated input type definitions
 */
function deduplicateInputTypes(inputTypeDefs: string, definedTypes: Set<string>): string {
    const lines = inputTypeDefs.split('\n');
    const result: string[] = [];
    let currentType = '';
    let currentTypeName = '';
    let inTypeDefinition = false;

    for (const line of lines) {
        const trimmed = line.trim();
        
        // Check if this is the start of an input/enum definition
        const typeMatch = trimmed.match(/^(input|enum)\s+(\w+)/);
        
        if (typeMatch) {
            // Save previous type if we were in one
            if (inTypeDefinition && currentTypeName && !definedTypes.has(currentTypeName)) {
                result.push(currentType);
                definedTypes.add(currentTypeName);
                logger.trace(`Added input type definition: ${currentTypeName}`);
            } else if (inTypeDefinition && currentTypeName && definedTypes.has(currentTypeName)) {
                logger.trace(`Skipped duplicate input type definition: ${currentTypeName}`);
            }
            
            // Start new type
            currentTypeName = typeMatch[2] || '';
            currentType = line + '\n';
            inTypeDefinition = true;
        } else if (inTypeDefinition) {
            currentType += line + '\n';
            
            // Check if this is the closing brace
            if (trimmed === '}' || trimmed === '') {
                // End of type definition (closing brace or empty line after enum)
                if (trimmed === '}' && !definedTypes.has(currentTypeName)) {
                    result.push(currentType);
                    definedTypes.add(currentTypeName);
                    logger.trace(`Added input type definition: ${currentTypeName}`);
                } else if (trimmed === '}' && definedTypes.has(currentTypeName)) {
                    logger.trace(`Skipped duplicate input type definition: ${currentTypeName}`);
                }
                currentType = '';
                currentTypeName = '';
                inTypeDefinition = false;
            }
        } else {
            // Not in a type definition, just add the line (could be comments, etc.)
            if (trimmed !== '') {
                result.push(line + '\n');
            }
        }
    }
    
    // Handle last type if file doesn't end with closing brace
    if (inTypeDefinition && currentTypeName && !definedTypes.has(currentTypeName)) {
        result.push(currentType);
        definedTypes.add(currentTypeName);
        logger.trace(`Added input type definition: ${currentTypeName}`);
    }

    return result.join('');
}

/**
 * Deduplicate all type definitions in the typeDefs string.
 * @param typeDefs - The type definitions string to deduplicate
 * @returns Deduplicated type definitions
 */
function deduplicateTypeDefs(typeDefs: string): string {
    const lines = typeDefs.split('\n');
    const typeDefinitions = new Map<string, string>();
    let currentType = '';
    let currentTypeName = '';
    let inTypeDefinition = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const typeMatch = trimmed.match(/^(type|input|enum|scalar|interface|union)\s+(\w+)/);
        
        if (typeMatch) {
            // Save previous type if we were in one
            if (inTypeDefinition && currentTypeName && !typeDefinitions.has(currentTypeName)) {
                typeDefinitions.set(currentTypeName, currentType);
            }
            
            // Start new type
            currentTypeName = typeMatch[2] || '';
            currentType = line + '\n';
            inTypeDefinition = true;
        } else if (inTypeDefinition) {
            currentType += line + '\n';
            
            // Check if this is the closing brace
            if (trimmed === '}') {
                if (!typeDefinitions.has(currentTypeName)) {
                    typeDefinitions.set(currentTypeName, currentType);
                }
                currentType = '';
                currentTypeName = '';
                inTypeDefinition = false;
            }
        } else {
            // Other lines, like comments or empty lines
            if (!typeDefinitions.has('__other')) {
                typeDefinitions.set('__other', '');
            }
            typeDefinitions.set('__other', typeDefinitions.get('__other')! + line + '\n');
        }
    }
    
    // Handle last type if file doesn't end with closing brace
    if (inTypeDefinition && currentTypeName && !typeDefinitions.has(currentTypeName)) {
        typeDefinitions.set(currentTypeName, currentType);
    }

    const result = Array.from(typeDefinitions.values()).join('');
    return result;
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

/**
 * Extract type definitions from a GraphQL schema string.
 * @param schemaString - The GraphQL schema string
 * @returns Array of type definition strings
 */
function extractTypeDefinitions(schemaString: string): string[] {
    const lines = schemaString.split('\n');
    const typeDefinitions: string[] = [];
    let currentType = '';
    let inTypeDefinition = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('type ') || trimmed.startsWith('input ') || trimmed.startsWith('enum ') || trimmed.startsWith('scalar ') || trimmed.startsWith('interface ') || trimmed.startsWith('union ')) {
            if (inTypeDefinition) {
                typeDefinitions.push(currentType);
            }
            currentType = line + '\n';
            inTypeDefinition = true;
        } else if (inTypeDefinition) {
            currentType += line + '\n';
            if (trimmed === '}') {
                typeDefinitions.push(currentType);
                currentType = '';
                inTypeDefinition = false;
            }
        }
    }
    if (inTypeDefinition) {
        typeDefinitions.push(currentType);
    }
    return typeDefinitions;
}

/**
 * Deduplicate type definitions by name.
 * @param typeDefinitions - Array of type definition strings
 * @param definedTypes - Set to track defined type names
 * @returns Deduplicated type definitions as a single string
 */
function deduplicateTypeDefinitions(typeDefinitions: string[], definedTypes: Set<string>): string {
    const result: string[] = [];
    for (const typeDef of typeDefinitions) {
        const match = typeDef.match(/(?:type|input|enum|scalar|interface|union)\s+(\w+)/);
        if (match) {
            const typeName = match[1];
            if (typeName && !definedTypes.has(typeName)) {
                result.push(typeDef);
                definedTypes.add(typeName);
            }
        } else {
            result.push(typeDef);
        }
    }
    return result.join('');
}

export function generateGraphQLSchema(services: any[], options?: { enableArchetypeOperations?: boolean }): { schema: GraphQLSchema | null; resolvers: any } {
    logger.trace(`generateGraphQLSchema called with ${services.length} services`);
    let typeDefs = `
    `;
    const scalarTypes: Set<string> = new Set();
    const resolvers: any = {};
    const queryFields: string[] = [];
    const mutationFields: string[] = [];
    const subscriptionFields: string[] = [];
    const definedInputTypes: Set<string> = new Set(); // Track defined input types to prevent duplicates

    // PRE-GENERATE ALL ARCHETYPE SCHEMAS
    // Scan all services for archetype instances and generate their schemas upfront
    logger.trace(`Pre-generating archetype schemas from service operations and subscriptions...`);
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
        const subscriptions = service.__graphqlSubscriptions || service.constructor.prototype.__graphqlSubscriptions;
        if (subscriptions) {
            subscriptions.forEach((sub: any) => {
                const { output } = sub;
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

    // Add archetype types first
    const fullSchema = weaveAllArchetypes();
    if (fullSchema) {
        const typeDefinitions = extractTypeDefinitions(fullSchema);
        typeDefs += deduplicateTypeDefs(typeDefinitions.join(''));
    } else {
        const schemas = getAllArchetypeSchemas();
        for (const { graphqlSchema } of schemas) {
            const typeDefinitions = extractTypeDefinitions(graphqlSchema);
            typeDefs += deduplicateTypeDefs(typeDefinitions.join(''));
        }
    }

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
                        // Store the original input for validation (before any preprocessing)
                        let originalInput: any = null;
                        
                        // Check if input is a Zod schema
                        if (input && typeof input === 'object' && '_def' in input) {
                            // Store the original input for later traversal and validation
                            originalInput = input;
                            
                            // It's a Zod schema - use GQLoom's weave to generate GraphQL type
                            try {
                                // Add __typename to input zod object, handling optional schemas
                                let innerInput = input;
                                const wasOptional = input instanceof z.ZodOptional;
                                if (wasOptional) {
                                    innerInput = input.unwrap();
                                }
                                
                                // Preprocess schema: Replace z.union containing scalar literals with just the literal
                                // This is needed because GQLoom's weave doesn't handle z.union well
                                const shape = typeof innerInput._def.shape === 'function' ? innerInput._def.shape() : innerInput._def.shape;
                                if (shape) {
                                    const processedShape: any = {};
                                    for (const [key, value] of Object.entries(shape)) {
                                        const fieldSchema = value as any;
                                        const typeName = fieldSchema._def?.typeName || fieldSchema._def?.type;
                                        
                                        // Check if it's a union containing a scalar literal
                                        if (typeName === 'ZodUnion' || typeName === 'union') {
                                            const options = fieldSchema._def?.options || [];
                                            let foundScalarLiteral = null;
                                            
                                            for (const option of options) {
                                                const optionTypeName = option._def?.typeName || option._def?.type;
                                                if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
                                                    const value = option._def?.value ?? (option._def?.values ? option._def.values[0] : undefined);
                                                    if (typeof value === 'string' && scalarTypes.has(value)) {
                                                        foundScalarLiteral = option;
                                                        break;
                                                    }
                                                }
                                            }
                                            
                                            // Replace union with just the literal for schema generation
                                            processedShape[key] = foundScalarLiteral || fieldSchema;
                                        } else {
                                            processedShape[key] = fieldSchema;
                                        }
                                    }
                                    
                                    // Create new schema with processed shape
                                    innerInput = z.object(processedShape);
                                }
                                
                                innerInput = innerInput.extend({ __typename: z.literal(inputName).nullish() });
                                if (wasOptional) {
                                    input = innerInput.optional();
                                } else {
                                    input = innerInput;
                                }
                                logger.trace(`Weaving Zod schema for ${name}`);
                                const gqlInputSchema = weave(ZodWeaver, input as ZodType) as GraphQLSchema;
                                const schemaString = printSchema(gqlInputSchema);
                                logger.trace(`Schema string for ${name}: ${schemaString}`);
                                // Collect custom type names
                                const typeNames: string[] = [];
                                schemaString.replace(/type (\w+)/g, (match, name) => {
                                    typeNames.push(name);
                                    return match;
                                });
                                // Convert all type definitions to input types with Input suffix for non-Input types
                                let inputTypeDefs = schemaString.replace(/\btype\b/g, 'input');
                                inputTypeDefs = inputTypeDefs.replace(/input (\w+)/g, (match, name) => {
                                    if (name.endsWith('Input')) {
                                        return `input ${name}`;
                                    } else {
                                        return `input ${name}Input`;
                                    }
                                });
                                // Update field types for custom types
                                inputTypeDefs = inputTypeDefs.replace(/: (\[?)(\w+)([!\[\]]*)(\s|$)/g, (match, bracketStart, type, suffix, end) => {
                                    if (typeNames.includes(type)) {
                                        return `: ${bracketStart}${type.endsWith('Input') ? type : type + 'Input'}${suffix}${end}`;
                                    } else {
                                        return match;
                                    }
                                });                                // Deduplicate input types - only add if not already defined
                                const deduplicatedInputTypeDefs = deduplicateInputTypes(inputTypeDefs, definedInputTypes);
                                typeDefs += deduplicatedInputTypeDefs;
                                typeDefs += `\n`;
                                
                                // Post-process to handle z.literal scalars
                                // Use the original input before __typename was added
                                let schemaToTraverse: any = originalInput;
                                
                                // Unwrap optional if needed
                                const defType = (schemaToTraverse._def as any)?.typeName || (schemaToTraverse._def as any)?.type;
                                if (defType === 'ZodOptional' || defType === 'optional') {
                                    schemaToTraverse = (schemaToTraverse as any)._def.innerType;
                                }
                                
                                // Find all z.literal fields that match scalar names
                                const literalFields: Record<string, string> = {};
                                function traverseZod(obj: any, path: string[] = []) {
                                    if (!obj || !obj._def) {
                                        return;
                                    }
                                    const typeName = (obj._def as any).typeName || (obj._def as any).type;
                                    if (typeName === 'ZodLiteral' || typeName === 'literal') {
                                        // Zod v3 uses 'value', Zod v4 uses 'values' array
                                        const defObj = obj._def as any;
                                        const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
                                        if (typeof value === 'string' && scalarTypes.has(value)) {
                                            literalFields[path.join('.')] = value;
                                        }
                                    } else if (typeName === 'ZodUnion' || typeName === 'union') {
                                        // Handle z.union - check if any option is a literal scalar
                                        const options = (obj._def as any).options || [];
                                        for (const option of options) {
                                            const optionTypeName = (option._def as any)?.typeName || (option._def as any)?.type;
                                            if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
                                                const defObj = option._def as any;
                                                const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
                                                if (typeof value === 'string' && scalarTypes.has(value)) {
                                                    literalFields[path.join('.')] = value;
                                                    break; // Found a scalar literal, use it
                                                }
                                            }
                                        }
                                    } else if (typeName === 'ZodObject' || typeName === 'object') {
                                        const shape = typeof obj._def.shape === 'function' ? obj._def.shape() : obj._def.shape;
                                        if (shape) {
                                            for (const [key, value] of Object.entries(shape)) {
                                                traverseZod(value, [...path, key]);
                                            }
                                        }
                                    }
                                }
                                traverseZod(schemaToTraverse);
                                
                                // Replace in typeDefs
                                for (const [fieldPath, scalarName] of Object.entries(literalFields)) {
                                    const fieldName = fieldPath.split('.').pop()!;
                                    typeDefs = typeDefs.replace(new RegExp(`(\\s+${fieldName}:\\s+)String!`, 'g'), `$1${scalarName}!`);
                                }
                                
                                logger.trace(`Successfully generated input types for ${name}`);
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

                        // Store the Zod schema for validation if it's a Zod type
                        // Use originalInput if it exists (to preserve unions), otherwise use input
                        const zodSchema = (originalInput && typeof originalInput === 'object' && '_def' in originalInput) 
                            ? originalInput as ZodType 
                            : (input && typeof input === 'object' && '_def' in input) ? input as ZodType : null;

                        // Determine GraphQL input nullability based on Zod schema acceptance of undefined/null
                        // If the Zod schema accepts undefined or null (i.e. is optional/nullable), we omit the '!' for the input param.
                        let inputNullability = '!';
                        if (zodSchema) {
                            try {
                                const allowsUndefined = !!(zodSchema && typeof (zodSchema as any).safeParse === 'function' && (zodSchema as any).safeParse(undefined).success);
                                const allowsNull = !!(zodSchema && typeof (zodSchema as any).safeParse === 'function' && (zodSchema as any).safeParse(null).success);
                                if (allowsUndefined || allowsNull) inputNullability = '';
                            } catch (e) {
                                // If anything goes wrong, conservatively keep it non-nullable
                                inputNullability = '!';
                            }
                        }

                        fieldDef += `(input: ${inputName}${inputNullability})`;
                        
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
                    } else {
                        // Default case when output is not specified - assume String
                        fieldDef += `: String`;
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

        // Process subscriptions
        const subscriptions = service.__graphqlSubscriptions || service.constructor.prototype.__graphqlSubscriptions;
        if (subscriptions) {
            logger.trace(`Processing ${subscriptions.length} subscriptions for ${service.constructor.name}`);
            subscriptions.forEach((sub: any) => {
                try {
                    let { name, input, output, propertyKey } = sub;
                    if (!resolvers.Subscription) resolvers.Subscription = {};
                    let fieldDef = `${name}`;
                    if (input) {
                        const inputName = `${name}Input`;
                        // Store the original input for validation (before any preprocessing)
                        let originalInput: any = null;
                        
                        // Check if input is a Zod schema
                        if (input && typeof input === 'object' && '_def' in input) {
                            // Store the original input for later traversal and validation
                            originalInput = input;
                            
                            // It's a Zod schema - use GQLoom's weave to generate GraphQL type
                            try {
                                // Add __typename to input zod object, handling optional schemas
                                let innerInput = input;
                                const wasOptional = input instanceof z.ZodOptional;
                                if (wasOptional) {
                                    innerInput = input.unwrap();
                                }
                                
                                // Preprocess schema: Replace z.union containing scalar literals with just the literal
                                // This is needed because GQLoom's weave doesn't handle z.union well
                                const shape = typeof innerInput._def.shape === 'function' ? innerInput._def.shape() : innerInput._def.shape;
                                if (shape) {
                                    const processedShape: any = {};
                                    for (const [key, value] of Object.entries(shape)) {
                                        const fieldSchema = value as any;
                                        const typeName = fieldSchema._def?.typeName || fieldSchema._def?.type;
                                        
                                        // Check if it's a union containing a scalar literal
                                        if (typeName === 'ZodUnion' || typeName === 'union') {
                                            const options = fieldSchema._def?.options || [];
                                            let foundScalarLiteral = null;
                                            
                                            for (const option of options) {
                                                const optionTypeName = option._def?.typeName || option._def?.type;
                                                if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
                                                    const value = option._def?.value ?? (option._def?.values ? option._def.values[0] : undefined);
                                                    if (typeof value === 'string' && scalarTypes.has(value)) {
                                                        foundScalarLiteral = option;
                                                        break;
                                                    }
                                                }
                                            }
                                            
                                            // Replace union with just the literal for schema generation
                                            processedShape[key] = foundScalarLiteral || fieldSchema;
                                        } else {
                                            processedShape[key] = fieldSchema;
                                        }
                                    }
                                    
                                    // Create new schema with processed shape
                                    innerInput = z.object(processedShape);
                                }
                                
                                innerInput = innerInput.extend({ __typename: z.literal(inputName).nullish() });
                                if (wasOptional) {
                                    input = innerInput.optional();
                                } else {
                                    input = innerInput;
                                }
                                logger.trace(`Weaving Zod schema for subscription ${name}`);
                                const gqlInputSchema = weave(ZodWeaver, input as ZodType) as GraphQLSchema;
                                const schemaString = printSchema(gqlInputSchema);
                                logger.trace(`Schema string for subscription ${name}: ${schemaString}`);
                                // Collect custom type names
                                const typeNames: string[] = [];
                                schemaString.replace(/type (\w+)/g, (match, name) => {
                                    typeNames.push(name);
                                    return match;
                                });
                                // Convert all type definitions to input types with Input suffix for non-Input types
                                let inputTypeDefs = schemaString.replace(/\btype\b/g, 'input');
                                inputTypeDefs = inputTypeDefs.replace(/input (\w+)/g, (match, name) => {
                                    if (name.endsWith('Input')) {
                                        return `input ${name}`;
                                    } else {
                                        return `input ${name}Input`;
                                    }
                                });
                                // Update field types for custom types
                                inputTypeDefs = inputTypeDefs.replace(/: (\[?)(\w+)([!\[\]]*)(\s|$)/g, (match, bracketStart, type, suffix, end) => {
                                    if (typeNames.includes(type)) {
                                        return `: ${bracketStart}${type.endsWith('Input') ? type : type + 'Input'}${suffix}${end}`;
                                    } else {
                                        return match;
                                    }
                                });                                
                                // Deduplicate input types - only add if not already defined
                                const deduplicatedInputTypeDefs = deduplicateInputTypes(inputTypeDefs, definedInputTypes);
                                typeDefs += deduplicatedInputTypeDefs;
                                typeDefs += `\n`;
                                
                                // Post-process to handle z.literal scalars
                                // Use the original input before __typename was added
                                let schemaToTraverse: any = originalInput;
                                
                                // Unwrap optional if needed
                                const defType = (schemaToTraverse._def as any)?.typeName || (schemaToTraverse._def as any)?.type;
                                if (defType === 'ZodOptional' || defType === 'optional') {
                                    schemaToTraverse = (schemaToTraverse as any)._def.innerType;
                                }
                                
                                // Find all z.literal fields that match scalar names
                                const literalFields: Record<string, string> = {};
                                function traverseZod(obj: any, path: string[] = []) {
                                    if (!obj || !obj._def) {
                                        return;
                                    }
                                    const typeName = (obj._def as any).typeName || (obj._def as any).type;
                                    if (typeName === 'ZodLiteral' || typeName === 'literal') {
                                        // Zod v3 uses 'value', Zod v4 uses 'values' array
                                        const defObj = obj._def as any;
                                        const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
                                        if (typeof value === 'string' && scalarTypes.has(value)) {
                                            literalFields[path.join('.')] = value;
                                        }
                                    } else if (typeName === 'ZodUnion' || typeName === 'union') {
                                        // Handle z.union - check if any option is a literal scalar
                                        const options = (obj._def as any).options || [];
                                        for (const option of options) {
                                            const optionTypeName = (option._def as any)?.typeName || (option._def as any)?.type;
                                            if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
                                                const defObj = option._def as any;
                                                const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
                                                if (typeof value === 'string' && scalarTypes.has(value)) {
                                                    literalFields[path.join('.')] = value;
                                                    break; // Found a scalar literal, use it
                                                }
                                            }
                                        }
                                    } else if (typeName === 'ZodObject' || typeName === 'object') {
                                        const shape = typeof obj._def.shape === 'function' ? obj._def.shape() : obj._def.shape;
                                        if (shape) {
                                            for (const [key, value] of Object.entries(shape)) {
                                                traverseZod(value, [...path, key]);
                                            }
                                        }
                                    }
                                }
                                traverseZod(schemaToTraverse);
                                
                                // Replace in typeDefs
                                for (const [fieldPath, scalarName] of Object.entries(literalFields)) {
                                    const fieldName = fieldPath.split('.').pop()!;
                                    typeDefs = typeDefs.replace(new RegExp(`(\\s+${fieldName}:\\s+)String!`, 'g'), `$1${scalarName}!`);
                                }
                                
                                logger.trace(`Successfully generated input types for subscription ${name}`);
                            } catch (error) {
                                logger.error(`Failed to weave Zod schema for subscription ${name}: ${error}`);
                                logger.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`);
                                // Fallback: generate basic input type
                                typeDefs += `input ${inputName} { _placeholder: String }\n`;
                            }
                        } else {
                            // Legacy Record<string, GraphQLType> format
                            typeDefs += `input ${inputName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                        }

                        // Store the Zod schema for validation if it's a Zod type
                        // Use originalInput if it exists (to preserve unions), otherwise use input
                        const zodSchema = (originalInput && typeof originalInput === 'object' && '_def' in originalInput) 
                            ? originalInput as ZodType 
                            : (input && typeof input === 'object' && '_def' in input) ? input as ZodType : null;

                        // Determine GraphQL input nullability based on Zod schema acceptance of undefined/null
                        // If the Zod schema accepts undefined or null (i.e. is optional/nullable), we omit the '!' for the input param.
                        let inputNullability = '!';
                        if (zodSchema) {
                            try {
                                const allowsUndefined = !!(zodSchema && typeof (zodSchema as any).safeParse === 'function' && (zodSchema as any).safeParse(undefined).success);
                                const allowsNull = !!(zodSchema && typeof (zodSchema as any).safeParse === 'function' && (zodSchema as any).safeParse(null).success);
                                if (allowsUndefined || allowsNull) inputNullability = '';
                            } catch (e) {
                                // If anything goes wrong, conservatively keep it non-nullable
                                inputNullability = '!';
                            }
                        }

                        fieldDef += `(input: ${inputName}${inputNullability})`;
                        
                        resolvers.Subscription[name] = {
                            subscribe: async (_: any, args: any, context: any, info: any) => {
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
                                    logger.error(`Error in Subscription.${name}:`);
                                    logger.error(error);
                                    if (error instanceof GraphQLError) {
                                        throw error;
                                    }
                                    throw new GraphQLError(`Internal error in subscription ${name}`, {
                                        extensions: {
                                            code: "INTERNAL_ERROR",
                                            originalError: process.env.NODE_ENV === 'development' ? error : undefined
                                        }
                                    });
                                }
                            },
                            resolve: (payload: any) => payload
                        };
                    } else {
                        resolvers.Subscription[name] = {
                            subscribe: async (_: any, args: any, context: any, info: any) => {
                                try {
                                    return await service[propertyKey]({}, context, info);
                                } catch (error) {
                                    logger.error(`Error in Subscription.${name}:`);
                                    logger.error(error);
                                    if (error instanceof GraphQLError) {
                                        throw error;
                                    }
                                    throw new GraphQLError(`Internal error in subscription ${name}`, {
                                        extensions: {
                                            code: "INTERNAL_ERROR",
                                            originalError: process.env.NODE_ENV === 'development' ? error : undefined
                                        }
                                    });
                                }
                            },
                            resolve: (payload: any) => payload
                        };
                    }
                    
                    // Handle output type
                    if (typeof output === 'string') {
                        fieldDef += `: ${output}`;
                    } else if (Array.isArray(output)) {
                        // Handle array of archetypes: [serviceAreaArcheType]
                        const archetypeInstance = output[0];
                        const typeName = getArchetypeTypeName(archetypeInstance);
                        if (typeName) {
                            fieldDef += `: [${typeName}]`;
                        } else {
                            logger.warn(`Invalid array output type for subscription ${name}, expected archetype instance`);
                            fieldDef += `: [Any]`;
                        }
                    } else if (output instanceof BaseArcheType) {
                        // Handle single archetype instance: serviceAreaArcheType
                        const typeName = getArchetypeTypeName(output);
                        if (typeName) {
                            fieldDef += `: ${typeName}`;
                        } else {
                            logger.warn(`Could not determine type name for archetype in subscription ${name}`);
                            fieldDef += `: Any`;
                        }
                    } else if (typeof output === 'object') {
                        const outputName = `${name}Output`;
                        typeDefs += `type ${outputName} {\n${Object.entries(output).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                        fieldDef += `: ${outputName}`;
                    }
                    
                    subscriptionFields.push(fieldDef);
                    logger.trace(`Added subscription field: ${fieldDef}`);
                } catch (subError) {
                    logger.error(`Failed to process subscription ${sub.name || 'unknown'} in ${service.constructor.name}: ${subError}`);
                    logger.error(`Error stack: ${subError instanceof Error ? subError.stack : 'No stack'}`);
                }
            });

            logger.trace(`Completed processing subscriptions for ${service.constructor.name}`);
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
        typeDefs += `type Query {\n${queryFields.sort().map(f => `  ${f}`).join('\n')}\n}\n`;
    }
    if (mutationFields.length > 0) {
        typeDefs += `type Mutation {\n${mutationFields.sort().map(f => `  ${f}`).join('\n')}\n}\n`;
    }
    if (subscriptionFields.length > 0) {
        typeDefs += `type Subscription {\n${subscriptionFields.sort().map(f => `  ${f}`).join('\n')}\n}\n`;
    }

    logger.trace(`Query fields count: ${queryFields.length}, Mutation fields count: ${mutationFields.length}, Subscription fields count: ${subscriptionFields.length}`);
    logger.trace(`System Type Defs: ${typeDefs}`);
    // Deduplicate type definitions to prevent duplicate type errors
    typeDefs = deduplicateTypeDefs(typeDefs);
    logger.trace(`Deduplicated Type Defs: ${typeDefs}`);

    let schema : GraphQLSchema | null = null;
    // Check if typeDefs contains actual schema definitions, not just whitespace
    if(typeDefs.trim() !== "" && (queryFields.length > 0 || mutationFields.length > 0 || subscriptionFields.length > 0 || scalarTypes.size > 0))  {
        logger.trace(`Creating schema with resolvers: ${Object.keys(resolvers).join(', ')}`);
        schema = createSchema({ typeDefs, resolvers });
    } else {
        logger.warn(`No schema generated - queryFields: ${queryFields.length}, mutationFields: ${mutationFields.length}, subscriptionFields: ${subscriptionFields.length}, scalarTypes: ${scalarTypes.size}`);
    }
    return { schema, resolvers };
}