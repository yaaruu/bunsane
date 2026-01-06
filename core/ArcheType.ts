import type { BaseComponent, ComponentDataType } from "./components";
import type { ComponentPropertyMetadata } from "./metadata/definitions/Component";
import type { ArcheTypeFieldOptions, ArcheTypeFunctionMetadata } from "./metadata/definitions/ArcheType";
import type { GetEntityOptions } from "../types/archetype.types";
import { Entity } from "./Entity";
import { getMetadataStorage } from "./metadata";
import { z, ZodObject } from "zod";
import { weave } from "@gqloom/core";
import { ZodWeaver, asEnumType, asUnionType, asObjectType } from "@gqloom/zod";
import { printSchema } from "graphql";
import "reflect-metadata";
import { Query, type FilterSchema } from "../query";

export {asEnumType, asUnionType, asObjectType};

const primitiveTypes = [String, Number, Boolean, Date];

const archetypeFunctionsSymbol = Symbol.for("bunsane:archetypeFunctions");

export function ArcheTypeFunction(options?: { 
    returnType?: string;
    args?: Array<{ 
        name: string; 
        type: any; 
        nullable?: boolean;
    }>;
}) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeFunctionsSymbol]) {
            target[archetypeFunctionsSymbol] = [];
        }
        target[archetypeFunctionsSymbol].push({ propertyKey, options });
    };
}

const InputFilterSchema = z.object({
    field: z.string(),
    op: z.string().default("eq"),
    value: z.string(),
}).register(asObjectType, { name: "InputFilter" });

const customTypeRegistry = new Map<any, any>();
const customTypeNameRegistry = new Map<any, string>();
const registeredCustomTypes = new Map<string, any>();
const customTypeSilks = new Map<string, any>(); // Store silk types for unified weaving
const customTypeResolvers: any[] = []; // Store resolvers for custom types
const inputTypeRegistry = new Map<any, string>(); // Map from type to input type name (e.g., ST_Point -> ST_PointInput)

// Structural signature registry for input type deduplication
// Maps structural signature -> registered input type name
const structuralSignatureRegistry = new Map<string, string>();

// Import will be done lazily to avoid circular dependencies
let _generateZodStructuralSignature: ((schema: any) => string) | null = null;

function getSignatureGenerator(): (schema: any) => string {
    if (!_generateZodStructuralSignature) {
        const { generateZodStructuralSignature } = require('../gql/utils/TypeSignature');
        _generateZodStructuralSignature = generateZodStructuralSignature;
    }
    return _generateZodStructuralSignature!;
}

// Component-level schema cache
const componentSchemaCache = new Map<string, ZodObject<any>>(); // componentId -> Zod schema

// Enum schema cache to prevent duplicate registrations
const enumSchemaCache = new Map<string, any>(); // enumTypeName -> Zod enum schema

const archetypeSchemaCache = new Map<
    string,
    { zodSchema: ZodObject<any>; graphqlSchema: string }
>();
const allArchetypeZodObjects = new Map<string, ZodObject<any>>();

export function registerCustomZodType(
    type: any,
    schema: any,
    typeName?: string,
    inputTypeName?: string
) {
    // If a type name is provided and it's a ZodObject, add __typename to control GraphQL naming
    if (typeName && schema instanceof ZodObject) {
        // Extend the schema with __typename literal to control the GraphQL type name
        const shape = schema.shape;
        const namedSchema = z.object({
            __typename: z.literal(typeName).nullish(),
            ...shape,
        });
        customTypeRegistry.set(type, namedSchema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, namedSchema);
        }
        
        // Register input type if provided (for use in GraphQL arguments)
        if (inputTypeName) {
            // Create input type schema (without __typename, as input types don't have it)
            const inputSchema = z.object(shape).register(asObjectType, { name: inputTypeName });
            registeredCustomTypes.set(inputTypeName, inputSchema);
            inputTypeRegistry.set(type, inputTypeName);
            
            // Register structural signature for input type deduplication
            try {
                const generateSignature = getSignatureGenerator();
                const signature = generateSignature(z.object(shape));
                structuralSignatureRegistry.set(signature, inputTypeName);
            } catch (e) {
                // Signature registration is optional, don't fail if it errors
            }
        }
    } else {
        customTypeRegistry.set(type, schema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, schema);
        }
        
        // Register input type if provided
        if (inputTypeName && schema instanceof ZodObject) {
            const inputSchema = schema.register(asObjectType, { name: inputTypeName });
            registeredCustomTypes.set(inputTypeName, inputSchema);
            inputTypeRegistry.set(type, inputTypeName);
            
            // Register structural signature for input type deduplication
            try {
                const generateSignature = getSignatureGenerator();
                const signature = generateSignature(schema);
                structuralSignatureRegistry.set(signature, inputTypeName);
            } catch (e) {
                // Signature registration is optional, don't fail if it errors
            }
        }
    }
}

export function getArchetypeSchema(archetypeName: string, excludeRelations = false, excludeFunctions = false) {
    const cacheKey = `${archetypeName}_${excludeRelations}_${excludeFunctions}`;
    return archetypeSchemaCache.get(cacheKey);
}

export function getAllArchetypeSchemas() {
    return Array.from(archetypeSchemaCache.entries())
        .filter(([key]) => key.endsWith('_false_false'))
        .map(([, value]) => value);
}

export function getRegisteredCustomTypes() {
    return registeredCustomTypes;
}

/**
 * Find a matching registered input type for a given Zod schema based on structural equivalence.
 * This enables deduplication of input types that have the same structure but were created
 * through different transformations (.omit(), .extend(), etc.)
 * 
 * @param schema - The Zod schema to find a match for
 * @returns The registered input type name if found, null otherwise
 */
export function findMatchingInputType(schema: any): string | null {
    if (!schema) return null;
    
    try {
        const generateSignature = getSignatureGenerator();
        const signature = generateSignature(schema);
        return structuralSignatureRegistry.get(signature) || null;
    } catch (e) {
        return null;
    }
}

/**
 * Get the structural signature registry (for debugging/testing purposes)
 */
export function getStructuralSignatureRegistry(): Map<string, string> {
    return structuralSignatureRegistry;
}

