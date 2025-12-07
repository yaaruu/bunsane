import { GraphVisitor } from "./GraphVisitor";
import type { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode, SubscriptionNode } from "../graph/GraphNode";
import { logger as MainLogger } from "core/Logger";
import * as z from "zod";
import { ZodWeaver } from "@gqloom/zod";
import { weave } from "@gqloom/core";
import type { ZodType } from "zod";
import { GraphQLSchema, printSchema } from "graphql";
import BaseArcheType from "../../core/ArcheType";
import { getMetadataStorage } from "../../core/metadata";
import { getArchetypeSchema } from "../../core/ArcheType";

const logger = MainLogger.child({ scope: 'SchemaGeneratorVisitor' });

/**
 * Visitor that generates the final GraphQL schema type definitions string.
 * Replicates the V1 generation logic exactly to ensure identical output.
 */
export class SchemaGeneratorVisitor extends GraphVisitor {
    private typeDefs: string = '\n    ';
    private queryFields: string[] = [];
    private mutationFields: string[] = [];
    private subscriptionFields: string[] = [];
    private definedTypes: Set<string> = new Set();
    private finalized: boolean = false;
    
    constructor() {
        super();
    }
    
    /**
     * Add archetype type definitions before visiting nodes (like V1 does)
     */
    beforeVisit(): void {
        // Import required functions
        const { weaveAllArchetypes, getAllArchetypeSchemas } = require('../../core/ArcheType');
        
        // Add archetype types first (exactly like V1)
        const fullSchema = weaveAllArchetypes();
        if (fullSchema) {
            const typeDefinitions = this.extractTypeDefinitions(fullSchema);
            this.typeDefs += this.deduplicateTypeDefs(typeDefinitions.join(''));
        } else {
            const schemas = getAllArchetypeSchemas();
            for (const { graphqlSchema } of schemas) {
                const typeDefinitions = this.extractTypeDefinitions(graphqlSchema);
                this.typeDefs += this.deduplicateTypeDefs(typeDefinitions.join(''));
            }
        }
    }
    