export function weaveAllArchetypes() {
    // First, ensure all archetype schemas are generated
    const storage = getMetadataStorage();
    const archetypeNames: string[] = [];
    
    for (const archetypeMetadata of storage.archetypes) {
        const archetypeName = archetypeMetadata.name;
        archetypeNames.push(archetypeName);
        const fullSchemaCacheKey = `${archetypeName}_false_false`;
        if (!archetypeSchemaCache.has(fullSchemaCacheKey)) {
            try {
                const ArchetypeClass = archetypeMetadata.target as any;
                const instance = new ArchetypeClass();
                instance.getZodObjectSchema(); // Generate and cache the schema
            } catch (error) {
                console.warn(
                    `Could not generate schema for archetype ${archetypeName}:`,
                    error
                );
            }
        }
    }

    if (allArchetypeZodObjects.size === 0) {
        return null;
    }
    // Weave all archetype schemas together along with all component schemas
    // This ensures that nested component types are also included in the unified schema
    const archetypeSchemas = Array.from(allArchetypeZodObjects.values());
    const componentSchemas = Array.from(componentSchemaCache.values());

    // Combine both archetype and component schemas for weaving
    const allSchemas = archetypeSchemas;

    try {
        const schema = weave(ZodWeaver, ...allSchemas);
        let schemaString = printSchema(schema);

        // Add Date scalar if not present
        if (!schemaString.includes('scalar Date')) {
            schemaString = 'scalar Date\n\n' + schemaString;
        }

        // Post-process: Replace 'id: String' with 'id: ID' for all id fields
        schemaString = schemaString.replace(/\bid:\s*String\b/g, "id: ID");

        // Post-process: Replace date fields (start_at, end_at, created_at, updated_at, etc.) with Date scalar
        // Match common date field patterns
        schemaString = schemaString.replace(/\b(\w*_at|\w*_date|\w*Date|date\w*):\s*String(!?)/gi, (match, fieldName, nullable) => {
            return `${fieldName}: Date${nullable}`;
        });

        // Post-process: Replace relation String fields with proper GraphQL type references
        // Collect all relation metadata from all archetypes
        for (const archetypeMetadata of storage.archetypes) {
            const archetypeName = archetypeMetadata.name;
            try {
                const ArchetypeClass = archetypeMetadata.target as any;
                const instance = new ArchetypeClass();
                
                // Process each relation field
                for (const [field, relatedArcheType] of Object.entries(instance.relationMap)) {
                    const relationType = instance.relationTypes[field];
                    const isArray = relationType === "hasMany" || relationType === "belongsToMany";
                    
                    let relatedTypeName: string;
                    if (typeof relatedArcheType === "string") {
                        relatedTypeName = relatedArcheType;
                    } else {
                        const relatedArchetypeId = storage.getComponentId((relatedArcheType as any).name);
                        const relatedArchetypeMetadata = storage.archetypes.find(
                            (a) => a.typeId === relatedArchetypeId
                        );
                        relatedTypeName = relatedArchetypeMetadata?.name || (relatedArcheType as any).name.replace(/ArcheType$/, "");
                    }
                    
                    if (isArray) {
                        // Step 1: Add description if it doesn't exist
                        const hasDescription = new RegExp(`"""Reference to ${relatedTypeName} type"""[\\s\\S]{0,50}${field}:`).test(schemaString);
                        if (!hasDescription) {
                            const addDescPattern = new RegExp(
                                `(type ${archetypeName} \\{[\\s\\S]*?)(\\n\\s+)(${field}:\\s*\\[String!?\\]!?)`,
                                "g"
                            );
                            schemaString = schemaString.replace(
                                addDescPattern,
                                `$1$2"""Reference to ${relatedTypeName} type"""$2$3`
                            );
                        }
                        
                        // Step 2: Replace [String!] with [TypeName!]
                        const shouldBeRequired = instance.relationOptions[field]?.nullable === false;
                        const suffix = shouldBeRequired ? "!" : "";
                        const replacePattern = new RegExp(
                            `(type ${archetypeName} \\{[\\s\\S]*?${field}:\\s*)\\[String!?\\](!?)`,
                            "g"
                        );
                        schemaString = schemaString.replace(
                            replacePattern,
                            `$1[${relatedTypeName}!]${suffix}`
                        );
                    } else {
                        // Singular relations already have descriptions from Zod, just replace type
                        const pattern = new RegExp(
                            `(type ${archetypeName} \\{[\\s\\S]*?${field}:\\s*)String(!?)`,
                            "g"
                        );
                        const isNullable = instance.relationOptions[field]?.nullable;
                        const suffix = isNullable ? "" : "!";
                        schemaString = schemaString.replace(
                            pattern,
                            `$1${relatedTypeName}${suffix}`
                        );
                    }
                }
            } catch (error) {
                console.warn(`Could not process relations for archetype ${archetypeMetadata.name}:`, error);
            }

            // Process each function field
            if (archetypeMetadata.functions) {
                for (const { propertyKey, options } of archetypeMetadata.functions) {
                    
                    // Add arguments if present
                    if (options?.args && options.args.length > 0) {
                        const argDefs: string[] = [];
                        for (const arg of options.args) {
                            let argTypeName: string;
                            
                            const inputTypeName = inputTypeRegistry.get(arg.type);
                            if (inputTypeName) {
                                argTypeName = inputTypeName;
                            } else {
                                const registeredTypeName = customTypeNameRegistry.get(arg.type);
                                if (registeredTypeName) {
                                    argTypeName = registeredTypeName;
                                } else if (arg.type === String) {
                                    argTypeName = 'String';
                                } else if (arg.type === Number) {
                                    argTypeName = 'Float';
                                } else if (arg.type === Boolean) {
                                    argTypeName = 'Boolean';
                                } else if (arg.type === Date) {
                                    argTypeName = 'Date';
                                } else if (arg.type?.name) {
                                    argTypeName = arg.type.name;
                                } else {
                                    argTypeName = 'String';
                                }
                            }
                            
                            const nullable = arg.nullable ? '' : '!';
                            argDefs.push(`${arg.name}: ${argTypeName}${nullable}`);
                        }
                        
                        const argsString = argDefs.join(', ');
                        const escapedKey = propertyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        
                        // Pattern to add arguments: fieldName: Type -> fieldName(args): Type
                        // Capture leading whitespace separately to preserve it
                        const argPattern = new RegExp(
                            `(\\s+)(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                            'g'
                        );
                        
                        schemaString = schemaString.replace(
                            argPattern,
                            (match, leadingSpace, fieldDef, returnType) => {
                                return `${leadingSpace}${fieldDef.trim().replace(':', '')}(${argsString}): ${returnType.trim()}`;
                            }
                        );
                    }
                    
                    if (options?.returnType && !['string', 'number', 'boolean'].includes(options.returnType)) {
                        // Find the archetype type definition first
                        const typePattern = new RegExp(`type ${archetypeName}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
                        const typeMatch = typePattern.exec(schemaString);
                        
                        if (typeMatch) {
                            const typeBody = typeMatch[1]!;
                            
                            // Find the field line in the type body
                            const fieldIndex = typeBody.indexOf(`  ${propertyKey}`);
                            if (fieldIndex !== -1) {
                                const lineStart = fieldIndex;
                                const lineEnd = typeBody.indexOf('\n', fieldIndex);
                                const fieldLine = typeBody.substring(lineStart, lineEnd !== -1 ? lineEnd : typeBody.length);
                                
                                // Replace String with the actual return type in this line
                                const updatedLine = fieldLine.replace(/:\s*String(\??)(\s*)$/, `: ${options.returnType}$1$2`);
                                
                                if (updatedLine !== fieldLine) {
                                    // Replace in the full schema
                                    const fullFieldIndex = schemaString.indexOf(typeMatch[0]) + typeMatch[0].indexOf(fieldLine);
                                    schemaString = schemaString.substring(0, fullFieldIndex) + 
                                                 updatedLine + 
                                                 schemaString.substring(fullFieldIndex + fieldLine.length);
                                }
                            }
                        }
                    }
                }
            }
        }

        return schemaString;
    } catch (error) {
        console.warn(
            `Failed to weave all archetypes due to duplicate types.\n` +
            `Archetypes being processed: ${archetypeNames.join(', ')}\n` +
            `Error: ${error}`
        );
        return null;
    }
}

// Generate Zod schema for a component and cache it
function getOrCreateComponentSchema(
    componentCtor: new (...args: any[]) => BaseComponent,
    componentId: string,
    fieldOptions?: ArcheTypeFieldOptions
): any | null {
    // Check cache first
    if (componentSchemaCache.has(componentId)) {
        return componentSchemaCache.get(componentId)!;
    }

    const storage = getMetadataStorage();
    const props = storage.getComponentProperties(componentId);

    // Return null if no properties - caller should skip this component
    if (props.length === 0) {
        return null;
    }

    const zodFields: Record<string, any> = {
        __typename: z
            .literal(compNameToFieldName(componentCtor.name))
            .nullish(),
    };

    for (const prop of props) {
        if (prop.isPrimitive) {
            switch (prop.propertyType) {
                case String:
                    zodFields[prop.propertyKey] = z.string();
                    break;
                case Number:
                    zodFields[prop.propertyKey] = z.number();
                    break;
                case Boolean:
                    zodFields[prop.propertyKey] = z.boolean();
                    break;
                case Date:
                    zodFields[prop.propertyKey] = z.date();
                    break;
                default:
                    console.warn(`[ArcheType] Unknown primitive type for ${componentCtor.name}.${prop.propertyKey}: ${prop.propertyType?.name}. Falling back to z.string()`);
                    zodFields[prop.propertyKey] = z.string();
            }
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (prop.isEnum && prop.enumValues && prop.enumKeys) {
            const enumTypeName =
                prop.propertyType?.name ||
                `${componentCtor.name}_${prop.propertyKey}_Enum`;
            
            // Check if this enum has already been registered
            let enumSchema = enumSchemaCache.get(enumTypeName);
            
            if (!enumSchema) {
                // Register the enum for the first time
                enumSchema = z
                    .enum(prop.enumValues as any)
                    .register(asEnumType, {
                        name: enumTypeName,
                        valuesConfig: prop.enumKeys.reduce(
                            (
                                acc: Record<string, { description: string }>,
                                key,
                                idx
                            ) => {
                                acc[key] = { description: prop.enumValues![idx]! };
                                return acc;
                            },
                            {}
                        ),
                    });
                // Cache it for reuse
                enumSchemaCache.set(enumTypeName, enumSchema);
            }
            
            zodFields[prop.propertyKey] = enumSchema;
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (customTypeRegistry.has(prop.propertyType)) {
            zodFields[prop.propertyKey] = customTypeRegistry.get(
                prop.propertyType
            )!;
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (prop.arrayOf) {
            if (customTypeRegistry.has(prop.arrayOf)) {
                zodFields[prop.propertyKey] = z.array(customTypeRegistry.get(prop.arrayOf)!);
            } else if (primitiveTypes.includes(prop.arrayOf)) {
                if (prop.arrayOf === String) {
                    zodFields[prop.propertyKey] = z.array(z.string());
                } else if (prop.arrayOf === Number) {
                    zodFields[prop.propertyKey] = z.array(z.number());
                } else if (prop.arrayOf === Boolean) {
                    zodFields[prop.propertyKey] = z.array(z.boolean());
                } else if (prop.arrayOf === Date) {
                    zodFields[prop.propertyKey] = z.array(z.date());
                }
            } else {
                console.warn(`[ArcheType] Unknown array element type for ${componentCtor.name}.${prop.propertyKey}: ${prop.arrayOf?.name}. Falling back to z.array(z.string())`);
                zodFields[prop.propertyKey] = z.array(z.string());
            }
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
            }
        } else {
            console.warn(`[ArcheType] Unknown type for ${componentCtor.name}.${prop.propertyKey}: ${prop.propertyType?.name}. Falling back to z.string()`);
            zodFields[prop.propertyKey] = z.string();
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        }

        if (fieldOptions?.nullable) {
            zodFields[prop.propertyKey] = zodFields[prop.propertyKey].nullish();
        }
    }

    const componentSchema = z.object(zodFields);

    // Cache the component schema for reuse
    componentSchemaCache.set(componentId, componentSchema);

    return componentSchema;
}

function compNameToFieldName(compName: string): string {
    return (
        compName.charAt(0).toLowerCase() +
        compName.slice(1).replace(/Component$/, "Component")
    );
}

/**
 * Helper to determine if a component should be unwrapped to a scalar value.
 * Returns true if the component has a single 'value' property and the field type is primitive.
 */
function shouldUnwrapComponent(
    componentProps: ComponentPropertyMetadata[],
    fieldType: any
): boolean {
    // If field type is a primitive, unwrap the component to that primitive
    if (
        fieldType === String ||
        fieldType === Number ||
        fieldType === Boolean ||
        fieldType === Date
    ) {
        return true;
    }
    return false;
}

export type ArcheTypeOptions = {
    name?: string;
};

export interface RelationOptions {
    nullable?: boolean;
    foreignKey?: string;
    through?: string;
    cascade?: boolean;
}

export interface HasManyOptions extends RelationOptions {
    // Additional HasMany specific options
}

export interface BelongsToOptions extends RelationOptions {
    // Additional BelongsTo specific options
}

export interface HasOneOptions extends RelationOptions {
    // Additional HasOne specific options
}

export interface BelongsToManyOptions extends RelationOptions {
    through: string; // Required for many-to-many
}

export function ArcheType<T extends new () => BaseArcheType>(
    nameOrOptions?: string | ArcheTypeOptions
) {
    return function (target: T): T {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(target.name);

        let archetype_name = target.name;

        if (typeof nameOrOptions === "string") {
            archetype_name = nameOrOptions;
        } else if (nameOrOptions) {
            archetype_name = nameOrOptions.name || target.name;
        }

        storage.collectArcheTypeMetadata({
            name: archetype_name,
            typeId: typeId,
            target: target,
        });

        const prototype = target.prototype;
        const fields = prototype[archetypeFieldsSymbol];
        if (fields) {
            for (const { propertyKey, component, options } of fields) {
                const type = Reflect.getMetadata(
                    "design:type",
                    target.prototype,
                    propertyKey
                );
                storage.collectArchetypeField(
                    archetype_name,
                    propertyKey,
                    component,
                    options,
                    type
                );
            }
        }

        const unions = prototype[archetypeUnionFieldsSymbol];
        if (unions) {
            for (const { propertyKey, components, options } of unions) {
                storage.collectArchetypeUnion(
                    archetype_name,
                    propertyKey,
                    components,
                    options,
                    "union"
                );
            }
        }

        // Process relations
        const relations = prototype[archetypeRelationsSymbol];
        if (relations) {
            for (const {
                propertyKey,
                relatedArcheType,
                relationType,
                options,
            } of relations) {
                const type = Reflect.getMetadata(
                    "design:type",
                    target.prototype,
                    propertyKey
                );
                storage.collectArchetypeRelation(
                    archetype_name,
                    propertyKey,
                    relatedArcheType,
                    relationType,
                    options,
                    type
                );
            }
        }

        // Process functions
        const functions = prototype[archetypeFunctionsSymbol];
        if (functions) {
            storage.collectArcheTypeMetadata({
                name: archetype_name,
                typeId: typeId,
                target: target,
                functions: functions,
            });
        }

        return target;
    };
}

const archetypeFieldsSymbol = Symbol.for("bunsane:archetypeFields");
export function ArcheTypeField<T extends BaseComponent>(
    component: new (...args: any[]) => T,
    options?: ArcheTypeFieldOptions
) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeFieldsSymbol]) {
            target[archetypeFieldsSymbol] = [];
        }
        target[archetypeFieldsSymbol].push({ propertyKey, component, options });
    };
}

const archetypeUnionFieldsSymbol = Symbol.for("bunsane:archetypeUnionFields");
export function ArcheTypeUnionField(
    components: (new (...args: any[]) => any)[],
    options?: ArcheTypeFieldOptions
) {
    return function (target: any, propertyKey: string) {
        if (!target[archetypeUnionFieldsSymbol]) {
            target[archetypeUnionFieldsSymbol] = [];
        }
        target[archetypeUnionFieldsSymbol].push({
            propertyKey,
            components,
            options,
        });
    };
}

const archetypeRelationsSymbol = Symbol.for("bunsane:archetypeRelations");

function createRelationDecorator(
    relationType: "hasMany" | "belongsTo" | "hasOne" | "belongsToMany"
) {
    return function (relatedArcheType: string, options?: RelationOptions) {
        return function (target: any, propertyKey: string) {
            if (!target[archetypeRelationsSymbol]) {
                target[archetypeRelationsSymbol] = [];
            }
            target[archetypeRelationsSymbol].push({
                propertyKey,
                relatedArcheType,
                relationType,
                options,
            });
        };
    };
}

export const HasMany = createRelationDecorator("hasMany");
export const BelongsTo = createRelationDecorator("belongsTo");
export const HasOne = createRelationDecorator("hasOne");
export const BelongsToMany = createRelationDecorator("belongsToMany");

// Keep ArcheTypeRelation as alias for backwards compatibility
export const ArcheTypeRelation = HasMany;

export type ArcheTypeResolver = {
    resolver?: string;
    component?: new (...args: any[]) => BaseComponent;
    field?: string;
    filter?: { [key: string]: any };
};

export type ArcheTypeCreateInfo = {
    name: string;
    components: Array<new (...args: any[]) => BaseComponent>;
};

export type ArcheTypeOwnProperties<T extends BaseArcheType> = Omit<T, keyof BaseArcheType>;

export class BaseArcheType {
    protected components: Set<{
        ctor: new (...args: any[]) => BaseComponent;
        data: any;
    }> = new Set();
    public componentMap: Record<string, typeof BaseComponent> = {};
    protected fieldOptions: Record<string, ArcheTypeFieldOptions> = {};
    protected fieldTypes: Record<string, any> = {};
    public relationMap: Record<string, typeof BaseArcheType | string> = {};
    protected relationOptions: Record<string, RelationOptions> = {};
    protected relationTypes: Record<
        string,
        "hasMany" | "belongsTo" | "hasOne" | "belongsToMany"
    > = {};
    public unionMap: Record<string, (new (...args: any[]) => BaseComponent)[]> =
        {};
    protected unionOptions: Record<string, ArcheTypeFieldOptions> = {};
    public functions: Array<{ propertyKey: string; options?: { returnType?: string, args?: [{name: string, type: any, nullable: boolean}] } }> = [];

    public resolver?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor() {
        const storage = getMetadataStorage();
        const archetypeId = storage.getComponentId(this.constructor.name);

        // Look up the custom name from metadata (e.g., from @ArcheType("CustomName"))
        const archetypeMetadata = storage.archetypes.find(
            (a) => a.typeId === archetypeId
        );
        const archetypeName =
            archetypeMetadata?.name ||
            this.constructor.name.replace(/ArcheType$/, "");

        const fields = storage.archetypes_field_map.get(archetypeName);
        if (fields) {
            for (const { fieldName, component, options, type } of fields) {
                this.componentMap[fieldName] = component;
                if (options) this.fieldOptions[fieldName] = options;
                if (type) this.fieldTypes[fieldName] = type;
            }
        }

        const unions = storage.archetypes_union_map.get(archetypeName);
        if (unions) {
            for (const { fieldName, components, options, type } of unions) {
                this.unionMap[fieldName] = components;
                if (options) this.unionOptions[fieldName] = options;
            }
        }

        // Process relations
        const relations = storage.archetypes_relations_map.get(archetypeName);
        if (relations) {
            for (const {
                fieldName,
                relatedArcheType,
                relationType,
                options,
                type,
            } of relations) {
                this.relationMap[fieldName] = relatedArcheType as any;
                this.relationTypes[fieldName] = relationType;
                if (options) this.relationOptions[fieldName] = options;
            }
        }

        // Collect archetype functions
        this.functions = this.constructor.prototype[archetypeFunctionsSymbol] || [];
    }

    // constructor(components: Array<new (...args: any[]) => BaseComponent>) {
    //     for (const ctor of components) {
    //         this.componentMap[compNameToFieldName(ctor.name)] = ctor;
    //     }
    // }

    static ResolveField<T extends BaseComponent>(
        component: new (...args: any[]) => T,
        field: keyof T
    ): ArcheTypeResolver {
        return { component, field: field as string };
    }

    static Create(info: ArcheTypeCreateInfo): BaseArcheType {
        const archetype = new BaseArcheType();
        archetype.components = new Set();
        for (const ctor of info.components) {
            archetype.componentMap[compNameToFieldName(ctor.name)] = ctor;
        }
        return archetype;
    }

    private addComponent<T extends BaseComponent>(
        ctor: new (...args: any[]) => T,
        data: ComponentDataType<T>
    ) {
        this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        this.components.add({ ctor, data });
    }