    /**
     * Extract type definitions from a GraphQL schema string (V1's extractTypeDefinitions)
     */
    private extractTypeDefinitions(schemaString: string): string[] {
        const lines = schemaString.split('\n');
        const typeDefinitions: string[] = [];
        let currentType = '';
        let inTypeDefinition = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('type ') || trimmed.startsWith('input ') || trimmed.startsWith('enum ') || 
                trimmed.startsWith('scalar ') || trimmed.startsWith('interface ') || trimmed.startsWith('union ')) {
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
     * Deduplicate all type definitions (V1's deduplicateTypeDefs)
     */
    private deduplicateTypeDefs(typeDefs: string): string {
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
    
    visitScalarNode(node: ScalarNode): void {
        if (!this.definedTypes.has(node.id)) {
            this.typeDefs += `scalar ${node.name}\n`;
            this.definedTypes.add(node.id);
            logger.trace(`Added scalar type: ${node.name}`);
        }
    }
    
    visitTypeNode(node: TypeNode): void {
        if (!this.definedTypes.has(node.id)) {
            this.typeDefs += node.metadata.typeDef + '\n';
            this.definedTypes.add(node.id);
            logger.trace(`Added type definition: ${node.id}`);
        }
    }
    
    visitOperationNode(node: OperationNode): void {
        // operationType is a property of OperationNode, not in metadata
        const operationType = node.operationType;
        
        // Build proper field definition from metadata (V1 style)
        const fieldDef = this.buildFieldDefinition(node);
        
        // OperationType enum values are QUERY, MUTATION, SUBSCRIPTION (all caps)
        if (operationType === 'QUERY') {
            this.queryFields.push(fieldDef);
            logger.trace(`Added query field: ${fieldDef}`);
        } else if (operationType === 'MUTATION') {
            this.mutationFields.push(fieldDef);
            logger.trace(`Added mutation field: ${fieldDef}`);
        } else if (operationType === 'SUBSCRIPTION') {
            this.subscriptionFields.push(fieldDef);
            logger.trace(`Added subscription field: ${fieldDef}`);
        }
    }
    
    visitSubscriptionNode(node: SubscriptionNode): void {
        // Build proper field definition from metadata (V1 style)
        const fieldDef = this.buildFieldDefinition(node);
        
        this.subscriptionFields.push(fieldDef);
        logger.trace(`Added subscription field: ${fieldDef}`);
    }
    
    visitFieldNode(node: FieldNode): void {
        // Field nodes don't directly contribute to schema, they're used by resolvers
        logger.trace(`Visited field node: ${node.id}`);
    }
    
    visitInputNode(node: InputNode): void {
        // InputNodes are typically handled within operations
        logger.trace(`Visited input node: ${node.id}`);
    }
    
    /**
     * Build a complete GraphQL field definition exactly like V1.
     * Format: "fieldName(input: InputType!): OutputType"
     */
    private buildFieldDefinition(node: OperationNode | SubscriptionNode): string {
        const name = node.name;
        const { input, output, scalarTypes } = node.metadata;
        let fieldDef = name;
        
        // Handle input exactly like V1
        if (input) {
            const inputTypeName = `${name}Input`;
            
            // Check if input is a Zod schema
            if (input && typeof input === 'object' && '_def' in input) {
                // Generate input type from Zod schema using V1's logic
                // Note: generateInputTypeFromZod handles deduplication internally via this.definedTypes
                const inputTypeDef = this.generateInputTypeFromZod(input as ZodType, inputTypeName, scalarTypes || new Set());
                if (inputTypeDef) {
                    // Always add the typedef - generateInputTypeFromZod returns empty string if already defined
                    this.typeDefs += inputTypeDef;
                }
                
                // Determine nullability exactly like V1
                let inputNullability = '!';
                try {
                    const allowsUndefined = !!(input && typeof (input as any).safeParse === 'function' && (input as any).safeParse(undefined).success);
                    const allowsNull = !!(input && typeof (input as any).safeParse === 'function' && (input as any).safeParse(null).success);
                    if (allowsUndefined || allowsNull) inputNullability = '';
                } catch (e) {
                    inputNullability = '!';
                }
                
                fieldDef += `(input: ${inputTypeName}${inputNullability})`;
            } else if (typeof input === 'object') {
                // Legacy Record<string, GraphQLType> format
                const inputTypeDef = `input ${inputTypeName} {\n${Object.entries(input).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
                if (!this.definedTypes.has(inputTypeName)) {
                    this.typeDefs += inputTypeDef;
                    this.definedTypes.add(inputTypeName);
                }
                fieldDef += `(input: ${inputTypeName}!)`;
            }
        }
        
        // Handle output exactly like V1
        const outputType = this.extractOutputType(output);
        fieldDef += `: ${outputType}`;
        
        return fieldDef;
    }
    
    /**
     * Extract output type exactly like V1
     */
    private extractOutputType(output: any): string {
        if (typeof output === 'string') {
            return output;
        } else if (Array.isArray(output)) {
            // Handle array of archetypes: [serviceAreaArcheType]
            const archetypeInstance = output[0];
            const typeName = this.getArchetypeTypeName(archetypeInstance);
            if (typeName) {
                return `[${typeName}]`;
            } else {
                logger.warn(`Invalid array output type, expected archetype instance`);
                return '[Any]';
            }
        } else if (output instanceof BaseArcheType) {
            // Handle single archetype instance: serviceAreaArcheType
            const typeName = this.getArchetypeTypeName(output);
            if (typeName) {
                return typeName;
            } else {
                logger.warn(`Could not determine type name for archetype`);
                return 'Any';
            }
        } else if (typeof output === 'object' && output !== null) {
            // Legacy object output format - V1 would generate an output type
            // For now, return String as fallback (V1 would create outputName+"Output")
            return 'String';
        } else {
            // Default case when output is not specified - assume String (like V1)
            return 'String';
        }
    }
    
    /**
     * Get archetype type name exactly like V1's getArchetypeTypeName
     */
    private getArchetypeTypeName(archetypeInstance: any): string | null {
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
     * Generate input type from Zod schema exactly like V1
     * Returns the generated typedef string, or empty string if already defined
     */
    private generateInputTypeFromZod(zodSchema: ZodType, inputName: string, scalarTypes: Set<string>): string {
        try {
            // Store original input for validation (before any preprocessing)
            let originalInput: any = zodSchema;
            
            // Add __typename to input zod object, handling optional schemas
            let innerInput: any = zodSchema;
            const wasOptional = zodSchema instanceof z.ZodOptional;
            if (wasOptional) {
                innerInput = (zodSchema as any).unwrap();
            }
            
            // Preprocess schema: Replace z.union containing scalar literals with just the literal
            // This is needed because GQLoom's weave doesn't handle z.union well
            const shape = typeof innerInput._def?.shape === 'function' ? innerInput._def.shape() : innerInput._def?.shape;
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
            const input = wasOptional ? innerInput.optional() : innerInput;
            
            logger.trace(`Weaving Zod schema for ${inputName}`);
            const gqlInputSchema = weave(ZodWeaver, input as ZodType) as GraphQLSchema;
            const schemaString = printSchema(gqlInputSchema);
            logger.trace(`Schema string for ${inputName}: ${schemaString}`);
            
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
                inputTypeDefs = inputTypeDefs.replace(new RegExp(`(\\s+${fieldName}:\\s+)String!`, 'g'), `$1${scalarName}!`);
            }
            
            // Deduplicate input types - deduplicateInputTypes updates this.definedTypes and returns only new types
            const deduplicatedInputTypeDefs = this.deduplicateInputTypes(inputTypeDefs);
            
            logger.trace(`Successfully generated input types for ${inputName}`);
            return deduplicatedInputTypeDefs;
        } catch (error) {
            logger.error(`Failed to weave Zod schema for ${inputName}: ${error}`);
            logger.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`);
            // Fallback: generate basic input type only if not already defined
            if (!this.definedTypes.has(inputName)) {
                this.definedTypes.add(inputName);
                return `input ${inputName} { _placeholder: String }\n`;
            }
            return '';
        }
    }
    
    /**
     * Deduplicate input type definitions exactly like V1's deduplicateInputTypes
     */
    private deduplicateInputTypes(inputTypeDefs: string): string {
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
                if (inTypeDefinition && currentTypeName && !this.definedTypes.has(currentTypeName)) {
                    result.push(currentType);
                    this.definedTypes.add(currentTypeName);
                    logger.trace(`Added input type definition: ${currentTypeName}`);
                } else if (inTypeDefinition && currentTypeName && this.definedTypes.has(currentTypeName)) {
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
                    if (trimmed === '}' && !this.definedTypes.has(currentTypeName)) {
                        result.push(currentType);
                        this.definedTypes.add(currentTypeName);
                        logger.trace(`Added input type definition: ${currentTypeName}`);
                    } else if (trimmed === '}' && this.definedTypes.has(currentTypeName)) {
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
        if (inTypeDefinition && currentTypeName && !this.definedTypes.has(currentTypeName)) {
            result.push(currentType);
            this.definedTypes.add(currentTypeName);
            logger.trace(`Added input type definition: ${currentTypeName}`);
        }

        return result.join('');
    }
    
    /**
     * Get the complete typeDefs string exactly like V1
     */
    getTypeDefs(): string {
        // Only finalize once to avoid duplicating Query/Mutation/Subscription types
        if (!this.finalized) {
            // Add Query/Mutation/Subscription types
            if (this.queryFields.length > 0) {
                // Sort fields alphabetically (like V1)
                this.queryFields.sort();
                this.typeDefs += `type Query {\n${this.queryFields.map(f => `  ${f}`).join('\n')}\n}\n`;
            }
            
            if (this.mutationFields.length > 0) {
                // Sort fields alphabetically (like V1)
                this.mutationFields.sort();
                this.typeDefs += `type Mutation {\n${this.mutationFields.map(f => `  ${f}`).join('\n')}\n}\n`;
            }
            
            if (this.subscriptionFields.length > 0) {
                // Sort fields alphabetically (like V1)
                this.subscriptionFields.sort();
                this.typeDefs += `type Subscription {\n${this.subscriptionFields.map(f => `  ${f}`).join('\n')}\n}\n`;
            }
            
            this.finalized = true;
        }
        
        return this.typeDefs;
    }
    
    /**
     * Get results in the format expected by the orchestrator
     */
    getResults(): { typeDefs: string; inputTypes?: string; scalarTypes?: string[] } {
        return {
            typeDefs: this.getTypeDefs(),
            inputTypes: '',
            scalarTypes: []
        };
    }
}