    // TODO: Can we make this type-safe?
    public fill(input: object, strict: boolean = false): this {
        const storage = getMetadataStorage();

        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    const fieldType = this.fieldTypes[key];
                    const typeId = storage.getComponentId(compCtor.name);
                    const componentProps =
                        storage.getComponentProperties(typeId);

                    // Check if this is a primitive field that should be unwrapped
                    if (shouldUnwrapComponent(componentProps, fieldType)) {
                        // For primitive types, wrap in { value }
                        this.addComponent(compCtor, { value } as any);
                    } else {
                        // For complex types, pass data directly
                        this.addComponent(compCtor, value as any);
                    }
                } else if (this.unionMap[key]) {
                    // Handle union fields
                    const unionComponents = this.unionMap[key];
                    const selectedComponent = this.determineUnionComponent(
                        value,
                        unionComponents,
                        storage
                    );

                    if (selectedComponent) {
                        this.addComponent(selectedComponent, value as any);
                    } else if (strict) {
                        throw new Error(
                            `Could not determine component type for union field '${key}'`
                        );
                    }
                } else {
                    // direct property
                    (this as any)[key] = value;
                }
            }
        }
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const alreadyAdded = Array.from(this.components).some(
                (c) => c.ctor === ctor
            );
            if (!alreadyAdded) {
                this.addComponent(ctor, {} as any);
            }
        }

        return this;
    }

    /**
     * Determines which component in a union should be used based on the input data.
     * @param value The input data for the union field
     * @param unionComponents Array of possible component constructors
     * @param storage Metadata storage
     * @returns The selected component constructor, or null if none match
     */
    private determineUnionComponent(
        value: any,
        unionComponents: (new (...args: any[]) => BaseComponent)[],
        storage: any
    ): (new (...args: any[]) => BaseComponent) | null {
        // If value has __typename, use it to determine the component
        if (value && typeof value === "object" && value.__typename) {
            const expectedTypeName = value.__typename;
            for (const component of unionComponents) {
                const componentTypeName = compNameToFieldName(component.name);
                if (componentTypeName === expectedTypeName) {
                    return component;
                }
            }
        }

        // Fallback: Try to infer based on property presence
        if (value && typeof value === "object") {
            for (const component of unionComponents) {
                const typeId = storage.getComponentId(component.name);
                const componentProps = storage.getComponentProperties(typeId);

                // Check if any properties of this component are present in the value
                const hasMatchingProps = componentProps.some(
                    (prop: ComponentPropertyMetadata) =>
                        value.hasOwnProperty(prop.propertyKey)
                );

                if (hasMatchingProps) {
                    return component;
                }
            }
        }

        // If no component matches, return the first one as default
        return unionComponents[0] || null;
    }
    async updateEntity<T>(entity: Entity, updates: Partial<T>) {
        const storage = getMetadataStorage();

        for (const key of Object.keys(updates)) {
            if (key === "id" || key === "_id") continue;
            const value = updates[key as keyof T];
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    const fieldType = this.fieldTypes[key];
                    const typeId = storage.getComponentId(compCtor.name);
                    const componentProps =
                        storage.getComponentProperties(typeId);

                    // Check if this is a primitive field that should be unwrapped
                    if (shouldUnwrapComponent(componentProps, fieldType)) {
                        // For primitive types, wrap in { value }
                        await entity.set(compCtor, { value });
                    } else {
                        // For complex types, pass data directly
                        await entity.set(compCtor, value as any);
                    }
                } else if (this.unionMap[key]) {
                    // Handle union fields
                    const unionComponents = this.unionMap[key];
                    const selectedComponent = this.determineUnionComponent(
                        value,
                        unionComponents,
                        storage
                    );

                    if (selectedComponent) {
                        await entity.set(selectedComponent, value as any);
                    }
                } else {
                    // direct, set on archetype
                    (this as any)[key] = value;
                }
            }
        }
        return entity;
    }

    /**
     * Creates a new entity with all the predefined components from this archetype.
     * @returns A new Entity instance with all archetype components added
     */
    public createEntity(): Entity {
        const entity = Entity.Create();
        for (const { ctor, data } of this.components) {
            entity.add(ctor, data);
        }
        return entity;
    }

    /**
     * Creates a new entity and immediately saves it to the database.
     * @returns A promise that resolves to the saved Entity
     */
    public async createAndSaveEntity(): Promise<Entity> {
        const entity = this.createEntity();
        await entity.save();
        return entity;
    }

    /**
     * Retrieves an entity by ID and populates it with all components defined in this archetype.
     * 
     * @param id The entity ID to retrieve
     * @param options Optional configuration for component loading and behavior
     * @returns A promise that resolves to the populated Entity or null if not found
     * 
     * @example
     * // Basic usage
     * const serviceArea = await serviceAreaArcheType.getEntityWithID('uuid-123');
     * 
     * @example
     * // With options
     * const serviceArea = await serviceAreaArcheType.getEntityWithID('uuid-123', {
     *   includeComponents: ['info', 'label'],
     *   populateRelations: true,
     *   throwOnNotFound: true
     * });
     */
    public async getEntityWithID(id: string, options?: GetEntityOptions): Promise<Entity | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            if (options?.throwOnNotFound) {
                throw new Error(`Invalid entity ID provided: "${id}"`);
            }
            return null;
        }
        
        const { Query } = await import("../query");
        
        // Build query with selected components for batch loading
        let query = new Query().findById(id);
        
        // Determine which components to load
        const componentsToLoad = this.getComponentsToLoad(options);
        
        for (const componentCtor of componentsToLoad) {
            query = query.with(componentCtor as any);
        }
        
        const entities = await query.exec();
        if (entities.length === 0) {
            if (options?.throwOnNotFound) {
                throw new Error(`Entity with ID ${id} not found`);
            }
            return null;
        }
        
        const entity = entities[0]!;
        
        // Populate relations if requested
        if (options?.populateRelations) {
            await this.populateRelations(entity);
        }
        
        return entity;
    }

    /**
     * Determines which components should be loaded based on the options.
     * @param options The options specifying component inclusion/exclusion
     * @returns Array of component constructors to load
     */
    private getComponentsToLoad(options?: GetEntityOptions): (new (...args: any[]) => BaseComponent)[] {
        let componentsToLoad: (new (...args: any[]) => BaseComponent)[] = [];

        // Start with all regular components
        componentsToLoad.push(...Object.values(this.componentMap));

        // Add union components
        for (const componentCtors of Object.values(this.unionMap)) {
            componentsToLoad.push(...componentCtors);
        }

        // Apply include filter
        if (options?.includeComponents) {
            const includeSet = new Set(options.includeComponents);
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                return includeSet.has(fieldName);
            });
        }

        // Apply exclude filter
        if (options?.excludeComponents) {
            const excludeSet = new Set(options.excludeComponents);
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                return !excludeSet.has(fieldName);
            });
        }

        // Respect nullable options (skip nullable components by default unless explicitly included)
        if (!options?.includeComponents) {
            componentsToLoad = componentsToLoad.filter(ctor => {
                const fieldName = compNameToFieldName(ctor.name);
                const isNullable = this.fieldOptions[fieldName]?.nullable === true;
                return !isNullable;
            });
        }

        return componentsToLoad;
    }

    /**
     * Populates relations for the given entity.
     * @param entity The entity to populate relations for
     */
    private async populateRelations(entity: Entity): Promise<void> {
        const { Query } = await import("../query");
        const storage = getMetadataStorage();

        for (const [fieldName, relatedArchetype] of Object.entries(this.relationMap)) {
            const relationType = this.relationTypes[fieldName];
            const relationOptions = this.relationOptions[fieldName];

            if (relationType === "belongsTo") {
                // For belongsTo, load the related entity using foreign key
                const foreignKey = relationOptions?.foreignKey;
                if (foreignKey) {
                    let foreignId: string | undefined;

                    // Get foreign key value from entity's components
                    if (foreignKey.includes('.')) {
                        const [fieldName, propName] = foreignKey.split('.');
                        const compCtor = this.componentMap[fieldName!];
                        if (compCtor) {
                            const componentInstance = await entity.get(compCtor as any);
                            if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                                foreignId = (componentInstance as any)[propName!];
                            }
                        }
                    } else {
                        for (const compCtor of Object.values(this.componentMap)) {
                            const typeId = storage.getComponentId(compCtor.name);
                            const componentProps = storage.getComponentProperties(typeId);
                            const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                            if (!hasForeignKey) continue;
                            
                            const componentInstance = await entity.get(compCtor as any);
                            if (componentInstance && (componentInstance as any)[foreignKey] !== undefined) {
                                foreignId = (componentInstance as any)[foreignKey];
                                break;
                            }
                        }
                    }

                    if (!foreignId && foreignKey === 'id') {
                        foreignId = entity.id;
                    }

                    if (foreignId) {
                        // Load related entity
                        let relatedArchetypeInstance: BaseArcheType;
                        if (typeof relatedArchetype === "function") {
                            relatedArchetypeInstance = new (relatedArchetype as any)();
                        } else {
                            // Find archetype by name
                            const relatedArchetypeMetadata = storage.archetypes.find((a) => a.name === relatedArchetype);
                            if (relatedArchetypeMetadata) {
                                relatedArchetypeInstance = new (relatedArchetypeMetadata.target as any)();
                            } else {
                                continue;
                            }
                        }

                        const relatedEntity = await relatedArchetypeInstance.getEntityWithID(foreignId);
                        if (relatedEntity) {
                            // Attach as computed property (non-persisted)
                            (entity as any)[fieldName] = relatedEntity;
                        }
                    }
                }
            } else if (relationType === "hasMany") {
                // For hasMany, query related entities that reference this entity
                const foreignKey = relationOptions?.foreignKey;
                if (foreignKey) {
                    let relatedArchetypeInstance: BaseArcheType;
                    if (typeof relatedArchetype === "function") {
                        relatedArchetypeInstance = new (relatedArchetype as any)();
                    } else {
                        const relatedArchetypeMetadata = storage.archetypes.find((a) => a.name === relatedArchetype);
                        if (relatedArchetypeMetadata) {
                            relatedArchetypeInstance = new (relatedArchetypeMetadata.target as any)();
                        } else {
                            continue;
                        }
                    }

                    // Find the component in related archetype that has the foreign key
                    let foreignKeyComponent: any = null;
                    for (const compCtor of Object.values(relatedArchetypeInstance.componentMap)) {
                        const typeId = storage.getComponentId(compCtor.name);
                        const componentProps = storage.getComponentProperties(typeId);
                        const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                        if (hasForeignKey) {
                            foreignKeyComponent = compCtor;
                            break;
                        }
                    }

                    if (foreignKeyComponent) {
                        // Query related entities
                        const relatedEntities = await new Query()
                            .with(foreignKeyComponent)
                            .exec();

                        // Filter entities that reference this entity
                        const matchingEntities: Entity[] = [];
                        for (const relatedEntity of relatedEntities) {
                            const componentInstance = await relatedEntity.get(foreignKeyComponent);
                            if (componentInstance && (componentInstance as any)[foreignKey] === entity.id) {
                                matchingEntities.push(relatedEntity);
                            }
                        }

                        // Attach as computed property
                        (entity as any)[fieldName] = matchingEntities;
                    }
                }
            }
            // Note: hasOne and belongsToMany not implemented yet
        }
    }

    /**
     * Static convenience method to get an entity with ID using an archetype class.
     * 
     * @param archetypeClass The archetype class to use for loading
     * @param id The entity ID to retrieve
     * @param options Optional configuration for component loading and behavior
     * @returns A promise that resolves to the populated Entity or null if not found
     * 
     * @example
     * // Using static method
     * const serviceArea = await BaseArcheType.getEntityWithID(ServiceAreaArcheTypeClass, 'uuid-123');
     */
    static async getEntityWithID<T extends BaseArcheType>(
        archetypeClass: new () => T,
        id: string,
        options?: GetEntityOptions
    ): Promise<Entity | null> {
        const instance = new archetypeClass();
        return instance.getEntityWithID(id, options);
    }

    /**
     * Unwraps an entity into a plain object containing the component data.
     * @param entity The entity to unwrap
     * @param exclude An optional array of field names to exclude from the result (e.g., sensitive data like passwords)
     * @returns A promise that resolves to an object with component data
     */
    public async Unwrap(
        entity: Entity,
        exclude: string[] = []
    ): Promise<Record<string, any>> {
        const result: any = { id: entity.id };

        // Handle regular components
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            if (exclude.includes(field)) continue;
            const comp = await entity.get(ctor as any);
            if (comp) {
                result[field] = (comp as any).value;
            }
        }

        // Handle union fields
        for (const [field, components] of Object.entries(this.unionMap)) {
            if (exclude.includes(field)) continue;
            for (const component of components) {
                const comp = await entity.get(component);
                if (comp) {
                    result[field] = {
                        __typename: compNameToFieldName(component.name),
                        ...(comp as any),
                    };
                    break; // Only take the first matching component
                }
            }
        }

        // for direct fields
        for (const field of Object.keys(this.fieldTypes)) {
            if (exclude.includes(field)) continue;
            if (!this.componentMap[field] && !this.unionMap[field]) {
                result[field] = (this as any)[field];
            }
        }
        return result;
    }

    /**
     * Gets the property metadata for all components in this archetype.
     * @returns A record mapping field names to their component property metadata arrays
     */
    public getComponentProperties(): Record<
        string,
        ComponentPropertyMetadata[]
    > {
        const storage = getMetadataStorage();
        const result: Record<string, ComponentPropertyMetadata[]> = {};

        // Regular components
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const typeId = storage.getComponentId(ctor.name);
            result[field] = storage.getComponentProperties(typeId);
        }

        // Union components (for each union field, include properties of all components)
        for (const [field, components] of Object.entries(this.unionMap)) {
            const allProps: ComponentPropertyMetadata[] = [];
            for (const component of components) {
                const typeId = storage.getComponentId(component.name);
                allProps.push(...storage.getComponentProperties(typeId));
            }
            result[field] = allProps;
        }

        return result;
    }

    /**
     * Helper to ensure we have a proper Entity instance for resolvers.
     * Handles cases where parent comes from GraphQL chain as a plain object.
     */
    private static async ensureEntity(parent: any, context: any): Promise<Entity> {
        if (parent instanceof Entity) {
            return parent;
        }
        if (parent && parent.id) {
            // Try to load via DataLoader first
            if (context?.loaders?.entityById) {
                const loaded = await context.loaders.entityById.load(parent.id);
                if (loaded) return loaded;
            }
            // Fallback: create Entity instance
            const entity = new Entity(parent.id);
            entity.setPersisted(true);
            return entity;
        }
        throw new Error('Invalid parent object: missing id property');
    }

    /**
     * Generates GraphQL field resolver functions for this archetype.
     * These resolvers handle both simple fields and component-based fields with DataLoader support.
     *
     * @returns An array of resolver metadata that can be registered with GraphQL
     *
     * @example
     * const resolvers = serviceAreaArcheType.generateFieldResolvers();
     * // Returns array of: { typeName, fieldName, resolver }
     */
    public generateFieldResolvers(): Array<{
        typeName: string;
        fieldName: string;
        resolver: (parent: any, args: any, context: any) => any;
    }> {
        const storage = getMetadataStorage();
        const resolvers: Array<any> = [];
        const archetypeId = storage.getComponentId(this.constructor.name);
        const archetypeName =
            storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
            this.constructor.name;

        // Generate ID resolver for the main archetype type
        resolvers.push({
            typeName: archetypeName,
            fieldName: "id",
            resolver: (parent: any) => {
                return parent.id;
            },
        });

        // Generate resolvers for each component field
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const typeId = storage.getComponentId(ctor.name);
            const typeIdHex = typeId;
            const componentName = ctor.name;
            const fieldType = this.fieldTypes[field];

            // Skip components with no properties (like tag components)
            const componentProps = storage.getComponentProperties(typeId);
            if (componentProps.length === 0) {
                continue;
            }

            // Check if this component should be unwrapped to a scalar
            const isUnwrapped = shouldUnwrapComponent(
                componentProps,
                fieldType
            );

            if (isUnwrapped) {
                // For unwrapped components, resolve directly to the 'value' property
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (
                        parent: any,
                        args: any,
                        context: any
                    ) => {
                        const entityId = parent?.id;
                        if (!entityId) return (parent as any)[field];

                        // Use DataLoader if available
                        if (context?.loaders?.componentsByEntityType) {
                            const componentData =
                                await context.loaders.componentsByEntityType.load(
                                    {
                                        entityId: entityId,
                                        typeId: typeIdHex,
                                    }
                                );
                            if (componentData?.data?.value !== undefined) {
                                return componentData.data.value;
                            }
                        }

                        // Fallback: ensure we have an Entity and query directly
                        const entity = await BaseArcheType.ensureEntity(parent, context);
                        const comp = await entity.get(ctor);
                        return (comp as any)?.value;
                    },
                });
            } else {
                // For complex components, return the full component object
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (
                        parent: any,
                        args: any,
                        context: any
                    ) => {
                        const entityId = parent?.id;
                        if (!entityId) return (parent as any)[field];

                        // Check if parent is an Entity with the component already loaded in memory
                        // This avoids cache/DataLoader issues for freshly created entities
                        if (parent instanceof Entity) {
                            const inMemoryComp = await parent.getInstanceOf(ctor);
                            if (inMemoryComp) {
                                return inMemoryComp;
                            }
                        }

                        // Use DataLoader if available
                        if (context?.loaders?.componentsByEntityType) {
                            const componentData =
                                await context.loaders.componentsByEntityType.load(
                                    {
                                        entityId: entityId,
                                        typeId: typeIdHex,
                                    }
                                );
                            if (componentData?.data) {
                                return componentData.data;
                            }
                        }

                        // Fallback: ensure we have an Entity and query directly
                        const entity = await BaseArcheType.ensureEntity(parent, context);
                        const comp = await entity.get(ctor);
                        return comp;
                    },
                });

                // Generate nested field resolvers for component properties
                const componentTypeName = compNameToFieldName(componentName);

                for (const prop of componentProps) {
                    resolvers.push({
                        typeName: componentTypeName, // Use lowercase component name
                        fieldName: prop.propertyKey,
                        resolver: (parent: any) => parent[prop.propertyKey],
                    });
                }
            }
        }

        // Generate resolvers for union fields
        for (const [field, components] of Object.entries(this.unionMap)) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: any, args: any, context: any) => {
                    const entityId = parent?.id;
                    if (!entityId) return null;

                    // Try to find which component in the union is present on the entity
                    for (const component of components) {
                        const typeId = storage.getComponentId(component.name);

                        if (context?.loaders?.componentsByEntityType) {
                            const componentData =
                                await context.loaders.componentsByEntityType.load(
                                    {
                                        entityId: entityId,
                                        typeId: typeId,
                                    }
                                );
                            if (componentData?.data) {
                                // Add __typename for GraphQL union resolution
                                return {
                                    __typename: compNameToFieldName(
                                        component.name
                                    ),
                                    ...componentData.data,
                                };
                            }
                        } else {
                            // Fallback: ensure we have an Entity and query directly
                            const entity = await BaseArcheType.ensureEntity(parent, context);
                            const comp = await entity.get(component);
                            if (comp) {
                                return {
                                    __typename: compNameToFieldName(component.name),
                                    ...(comp as any),
                                };
                            }
                        }
                    }

                    return null;
                },
            });
        }

        // Generate resolvers for relation fields
        for (const [field, relatedArcheType] of Object.entries(
            this.relationMap
        )) {
            const relationType = this.relationTypes[field];
            const relationOptions = this.relationOptions[field];
            const isArray =
                relationType === "hasMany" || relationType === "belongsToMany";

            // Get the related archetype name
            let relatedTypeName: string;
            if (typeof relatedArcheType === "string") {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(
                    relatedArcheType.name
                );
                const relatedArchetypeMetadata = storage.archetypes.find(
                    (a) => a.typeId === relatedArchetypeId
                );
                relatedTypeName =
                    relatedArchetypeMetadata?.name ||
                    relatedArcheType.name.replace(/ArcheType$/, "");
            }

            if (
                !isArray &&
                relationType === "belongsTo" &&
                relationOptions?.foreignKey
            ) {
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (
                        parent: any,
                        args: any,
                        context: any
                    ) => {
                        const entityId = parent?.id;
                        if (!entityId) {
                            return null;
                        }

                        let foreignId: string | undefined;

                        // Attempt to load the component that holds the foreign key via DataLoader
                        if (context?.loaders?.componentsByEntityType) {
                            const foreignKey = relationOptions.foreignKey;
                            if (foreignKey && foreignKey.includes('.')) {
                                // Handle nested foreign key like "field.property"
                                const [fieldName, propName] = foreignKey.split('.');
                                const compCtor = this.componentMap[fieldName!];
                                if (compCtor) {
                                    const typeIdForComponent = storage.getComponentId(compCtor.name);
                                    const componentData = await context.loaders.componentsByEntityType.load({
                                        entityId: entityId,
                                        typeId: typeIdForComponent,
                                    });
                                    if (componentData?.data && componentData.data[propName!] !== undefined) {
                                        foreignId = componentData.data[propName!];
                                    }
                                }
                            } else {
                                // Original logic for flat foreign key
                                for (const [componentField, compCtor] of Object.entries(this.componentMap)) {
                                    const typeIdForComponent = storage.getComponentId(compCtor.name);
                                    const componentProps = storage.getComponentProperties(typeIdForComponent);
                                    const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                    if (!hasForeignKey || !foreignKey) continue;

                                    const componentData = await context.loaders.componentsByEntityType.load({
                                        entityId: entityId,
                                        typeId: typeIdForComponent,
                                    });

                                    if (componentData?.data && componentData.data[foreignKey] !== undefined) {
                                        foreignId = componentData.data[foreignKey];
                                        break;
                                    }
                                }
                            }
                        }

                        // Fallback: pull the component from the entity directly when DataLoader misses
                        if (!foreignId) {
                            const entity = await BaseArcheType.ensureEntity(parent, context);
                            const foreignKey = relationOptions.foreignKey;
                            if (foreignKey && foreignKey.includes('.')) {
                                // Handle nested foreign key like "field.property"
                                const [fieldName, propName] = foreignKey.split('.');
                                const compCtor = this.componentMap[fieldName!];
                                if (compCtor) {
                                    const componentInstance = await entity.get(compCtor as any);
                                    if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                                        foreignId = (componentInstance as any)[propName!];
                                    }
                                }
                            } else {
                                // Original logic for flat foreign key
                                for (const compCtor of Object.values(this.componentMap)) {
                                    const typeIdForComponent = storage.getComponentId(compCtor.name);
                                    const componentProps = storage.getComponentProperties(typeIdForComponent);
                                    const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                    if (!hasForeignKey || !foreignKey) continue;
                                    const componentInstance = await entity.get(compCtor as any);
                                    if (componentInstance && (componentInstance as any)[foreignKey] !== undefined) {
                                        foreignId = (componentInstance as any)[foreignKey];
                                        break;
                                    }
                                }
                            }
                        }

                        if (!foreignId && relationOptions.foreignKey === 'id') {
                            foreignId = entityId;
                        }

                        if (!foreignId) {
                            return null;
                        }

                        // Resolve the related entity using loaders when possible, otherwise hit the database directly
                        if (context.loaders?.entityById) {
                            const relatedEntity =
                                await context.loaders.entityById.load(
                                    foreignId
                                );
                            if (relatedEntity) {
                                return relatedEntity;
                            }
                        }

                        return Entity.FindById(foreignId);
                    },
                });
            } else if (isArray) {
                // Array relation resolver
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (
                        parent: any,
                        args: any,
                        context: any
                    ) => {
                        const entityId = parent?.id;
                        if (!entityId) return [];

                        // If foreignKey is specified, for hasMany, the foreign key is on the related entity
                        if (relationOptions?.foreignKey) {
                            // Find the component that has the foreign key (may be nested like "field.property")
                            let componentCtor: any = null;
                            let foreignKeyField: string = relationOptions.foreignKey;
                            let relatedArchetypeInstance: any = null;
                            
                            if (typeof relatedArcheType === "function") {
                                relatedArchetypeInstance = new (relatedArcheType as any)();
                            } else if (typeof relatedArcheType === "string") {
                                // Find the archetype class by name
                                const relatedArchetypeMetadata = storage.archetypes.find((a) => a.name === relatedArcheType);
                                if (relatedArchetypeMetadata) {
                                    relatedArchetypeInstance = new (relatedArchetypeMetadata.target as any)();
                                }
                            }
                            
                            if (relatedArchetypeInstance) {
                                if (relationOptions.foreignKey.includes('.')) {
                                    const [fieldName, propName] = relationOptions.foreignKey.split('.');
                                    componentCtor = relatedArchetypeInstance.componentMap[fieldName!];
                                    foreignKeyField = propName!;
                                } else {
                                    // Flat foreign key
                                    for (const comp of Object.values(relatedArchetypeInstance.componentMap) as any[]) {
                                        const typeId = storage.getComponentId(comp.name);
                                        const props = storage.getComponentProperties(typeId);
                                        if (props.some(p => p.propertyKey === relationOptions.foreignKey)) {
                                            componentCtor = comp;
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            if (componentCtor) {
                                const query = new Query();
                                query.with(componentCtor, Query.filters(Query.filter(foreignKeyField, Query.filterOp.EQ, entityId)));
                                return await query.exec();
                            } else {
                                console.warn(`No component found with foreign key ${relationOptions.foreignKey} in ${relatedTypeName}`);
                                return [];
                            }
                        } else {
                            // Use DataLoader for relation loading if available
                            if (
                                context?.loaders?.relationsByEntityField
                            ) {
                                return context.loaders.relationsByEntityField.load({
                                    entityId: entityId,
                                    relationField: field,
                                    relatedType: relatedTypeName,
                                    foreignKey: relationOptions?.foreignKey,
                                });
                            }

                            // Fallback: return empty array or implement custom relation query
                            // This should be implemented based on your relation storage strategy
                            console.warn(
                                `No relationsByEntityField loader found for array relation ${field} on ${archetypeName}`
                            );
                            return [];
                        }
                    },
                });
            } else {
                // Single relation resolver
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (
                        parent: any,
                        args: any,
                        context: any
                    ) => {
                        const entityId = parent?.id;

                        // If foreignKey is specified, treat as belongsTo (foreign key on this entity)
                        if (relationOptions?.foreignKey) {
                            if (!entityId) {
                                return null;
                            }

                            let foreignId: string | undefined;

                            // Attempt to load the component that holds the foreign key via DataLoader
                            if (context?.loaders?.componentsByEntityType) {
                                const foreignKey = relationOptions.foreignKey;
                                if (foreignKey && foreignKey.includes('.')) {
                                    // Handle nested foreign key like "field.property"
                                    const [fieldName, propName] = foreignKey.split('.');
                                    const compCtor = this.componentMap[fieldName!];
                                    if (compCtor) {
                                        const typeIdForComponent = storage.getComponentId(compCtor.name);
                                        const componentData = await context.loaders.componentsByEntityType.load({
                                            entityId: entityId,
                                            typeId: typeIdForComponent,
                                        });
                                        if (componentData?.data && componentData.data[propName!] !== undefined) {
                                            foreignId = componentData.data[propName!];
                                        }
                                    }
                                } else {
                                    // Original logic for flat foreign key
                                    for (const [componentField, compCtor] of Object.entries(this.componentMap)) {
                                        const typeIdForComponent = storage.getComponentId(compCtor.name);
                                        const componentProps = storage.getComponentProperties(typeIdForComponent);
                                        const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                        if (!hasForeignKey || !foreignKey) continue;

                                        const componentData = await context.loaders.componentsByEntityType.load({
                                            entityId: entityId,
                                            typeId: typeIdForComponent,
                                        });

                                        if (componentData?.data && componentData.data[foreignKey] !== undefined) {
                                            foreignId = componentData.data[foreignKey];
                                            break;
                                        }
                                    }
                                }
                            }

                            // Fallback: pull the component from the entity directly when DataLoader misses
                            if (!foreignId) {
                                const entity = await BaseArcheType.ensureEntity(parent, context);
                                const foreignKey = relationOptions.foreignKey;
                                if (foreignKey && foreignKey.includes('.')) {
                                    // Handle nested foreign key like "field.property"
                                    const [fieldName, propName] = foreignKey.split('.');
                                    const compCtor = this.componentMap[fieldName!];
                                    if (compCtor) {
                                        const componentInstance = await entity.get(compCtor as any);
                                        if (componentInstance && (componentInstance as any)[propName!] !== undefined) {
                                            foreignId = (componentInstance as any)[propName!];
                                        }
                                    }
                                } else {
                                    // Original logic for flat foreign key
                                    for (const compCtor of Object.values(this.componentMap)) {
                                        const typeIdForComponent = storage.getComponentId(compCtor.name);
                                        const componentProps = storage.getComponentProperties(typeIdForComponent);
                                        const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);
                                        if (!hasForeignKey || !foreignKey) continue;
                                        const componentInstance = await entity.get(compCtor as any);
                                        if (componentInstance && (componentInstance as any)[foreignKey] !== undefined) {
                                            foreignId = (componentInstance as any)[foreignKey];
                                            break;
                                        }
                                    }
                                }
                            }

                            if (!foreignId) {
                                return null;
                            }

                            // Resolve the related entity using loaders when possible, otherwise hit the database directly
                            if (context?.loaders?.entityById) {
                                const relatedEntity = await context.loaders.entityById.load(foreignId);
                                if (relatedEntity) {
                                    return relatedEntity;
                                }
                            }

                            return Entity.FindById(foreignId);
                        } else {
                            // Use DataLoader for relation loading if available
                            if (
                                context?.loaders?.relationsByEntityField
                            ) {
                                const results =
                                    await context.loaders.relationsByEntityField.load(
                                        {
                                            entityId: entityId,
                                            relationField: field,
                                            relatedType: relatedTypeName,
                                            foreignKey: relationOptions?.foreignKey,
                                        }
                                    );
                                if (results.length > 0) {
                                    return results[0];
                                }
                            }

                            // Fallback: return null or implement custom relation query
                            console.warn(
                                `No relationsByEntityField loader found for single relation ${field} on ${archetypeName}`
                            );
                            return null;
                        }
                    },
                });
            }
        }

        // Generate resolvers for archetype functions
        for (const { propertyKey, options } of this.functions) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: propertyKey,
                resolver: async (parent: any, args: any, context: any) => {
                    // Ensure parent is a proper Entity instance
                    // When coming from cache or GraphQL chain, parent might be a plain object
                    let entity: Entity;
                    if (parent instanceof Entity) {
                        entity = parent;
                    } else if (parent && parent.id) {
                        // Parent is a plain object with an ID - load the entity
                        if (context.loaders?.entityById) {
                            const loadedEntity = await context.loaders.entityById.load(parent.id);
                            if (loadedEntity) {
                                entity = loadedEntity;
                            } else {
                                // Create a new Entity instance with the ID
                                entity = new Entity(parent.id);
                                entity.setPersisted(true);
                            }
                        } else {
                            // No DataLoader available - create Entity instance directly
                            entity = new Entity(parent.id);
                            entity.setPersisted(true);
                        }
                    } else {
                        throw new Error(`Invalid parent for ${archetypeName}.${propertyKey}: parent must have an 'id' property`);
                    }

                    // If function has arguments, extract and convert them
                    if (options?.args && options.args.length > 0 && args) {
                        const functionArgs: any[] = [];
                        
                        for (const argDef of options.args) {
                            const argValue = args[argDef.name];
                            
                            if (argValue === undefined || argValue === null) {
                                if (!argDef.nullable) {
                                    throw new Error(`Required argument '${argDef.name}' is missing for ${archetypeName}.${propertyKey}`);
                                }
                                functionArgs.push(null);
                                continue;
                            }
                            
                            // Convert argument value to the expected type
                            let convertedValue: any = argValue;
                            
                            // Check if it's a custom type that needs instantiation
                            if (argDef.type && typeof argDef.type === 'function' && argDef.type !== String && argDef.type !== Number && argDef.type !== Boolean && argDef.type !== Date) {
                                // Check if it's a registered custom type (like ST_Point)
                                const isCustomType = customTypeRegistry.has(argDef.type) || 
                                                    customTypeNameRegistry.has(argDef.type) ||
                                                    (argDef.type?.name && registeredCustomTypes.has(argDef.type.name));
                                
                                if (isCustomType && typeof argValue === 'object' && !Array.isArray(argValue)) {
                                    // Try to instantiate the type if it's a class constructor
                                    try {
                                        if (argDef.type.prototype && argDef.type.prototype.constructor) {
                                            // It's a class, try to instantiate it
                                            // First, try object assignment (works for most cases)
                                            convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);
                                            
                                            // Verify the instance was created correctly
                                            if (!convertedValue || !(convertedValue instanceof argDef.type)) {
                                                // If object assignment didn't work, try constructor with common patterns
                                                // This is a fallback for types that require constructor parameters
                                                const constructor = argDef.type.prototype.constructor;
                                                const paramCount = constructor.length;
                                                
                                                if (paramCount === 2) {
                                                    // Try common 2-parameter patterns
                                                    if (argValue.latitude !== undefined && argValue.longitude !== undefined) {
                                                        convertedValue = new argDef.type(argValue.latitude, argValue.longitude);
                                                    } else if (argValue.x !== undefined && argValue.y !== undefined) {
                                                        convertedValue = new argDef.type(argValue.x, argValue.y);
                                                    } else {
                                                        // Fallback: use first two object values
                                                        const values = Object.values(argValue);
                                                        if (values.length >= 2) {
                                                            convertedValue = new argDef.type(values[0], values[1]);
                                                        }
                                                    }
                                                } else if (paramCount === 1) {
                                                    // Single parameter - try first property value
                                                    const values = Object.values(argValue);
                                                    if (values.length >= 1) {
                                                        convertedValue = new argDef.type(values[0]);
                                                    }
                                                } else if (paramCount === 0) {
                                                    // No parameters - object assignment should work
                                                    convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);
                                                }
                                                
                                                // Final fallback
                                                if (!convertedValue || !(convertedValue instanceof argDef.type)) {
                                                    convertedValue = Object.assign(Object.create(argDef.type.prototype), argValue);
                                                }
                                            }
                                        } else {
                                            // Not a class, use the value as-is
                                            convertedValue = argValue;
                                        }
                                    } catch (e) {
                                        // If instantiation fails, try object assignment
                                        try {
                                            convertedValue = Object.assign(Object.create(argDef.type.prototype || {}), argValue);
                                        } catch (e2) {
                                            // Fallback to plain object
                                            convertedValue = argValue;
                                        }
                                    }
                                } else {
                                    convertedValue = argValue;
                                }
                            }
                            
                            functionArgs.push(convertedValue);
                        }
                        
                        // Call function with entity and arguments
                        return await (this as any)[propertyKey](entity, ...functionArgs);
                    } else {
                        // No arguments, call with just entity
                        return await (this as any)[propertyKey](entity);
                    }
                },
            });
        }

        return resolvers;
    }

    /**
     * Registers all auto-generated field resolvers for this archetype with a service.
     * This eliminates the need to manually write @GraphQLField decorators.
     *
     * @param service The service instance to attach resolvers to
     *
     * @example
     * class AreaService extends BaseService {
     *     constructor(app: App) {
     *         super();
     *         // Auto-register all field resolvers!
     *         serviceAreaArcheType.registerFieldResolvers(this);
     *     }
     * }
     */
    public registerFieldResolvers(service: any): void {
        this.getZodObjectSchema(); // Ensure schema is generated
        const resolvers = this.generateFieldResolvers();

        if (!service.__graphqlFields) {
            service.__graphqlFields = [];
        }

        for (const { typeName, fieldName, resolver } of resolvers) {
            // Create a unique method name
            const methodName = `_autoResolver_${typeName}_${fieldName}`;

            // Attach resolver as a method
            service[methodName] = resolver;

            // Register with GraphQL metadata
            service.__graphqlFields.push({
                type: typeName,
                field: fieldName,
                propertyKey: methodName,
            });
        }
    }

    public getZodObjectSchema(options?: { excludeRelations?: boolean; excludeFunctions?: boolean }): ZodObject<any> {
        const excludeRelations = options?.excludeRelations ?? false;
        const excludeFunctions = options?.excludeFunctions ?? false;
        const zodShapes: Record<string, any> = {};
        const storage = getMetadataStorage();
        const unionSchemas: Array<{
            fieldName: string;
            schema: any;
            components: any[];
        }> = [];

        for (const [field, ctor] of Object.entries(this.componentMap)) {
            // Skip union fields - they'll be processed separately
            if (field.startsWith("union_")) {
                continue;
            }

            const type = this.fieldTypes[field];
            const typeId = storage.getComponentId(ctor.name);
            const componentProps = storage.getComponentProperties(typeId);

            // Check if component should be unwrapped based on field type
            if (shouldUnwrapComponent(componentProps, type)) {
                // Unwrap to primitive type
                if (type === String) {
                    zodShapes[field] = z.string();
                } else if (type === Number) {
                    zodShapes[field] = z.number();
                } else if (type === Boolean) {
                    zodShapes[field] = z.boolean();
                } else if (type === Date) {
                    zodShapes[field] = z.date();
                }
            } else {
                // Use component schema for complex types
                const componentSchema = getOrCreateComponentSchema(
                    ctor,
                    typeId,
                    this.fieldOptions[field]
                );
                if (componentSchema) {
                    zodShapes[field] = componentSchema;
                } else {
                    // Skip components with no properties
                    continue;
                }
            }

            if (
                this.fieldOptions[field]?.nullable &&
                zodShapes[field] &&
                !(zodShapes[field] instanceof ZodObject)
            ) {
                zodShapes[field] = zodShapes[field].nullish();
            }
        }

        // Process union fields
        for (const [fieldName, components] of Object.entries(this.unionMap)) {
            // Generate schemas for each component in the union
            const unionComponentSchemas: any[] = [];
            const unionComponentCtors: any[] = [];

            for (const component of components) {
                const typeId = storage.getComponentId(component.name);
                const componentSchema = getOrCreateComponentSchema(
                    component,
                    typeId,
                    this.unionOptions[fieldName]
                );

                if (componentSchema) {
                    unionComponentSchemas.push(componentSchema);
                    unionComponentCtors.push(component);
                }
            }

            // Create union type using Zod with GQLoom support
            if (unionComponentSchemas.length > 0) {
                const unionSchema = z
                    .union(unionComponentSchemas)
                    .register(asUnionType, {
                        name:
                            fieldName.charAt(0).toUpperCase() +
                            fieldName.slice(1), // Capitalize field name for type
                        resolveType: (it: any) => {
                            // Determine which type this is based on __typename
                            if (it.__typename) {
                                return it.__typename;
                            }
                            // Fallback: check property presence
                            for (
                                let i = 0;
                                i < unionComponentCtors.length;
                                i++
                            ) {
                                const componentProps =
                                    storage.getComponentProperties(
                                        storage.getComponentId(
                                            unionComponentCtors[i].name
                                        )
                                    );
                                const hasUniqueProps = componentProps.some(
                                    (prop) =>
                                        it.hasOwnProperty(prop.propertyKey)
                                );
                                if (hasUniqueProps) {
                                    return compNameToFieldName(
                                        unionComponentCtors[i].name
                                    );
                                }
                            }
                            return compNameToFieldName(
                                unionComponentCtors[0].name
                            );
                        },
                    });

                zodShapes[fieldName] = unionSchema;
                unionSchemas.push({
                    fieldName,
                    schema: unionSchema,
                    components: unionComponentSchemas,
                });

                // Apply nullable option for union fields
                if (this.unionOptions[fieldName]?.nullable) {
                    zodShapes[fieldName] = zodShapes[fieldName].nullish();
                }
            }
        }

        // Process relations for GraphQL schema generation (skip if excludeRelations is true)
        if (!excludeRelations) {
            for (const [field, relatedArcheType] of Object.entries(
                this.relationMap
            )) {
                const relationType = this.relationTypes[field];
                const isArray =
                    relationType === "hasMany" || relationType === "belongsToMany";

                // Get the related archetype name
                let relatedTypeName: string;
                if (typeof relatedArcheType === "string") {
                    relatedTypeName = relatedArcheType;
                } else {
                    const relatedArchetypeId = storage.getComponentId(
                        relatedArcheType.name
                    );
                    const relatedArchetypeMetadata = storage.archetypes.find(
                        (a) => a.typeId === relatedArchetypeId
                    );
                    relatedTypeName =
                        relatedArchetypeMetadata?.name ||
                        relatedArcheType.name.replace(/ArcheType$/, "");
                }

                // For GraphQL relations, we just store the type name as a string reference
                // The GraphQL schema will use the type name directly, and the full type definition
                // will be generated when each archetype's getZodObjectSchema() is called
                
                // For singular relations, add description to the string schema
                const relatedTypeSchema = z
                    .string()
                    .describe(`Reference to ${relatedTypeName} type`);

                if (isArray) {
                    // HasMany and BelongsToMany should be optional by default (nullable array)
                    // unless explicitly marked as required via nullable: false
                    const shouldBeRequired = this.relationOptions[field]?.nullable === false;
                    // For array relations, the description on the inner string won't show up in GraphQL
                    // We need to store metadata about this being a relation for post-processing
                    zodShapes[field] = shouldBeRequired 
                        ? z.array(relatedTypeSchema) 
                        : z.array(relatedTypeSchema).optional();
                } else {
                    zodShapes[field] = relatedTypeSchema;
                    
                    // For singular relations, apply nullable option
                    if (this.relationOptions[field]?.nullable) {
                        zodShapes[field] = zodShapes[field].nullish();
                    }
                }
            }
        }

        // Process archetype functions
        // Store function input type names for post-processing
        const functionInputTypes = new Map<string, string>();
        
        if (!excludeFunctions) {
            for (const { propertyKey, options } of this.functions) {
                let zodType;
                if (options?.returnType === 'number') {
                    zodType = z.number();
                } else if (options?.returnType === 'string') {
                    zodType = z.string();
                } else if (options?.returnType === 'boolean') {
                    zodType = z.boolean();
                } else if (options?.returnType) {
                    // Assume it's a GraphQL type name, create a string reference
                    zodType = z.string().describe(`Reference to ${options.returnType} type`);
                } else {
                    const returnType = Reflect.getMetadata("design:returntype", this.constructor.prototype, propertyKey);
                    if (returnType === String) {
                        zodType = z.string();
                    } else if (returnType === Number) {
                        zodType = z.number();
                    } else if (returnType === Boolean) {
                        zodType = z.boolean();
                    } else {
                        zodType = z.any();
                    }
                }
                
                // Process function arguments if present
                if (options?.args && options.args.length > 0) {
                    const archetypeId = storage.getComponentId(this.constructor.name);
                    const archetypeName =
                        storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
                        this.constructor.name;
                    const inputTypeName = `${archetypeName}_${propertyKey}Args`;
                    
                    // Create input type schema for arguments
                    const inputFields: Record<string, any> = {};
                    for (const arg of options.args) {
                        let argZodType: any;
                        
                        // Check if it's a registered custom type
                        if (customTypeRegistry.has(arg.type)) {
                            argZodType = customTypeRegistry.get(arg.type)!;
                        } else if (arg.type === String || arg.type === String) {
                            argZodType = z.string();
                        } else if (arg.type === Number) {
                            argZodType = z.number();
                        } else if (arg.type === Boolean) {
                            argZodType = z.boolean();
                        } else if (arg.type === Date) {
                            argZodType = z.date();
                        } else if (registeredCustomTypes.has(arg.type?.name || '')) {
                            // Check if it's registered by name
                            argZodType = registeredCustomTypes.get(arg.type.name);
                        } else {
                            // Try to get from customTypeNameRegistry
                            const typeName = customTypeNameRegistry.get(arg.type);
                            if (typeName && registeredCustomTypes.has(typeName)) {
                                argZodType = registeredCustomTypes.get(typeName);
                            } else {
                                console.warn(`[ArcheType] Unknown argument type for ${archetypeName}.${propertyKey}.${arg.name}: ${arg.type?.name || arg.type}. Falling back to z.any()`);
                                argZodType = z.any();
                            }
                        }
                        
                        // Apply nullable if specified
                        if (arg.nullable) {
                            argZodType = argZodType.optional();
                        }
                        
                        inputFields[arg.name] = argZodType;
                    }
                    
                    // Create and register the input type
                    const inputSchema = z.object(inputFields).register(asObjectType, { name: inputTypeName });
                    registeredCustomTypes.set(inputTypeName, inputSchema);
                    functionInputTypes.set(propertyKey, inputTypeName);
                }
                
                zodShapes[propertyKey] = zodType.optional();
            }
        }

        const archetypeId = storage.getComponentId(this.constructor.name);
        const nameFromStorage =
            storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
            this.constructor.name;
        const shape: Record<string, any> = {
            __typename: z.literal(nameFromStorage).nullish(),
            id: z.string().nullish(), // Will be converted to ID in post-processing
        };
        for (const [field, zodType] of Object.entries(zodShapes)) {
            const isNullable =
                this.fieldOptions[field]?.nullable ||
                this.unionOptions[field]?.nullable;
            if (isNullable) {
                // For nullable fields, make them optional in the GraphQL schema
                shape[field] = zodType.optional();
            } else {
                shape[field] = zodType;
            }
        }
        const r = z.object(shape);

        // Collect all component schemas used by this archetype for weaving
        const componentSchemasToWeave: any[] = [];
        for (const [field, zodType] of Object.entries(zodShapes)) {
            if (zodType instanceof ZodObject) {
                componentSchemasToWeave.push(zodType);
            } else if (
                Array.isArray(zodType) ||
                (zodType &&
                    typeof zodType === "object" &&
                    zodType._def?.typeName === "ZodUnion")
            ) {
                // Handle union types
                if (zodType._def?.typeName === "ZodUnion") {
                    componentSchemasToWeave.push(zodType);
                }
            }
        }

        // Weave archetype schema along with its component schemas
        const schemasToWeave = [r];
        const schema = weave(ZodWeaver, ...schemasToWeave);
        let graphqlSchemaString = printSchema(schema);

        // Post-process: Replace 'id: String' with 'id: ID' for all id fields
        graphqlSchemaString = graphqlSchemaString.replace(
            /\bid:\s*String\b/g,
            "id: ID"
        );

        // Post-process: Replace relation field types with proper GraphQL type references
        for (const [field, relatedArcheType] of Object.entries(
            this.relationMap
        )) {
            const relationType = this.relationTypes[field];
            const isArray =
                relationType === "hasMany" || relationType === "belongsToMany";

            let relatedTypeName: string;
            if (typeof relatedArcheType === "string") {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(
                    relatedArcheType.name
                );
                const relatedArchetypeMetadata = storage.archetypes.find(
                    (a) => a.typeId === relatedArchetypeId
                );
                relatedTypeName =
                    relatedArchetypeMetadata?.name ||
                    relatedArcheType.name.replace(/ArcheType$/, "");
            }

            // Replace the String field with proper GraphQL type reference
            if (isArray) {
                // For arrays: should be required only if explicitly set nullable: false
                const shouldBeRequired = this.relationOptions[field]?.nullable === false;
                const suffix = shouldBeRequired ? "!" : "";
                
                // Step 1: Add description comment if it doesn't exist
                const descriptionPattern = new RegExp(`"""Reference to ${relatedTypeName} type"""[\\s\\S]*?${field}:`);
                if (!descriptionPattern.test(graphqlSchemaString)) {
                    // Add description before the field
                    const addDescriptionPattern = new RegExp(
                        `(\\n\\s+)(${field}:\\s*\\[String!?\\]!?)`,
                        "g"
                    );
                    graphqlSchemaString = graphqlSchemaString.replace(
                        addDescriptionPattern,
                        `$1"""Reference to ${relatedTypeName} type"""\n$1$2`
                    );
                }
                
                // Step 2: Replace [String!] or [String] with [TypeName!]
                const replaceTypePattern = new RegExp(
                    `(${field}:\\s*)\\[String!?\\](!?)`,
                    "g"
                );
                graphqlSchemaString = graphqlSchemaString.replace(
                    replaceTypePattern,
                    `$1[${relatedTypeName}!]${suffix}`
                );
            } else {
                const isNullable = this.relationOptions[field]?.nullable;
                const suffix = isNullable ? "" : "!";
                const pattern = new RegExp(`${field}:\\s*String!?`, "g");
                graphqlSchemaString = graphqlSchemaString.replace(
                    pattern,
                    `${field}: ${relatedTypeName}${suffix}`
                );
            }
        }

        // Post-process: Add argument definitions to function fields
        if (!excludeFunctions) {
            for (const { propertyKey, options } of this.functions) {
                if (options?.args && options.args.length > 0) {
                    // Build individual argument definitions
                    const argDefs: string[] = [];
                    for (const arg of options.args) {
                        let argTypeName: string;
                        
                        // Determine GraphQL type name for the argument
                        // For GraphQL arguments, we prefer input types over object types
                        // First check if there's a registered input type for this type
                        const inputTypeName = inputTypeRegistry.get(arg.type);
                        if (inputTypeName) {
                            argTypeName = inputTypeName;
                        } else {
                            // Fall back to the object type name
                            const registeredTypeName = customTypeNameRegistry.get(arg.type);
                            if (registeredTypeName) {
                                argTypeName = registeredTypeName;
                            } else if (customTypeRegistry.has(arg.type)) {
                                // It's registered but without a name, try to find the name
                                const registeredName = Array.from(registeredCustomTypes.entries())
                                    .find(([name, schema]) => schema === customTypeRegistry.get(arg.type))?.[0];
                                argTypeName = registeredName || 'String';
                            } else if (arg.type === String) {
                                argTypeName = 'String';
                            } else if (arg.type === Number) {
                                argTypeName = 'Float';
                            } else if (arg.type === Boolean) {
                                argTypeName = 'Boolean';
                            } else if (arg.type === Date) {
                                argTypeName = 'Date';
                            } else if (arg.type?.name && registeredCustomTypes.has(arg.type.name)) {
                                // Check if the type name is registered
                                argTypeName = arg.type.name;
                            } else if (arg.type?.name) {
                                // Fallback to the type's name if it exists
                                argTypeName = arg.type.name;
                            } else {
                                argTypeName = 'String';
                            }
                        }
                        
                        const nullable = arg.nullable ? '' : '!';
                        argDefs.push(`${arg.name}: ${argTypeName}${nullable}`);
                    }
                    
                    // Find the function field in the schema and add arguments
                    // The schema format from printSchema is typically:
                    //   fieldName: ReturnType
                    // We need to replace it with: fieldName(arg1: Type1, arg2: Type2): ReturnType
                    
                    // Escape propertyKey for regex
                    const escapedKey = propertyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const escapedTypeName = nameFromStorage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    
                    // Build the replacement string
                    const argsString = argDefs.join(', ');
                    
                    // Debug: Log what we're looking for
                    console.log(`[ArcheType] Adding arguments to ${nameFromStorage}.${propertyKey}: ${argsString}`);
                    
                    // Try to find and replace the field definition
                    // Look for the field within the type definition
                    // Make it case-insensitive to handle different casing in GraphQL schema
                    const typeStartPattern = new RegExp(`type\\s+${escapedTypeName}\\s*\\{`, 'i');
                    let typeStartMatch = graphqlSchemaString.match(typeStartPattern);
                    
                    // If exact match fails, try case-insensitive search for the type name
                    if (!typeStartMatch) {
                        // Try to find the type with any casing
                        const caseInsensitivePattern = new RegExp(`type\\s+([^\\s{]+)\\s*\\{`, 'gi');
                        const allTypes = [...graphqlSchemaString.matchAll(caseInsensitivePattern)];
                        const matchingType = allTypes.find(match => 
                            match[1]!.toLowerCase() === nameFromStorage.toLowerCase()
                        );
                        if (matchingType && matchingType.index !== undefined) {
                            // Create a fake match object
                            typeStartMatch = [matchingType[0], matchingType[1]] as RegExpMatchArray;
                            typeStartMatch.index = matchingType.index;
                        }
                    }
                    
                    if (typeStartMatch) {
                        const typeStartIndex = typeStartMatch.index! + typeStartMatch[0].length;
                        // Find the closing brace of this type
                        let braceCount = 1;
                        let typeEndIndex = typeStartIndex;
                        for (let i = typeStartIndex; i < graphqlSchemaString.length && braceCount > 0; i++) {
                            if (graphqlSchemaString[i] === '{') braceCount++;
                            if (graphqlSchemaString[i] === '}') braceCount--;
                            if (braceCount === 0) {
                                typeEndIndex = i;
                                break;
                            }
                        }
                        
                        // Extract the type definition
                        const typeDefinition = graphqlSchemaString.substring(typeStartIndex, typeEndIndex);
                        
                        // Debug: Log the type definition snippet
                        console.log(`[ArcheType] Type definition for ${nameFromStorage}:`, typeDefinition.substring(0, 200));
                        
                        // Find the field within this type definition
                        // Pattern: fieldName: ReturnType or fieldName?: ReturnType
                        const fieldPattern = new RegExp(
                            `(\\n\\s+)(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                            'g'
                        );
                        
                        const fieldMatch = fieldPattern.exec(typeDefinition);
                        if (fieldMatch) {
                            const returnType = fieldMatch[3]!.trim();
                            const indent = fieldMatch[1];
                            const replacement = `${indent}${propertyKey}(${argsString}): ${returnType}`;
                            
                            console.log(`[ArcheType] Found field match: "${fieldMatch[0]}" -> "${replacement}"`);
                            
                            // Replace in the full schema string
                            const fullMatchStart = typeStartIndex + fieldMatch.index!;
                            const fullMatchEnd = fullMatchStart + fieldMatch[0].length;
                            graphqlSchemaString = 
                                graphqlSchemaString.substring(0, fullMatchStart) +
                                replacement +
                                graphqlSchemaString.substring(fullMatchEnd);
                            
                            console.log(`[ArcheType] Replacement successful for ${nameFromStorage}.${propertyKey}`);
                        } else {
                            console.warn(`[ArcheType] Field pattern not found in type definition. Looking for: ${escapedKey}`);
                            // Fallback: simple replace anywhere
                            const simplePattern = new RegExp(
                                `(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                                'g'
                            );
                            const beforeReplace = graphqlSchemaString;
                            graphqlSchemaString = graphqlSchemaString.replace(
                                simplePattern,
                                (match, fieldDef, returnType) => {
                                    console.log(`[ArcheType] Fallback replacement: "${match}" -> "${propertyKey}(${argsString}): ${returnType.trim()}"`);
                                    return `${propertyKey}(${argsString}): ${returnType.trim()}`;
                                }
                            );
                            if (beforeReplace === graphqlSchemaString) {
                                console.warn(`[ArcheType] Fallback replacement also failed for ${nameFromStorage}.${propertyKey}`);
                            }
                        }
                    } else {
                        console.warn(`[ArcheType] Type pattern not found for ${nameFromStorage}. Schema snippet:`, graphqlSchemaString.substring(0, 300));
                        // Fallback: simple replace anywhere if type pattern not found
                        const simplePattern = new RegExp(
                            `(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                            'g'
                        );
                        const beforeReplace = graphqlSchemaString;
                        graphqlSchemaString = graphqlSchemaString.replace(
                            simplePattern,
                            (match, fieldDef, returnType) => {
                                console.log(`[ArcheType] Final fallback replacement: "${match}" -> "${propertyKey}(${argsString}): ${returnType.trim()}"`);
                                return `${propertyKey}(${argsString}): ${returnType.trim()}`;
                            }
                        );
                        if (beforeReplace === graphqlSchemaString) {
                            console.warn(`[ArcheType] All replacement attempts failed for ${nameFromStorage}.${propertyKey}`);
                        }
                    }
                }
                
                // Replace String return type with actual GraphQL type if specified
                if (options?.returnType && !['string', 'number', 'boolean'].includes(options.returnType)) {
                    // Find the field in the schema
                    const fieldIndex = graphqlSchemaString.indexOf(`  ${propertyKey}`);
                    if (fieldIndex !== -1) {
                        // Extract the line containing this field
                        const lineStart = fieldIndex;
                        const lineEnd = graphqlSchemaString.indexOf('\n', fieldIndex);
                        const fieldLine = graphqlSchemaString.substring(lineStart, lineEnd !== -1 ? lineEnd : graphqlSchemaString.length);
                        
                        // Replace String with the actual return type in this line
                        const updatedLine = fieldLine.replace(/:\s*String(\??)(\s*)$/, `: ${options.returnType}$1$2`);
                        
                        if (updatedLine !== fieldLine) {
                            // Replace the line in the full schema
                            graphqlSchemaString = graphqlSchemaString.substring(0, lineStart) + 
                                                 updatedLine + 
                                                 graphqlSchemaString.substring(lineEnd !== -1 ? lineEnd : graphqlSchemaString.length);
                        }
                    }
                }
            }
        }

        // Debug: Log schema if it contains function arguments
        if (!excludeFunctions && this.functions.some(f => f.options?.args && f.options.args.length > 0)) {
            // console.log(`[ArcheType] Final schema for ${nameFromStorage} with function args:`, graphqlSchemaString);
        }

        // Cache the schema for this archetype
        const cacheKey = `${nameFromStorage}_${excludeRelations}_${excludeFunctions}`;
        archetypeSchemaCache.set(cacheKey, {
            zodSchema: r,
            graphqlSchema: graphqlSchemaString,
        });

        // Store for unified weaving
        allArchetypeZodObjects.set(nameFromStorage, r);

        return r;
    }

    /**
     * Get a Zod schema suitable for GraphQL input types (excludes relations and functions)
     */
    public getInputSchema(): ZodObject<any> {
        return this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true });
    }

    /**
     * Apply validations to specific fields in the input schema
     * @param validations - Object mapping field paths to Zod schemas or refinement functions
     * @returns Modified Zod schema with validations applied
     * 
     * @example
     * archetype.withValidation({
     *   name: z.string().min(3),
     *   'info.label': z.string().min(3)
     * })
     */
    public withValidation(validations: Record<string, any>): ZodObject<any> {
        const baseSchema = this.getInputSchema();
        const shape = { ...baseSchema.shape };

        for (const [path, validation] of Object.entries(validations)) {
            if (path.includes('.')) {
                // Handle nested fields like 'info.label'
                const [field, ...nestedPath] = path.split('.');
                
                if (shape[field!]) {
                    const currentField = shape[field!];
                    
                    // Check if it's an optional field and unwrap it
                    const isOptional = currentField._def?.typeName === 'ZodOptional';
                    const innerSchema = isOptional ? currentField.unwrap() : currentField;
                    
                    // Check if it's a ZodObject - handle both typeName and type property
                    const isZodObject = innerSchema._def?.typeName === 'ZodObject' || 
                                       innerSchema._def?.type === 'object' || 
                                       innerSchema.type === 'object';
                    
                    if (isZodObject && innerSchema.shape) {
                        // Deep clone the nested shape to avoid mutations
                        const nestedShape = { ...innerSchema.shape };
                        
                        // Apply validation to the nested field
                        if (nestedPath.length === 1 && nestedShape[nestedPath[0]!]) {
                            nestedShape[nestedPath[0]!] = validation;
                        } else if (nestedPath.length > 1) {
                            // Handle deeper nesting (e.g., 'info.data.label')
                            let current = nestedShape;
                            for (let i = 0; i < nestedPath.length - 1; i++) {
                                const key = nestedPath[i]!;
                                if (current[key] && current[key]._def?.typeName === 'ZodObject') {
                                    current[key] = { ...current[key].shape };
                                    current = current[key];
                                }
                            }
                            const lastKey = nestedPath[nestedPath.length - 1]!;
                            if (current[lastKey]) {
                                current[lastKey] = validation;
                            }
                        }
                        
                        const newNestedSchema = z.object(nestedShape);
                        // Preserve the optionality of the parent object
                        shape[field!] = isOptional ? newNestedSchema.optional() : newNestedSchema;
                    }
                }
            } else {
                // Handle top-level fields - directly replace with the validation
                shape[path] = validation;
            }
        }

        return z.object(shape);
    }

    public getFilterSchema(): ZodObject<any> {
        const baseSchema = this.getZodObjectSchema({ excludeRelations: true, excludeFunctions: true });
        const filterShape: Record<string, any> = {};
        for (const key of Object.keys(baseSchema.shape)) {
            // Only include fields that are explicitly set to filterable: true
            const isFilterable = this.fieldOptions[key]?.filterable === true || this.unionOptions[key]?.filterable === true;
            if (isFilterable) {
                filterShape[key] = InputFilterSchema.optional();
            }
        }
        const filterSchema = z.object(filterShape);
        return filterSchema;
    }

    public buildFilterBranches(filter?: FilterSchema<any>): any[] {
        if (!filter) return [];
        const branches = [];

        for (const [fieldName, componentCtor] of Object.entries(this.componentMap)) {
            const fieldOption = this.fieldOptions[fieldName];
            if (fieldOption?.filterable && filter[fieldName]?.value) {
                const filterPart = filter[fieldName];
                const defaultField = this.getDefaultFilterField(componentCtor);
                const operator = filterPart.op ? Query.filterOp[(filterPart.op.toUpperCase() as keyof typeof Query.filterOp)] : Query.filterOp.LIKE;

                branches.push({
                    component: componentCtor,
                    filters: [
                        {
                            field: filterPart.field || defaultField,
                            operator,
                            value: operator === Query.filterOp.LIKE ? `%${filterPart.value}%` : filterPart.value,
                        },
                    ],
                });
            }
        }

        return branches;
    }

    private getDefaultFilterField(componentCtor: any): string {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(componentCtor.name);
        const props = storage.getComponentProperties(typeId);
        const hasValue = props.some(p => p.propertyKey === 'value');
        const hasLabel = props.some(p => p.propertyKey === 'label');
        return hasValue ? 'value' : hasLabel ? 'label' : props[0]?.propertyKey || 'value';
    }
}





export default BaseArcheType;
