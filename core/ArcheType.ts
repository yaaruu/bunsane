import type { BaseComponent, ComponentDataType } from "./Components";
import type { ComponentPropertyMetadata } from "./metadata/definitions/Component";
import type { ArcheTypeFieldOptions } from "./metadata/definitions/ArcheType";
import { Entity } from "./Entity";
import { getMetadataStorage } from "./metadata";
import { z, ZodObject } from "zod";
import {weave } from "@gqloom/core";
import { ZodWeaver, asEnumType, asUnionType } from "@gqloom/zod";
import { printSchema } from "graphql";
import "reflect-metadata";

const customTypeRegistry = new Map<any, any>();
const customTypeNameRegistry = new Map<any, string>();
const registeredCustomTypes = new Map<string, any>();
const customTypeSilks = new Map<string, any>(); // Store silk types for unified weaving
const customTypeResolvers: any[] = []; // Store resolvers for custom types

// Component-level schema cache
const componentSchemaCache = new Map<string, ZodObject<any>>(); // componentId -> Zod schema

const archetypeSchemaCache = new Map<string, { zodSchema: ZodObject<any>, graphqlSchema: string }>();
const allArchetypeZodObjects = new Map<string, ZodObject<any>>();

export function registerCustomZodType(type: any, schema: any, typeName?: string) {
    // If a type name is provided and it's a ZodObject, add __typename to control GraphQL naming
    if (typeName && schema instanceof ZodObject) {
        // Extend the schema with __typename literal to control the GraphQL type name
        const shape = schema.shape;
        const namedSchema = z.object({
            __typename: z.literal(typeName).nullish(),
            ...shape
        });
        customTypeRegistry.set(type, namedSchema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, namedSchema);
        }
    } else {
        customTypeRegistry.set(type, schema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, schema);
        }
    }
}

export function getArchetypeSchema(archetypeName: string) {
    return archetypeSchemaCache.get(archetypeName);
}

export function getAllArchetypeSchemas() {
    return Array.from(archetypeSchemaCache.values());
}

export function getRegisteredCustomTypes() {
    return registeredCustomTypes;
}

export function weaveAllArchetypes() {
    // First, ensure all archetype schemas are generated
    const storage = getMetadataStorage();
    for (const archetypeMetadata of storage.archetypes) {
        const archetypeName = archetypeMetadata.name;
        if (!archetypeSchemaCache.has(archetypeName)) {
            try {
                const ArchetypeClass = archetypeMetadata.target as any;
                const instance = new ArchetypeClass();
                instance.getZodObjectSchema(); // Generate and cache the schema
            } catch (error) {
                console.warn(`Could not generate schema for archetype ${archetypeName}:`, error);
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
    const allSchemas = [...archetypeSchemas, ...componentSchemas];
    
    const schema = weave(ZodWeaver, ...allSchemas);
    let schemaString = printSchema(schema);
    
    // Post-process: Replace 'id: String' with 'id: ID' for all id fields
    schemaString = schemaString.replace(/\bid:\s*String\b/g, 'id: ID');
    
    return schemaString;
}

// Generate Zod schema for a component and cache it
function getOrCreateComponentSchema(componentCtor: new (...args: any[]) => BaseComponent, componentId: string, fieldOptions?: ArcheTypeFieldOptions): any | null {
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
        __typename: z.literal(compNameToFieldName(componentCtor.name)).nullish()
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
                    zodFields[prop.propertyKey] = z.any();
            }
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
            }
        } else if (prop.isEnum && prop.enumValues && prop.enumKeys) {
            const enumTypeName = prop.propertyType?.name || `${componentCtor.name}_${prop.propertyKey}_Enum`;
            zodFields[prop.propertyKey] = z.enum(prop.enumValues as any).register(asEnumType, {
                name: enumTypeName,
                valuesConfig: prop.enumKeys.reduce((acc: Record<string, { description: string }>, key, idx) => { 
                    acc[key] = { description: prop.enumValues![idx]! }; 
                    return acc; 
                }, {})
            });
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
            }
        } else if (customTypeRegistry.has(prop.propertyType)) {
            zodFields[prop.propertyKey] = customTypeRegistry.get(prop.propertyType)!;
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
            }
        } else {
            zodFields[prop.propertyKey] = z.any();
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
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
    return compName.charAt(0).toLowerCase() + compName.slice(1).replace(/Component$/, '');
}

/**
 * Helper to determine if a component should be unwrapped to a scalar value.
 * Returns true if the component has a single 'value' property and the field type is primitive.
 */
function shouldUnwrapComponent(componentProps: ComponentPropertyMetadata[], fieldType: any): boolean {
    // If field type is a primitive, unwrap the component to that primitive
    if (fieldType === String || fieldType === Number || fieldType === Boolean || fieldType === Date) {
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

// TODO: Implement archetype with GraphQL support
export function ArcheType<T extends new () => BaseArcheType>(nameOrOptions?: string | ArcheTypeOptions) {
    return function(target: T): T {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(target.name);
        
        let archetype_name = target.name;
        
        if (typeof nameOrOptions === 'string') {
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
            for (const {propertyKey, component, options} of fields) {
                const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
                storage.collectArchetypeField(archetype_name, propertyKey, component, options, type);
            }
        }

        const unions = prototype[archetypeUnionFieldsSymbol];
        if(unions) {
            for(const {propertyKey, components, options} of unions) {
                storage.collectArchetypeUnion(archetype_name, propertyKey, components, options, 'union');
            }
        }

        // Process relations
        const relations = prototype[archetypeRelationsSymbol];
        if (relations) {
            for (const {propertyKey, relatedArcheType, relationType, options} of relations) {
                const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
                storage.collectArchetypeRelation(archetype_name, propertyKey, relatedArcheType, relationType, options, type);
            }
        }
        return target;
    };
}

const archetypeFieldsSymbol = Symbol("archetypeFields");
export function ArcheTypeField<T extends BaseComponent>(component: new (...args: any[]) => T, options?: ArcheTypeFieldOptions) {
    return function(target: any, propertyKey: string) {
        if (!target[archetypeFieldsSymbol]) {
            target[archetypeFieldsSymbol] = [];
        }
        target[archetypeFieldsSymbol].push({ propertyKey, component, options });
    };
}

const archetypeUnionFieldsSymbol = Symbol("archetypeUnionFields");
export function ArcheTypeUnionField(components: (new (...args:any[]) => any)[], options?: ArcheTypeFieldOptions) {
    return function(target: any, propertyKey: string) {
        if(!target[archetypeUnionFieldsSymbol]) {
            target[archetypeUnionFieldsSymbol] = [];
        }
        target[archetypeUnionFieldsSymbol].push({propertyKey, components, options});
    }
}

const archetypeRelationsSymbol = Symbol("archetypeRelations");

function createRelationDecorator(relationType: 'hasMany' | 'belongsTo' | 'hasOne' | 'belongsToMany') {
    return function(
        relatedArcheType: string,
        options?: RelationOptions
    ) {
        return function(target: any, propertyKey: string) {
            if (!target[archetypeRelationsSymbol]) {
                target[archetypeRelationsSymbol] = [];
            }
            target[archetypeRelationsSymbol].push({
                propertyKey,
                relatedArcheType,
                relationType,
                options
            });
        };
    };
}

export const HasMany = createRelationDecorator('hasMany');
export const BelongsTo = createRelationDecorator('belongsTo');
export const HasOne = createRelationDecorator('hasOne');
export const BelongsToMany = createRelationDecorator('belongsToMany');

// Keep ArcheTypeRelation as alias for backwards compatibility
export const ArcheTypeRelation = HasMany;

export type ArcheTypeResolver = {
    resolver?: string;
    component?: new (...args: any[]) => BaseComponent;
    field?: string;
    filter?: {[key: string]: any};
}

export type ArcheTypeCreateInfo = {
    name: string;
    components: Array<new (...args: any[]) => BaseComponent>;
};

export class BaseArcheType {
    protected components: Set<{ ctor: new (...args: any[]) => BaseComponent, data: any }> = new Set();
    public componentMap: Record<string, typeof BaseComponent> = {}; 
    protected fieldOptions: Record<string, ArcheTypeFieldOptions> = {};
    protected fieldTypes: Record<string, any> = {};
    public relationMap: Record<string, typeof BaseArcheType | string> = {};
    protected relationOptions: Record<string, RelationOptions> = {};
    protected relationTypes: Record<string, 'hasMany' | 'belongsTo' | 'hasOne' | 'belongsToMany'> = {};
    public unionMap: Record<string, (new (...args: any[]) => BaseComponent)[]> = {};
    protected unionOptions: Record<string, ArcheTypeFieldOptions> = {};

    public resolver?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor() {
        const storage = getMetadataStorage();
        const archetypeId = storage.getComponentId(this.constructor.name);
        
        // Look up the custom name from metadata (e.g., from @ArcheType("CustomName"))
        const archetypeMetadata = storage.archetypes.find(a => a.typeId === archetypeId);
        const archetypeName = archetypeMetadata?.name || this.constructor.name.replace(/ArcheType$/, '');
        
        const fields = storage.archetypes_field_map.get(archetypeName);
        if (fields) {
            for (const {fieldName, component, options, type} of fields) {
                this.componentMap[fieldName] = component;
                if (options) this.fieldOptions[fieldName] = options;
                if (type) this.fieldTypes[fieldName] = type;
            }
        }

        const unions = storage.archetypes_union_map.get(archetypeName);
        if(unions) {
            for(const {fieldName, components, options, type} of unions) {
                this.unionMap[fieldName] = components;
                if (options) this.unionOptions[fieldName] = options;
            }
        }

        // Process relations
        const relations = storage.archetypes_relations_map.get(archetypeName);
        if (relations) {
            for (const {fieldName, relatedArcheType, relationType, options, type} of relations) {
                this.relationMap[fieldName] = relatedArcheType as any;
                this.relationTypes[fieldName] = relationType;
                if (options) this.relationOptions[fieldName] = options;
            }
        }
    }

    // constructor(components: Array<new (...args: any[]) => BaseComponent>) {
    //     for (const ctor of components) {
    //         this.componentMap[compNameToFieldName(ctor.name)] = ctor;
    //     }
    // }

    static ResolveField<T extends BaseComponent>(component: new (...args: any[]) => T, field: keyof T): ArcheTypeResolver {
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
   
    
    private addComponent<T extends BaseComponent>(ctor: new (...args: any[]) => T, data: ComponentDataType<T>) {
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
                    const componentProps = storage.getComponentProperties(typeId);
                    
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
                    const selectedComponent = this.determineUnionComponent(value, unionComponents, storage);
                    
                    if (selectedComponent) {
                        this.addComponent(selectedComponent, value as any);
                    } else if (strict) {
                        throw new Error(`Could not determine component type for union field '${key}'`);
                    }
                } else {
                    // direct property
                    (this as any)[key] = value;
                }
            }
        }
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const alreadyAdded = Array.from(this.components).some(c => c.ctor === ctor);
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
    private determineUnionComponent(value: any, unionComponents: (new (...args: any[]) => BaseComponent)[], storage: any): (new (...args: any[]) => BaseComponent) | null {
        // If value has __typename, use it to determine the component
        if (value && typeof value === 'object' && value.__typename) {
            const expectedTypeName = value.__typename;
            for (const component of unionComponents) {
                const componentTypeName = compNameToFieldName(component.name);
                if (componentTypeName === expectedTypeName) {
                    return component;
                }
            }
        }
        
        // Fallback: Try to infer based on property presence
        if (value && typeof value === 'object') {
            for (const component of unionComponents) {
                const typeId = storage.getComponentId(component.name);
                const componentProps = storage.getComponentProperties(typeId);
                
                // Check if any properties of this component are present in the value
                const hasMatchingProps = componentProps.some((prop: ComponentPropertyMetadata) => 
                    value.hasOwnProperty(prop.propertyKey)
                );
                
                if (hasMatchingProps) {
                    return component;
                }
            }
        }
        
        // If no component matches, return the first one as default
        return unionComponents[0] || null;
    }    async updateEntity<T>(entity: Entity, updates: Partial<T>) {
        const storage = getMetadataStorage();
        
        for (const key of Object.keys(updates)) {
            if(key === 'id' || key === '_id') continue;
            const value = updates[key as keyof T];
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    const fieldType = this.fieldTypes[key];
                    const typeId = storage.getComponentId(compCtor.name);
                    const componentProps = storage.getComponentProperties(typeId);
                    
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
                    const selectedComponent = this.determineUnionComponent(value, unionComponents, storage);
                    
                    if (selectedComponent) {
                        await entity.set(selectedComponent, value as any);
                    }
                } else {
                    // direct, set on archetype
                    (this as any)[key] = value;
                }
            }
        }
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
     * Unwraps an entity into a plain object containing the component data.
     * @param entity The entity to unwrap
     * @param exclude An optional array of field names to exclude from the result (e.g., sensitive data like passwords)
     * @returns A promise that resolves to an object with component data
     */
    public async Unwrap(entity: Entity, exclude: string[] = []): Promise<Record<string, any>> {
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
                        ...(comp as any)
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
    public getComponentProperties(): Record<string, ComponentPropertyMetadata[]> {
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
        const archetypeName = storage.archetypes.find(a => a.typeId === archetypeId)?.name || this.constructor.name;

        // Generate ID resolver for the main archetype type
        resolvers.push({
            typeName: archetypeName,
            fieldName: 'id',
            resolver: (parent: Entity) => {
                return parent.id;
            }
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
            const isUnwrapped = shouldUnwrapComponent(componentProps, fieldType);
            
            if (isUnwrapped) {
                // For unwrapped components, resolve directly to the 'value' property
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: Entity, args: any, context: any) => {
                        const entity = parent;

                        // Use DataLoader if available, but fall back when no row exists
                        if (context.loaders) {
                            const componentData = await context.loaders.componentsByEntityType.load({
                                entityId: entity.id,
                                typeId: typeIdHex  // Pass hex string directly
                            });
                            if (componentData?.data?.value !== undefined) {
                                return componentData.data.value;
                            }
                        }

                        // Fallback: direct query ensures component data is returned
                        const comp = await entity.get(ctor);
                        return (comp as any)?.value;
                    }
                });
            } else {
                // For complex components, return the full component object
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: Entity, args: any, context: any) => {
                        const entity = parent;
                        if (!entity || !entity.id) return (parent as any)[field];

                        // Use DataLoader if available, but fall back when no row exists
                        if (context.loaders) {
                            const componentData = await context.loaders.componentsByEntityType.load({
                                entityId: entity.id,
                                typeId: typeIdHex  // Pass hex string directly
                            });
                            if (componentData?.data) {
                                return componentData.data;
                            }
                        }

                        // Fallback: direct query ensures component data is returned
                        const comp = await entity.get(ctor);
                        return comp;
                    }
                });

                // Generate nested field resolvers for component properties
                const componentTypeName = compNameToFieldName(componentName);
                
                for (const prop of componentProps) {
                    resolvers.push({
                        typeName: componentTypeName,  // Use lowercase component name
                        fieldName: prop.propertyKey,
                        resolver: (parent: any) => parent[prop.propertyKey]
                    });
                }
            }
        }

        // Generate resolvers for union fields
        for (const [field, components] of Object.entries(this.unionMap)) {
            resolvers.push({
                typeName: archetypeName,
                fieldName: field,
                resolver: async (parent: Entity, args: any, context: any) => {
                    const entity = parent;
                    
                    // Try to find which component in the union is present on the entity
                    for (const component of components) {
                        const typeId = storage.getComponentId(component.name);
                        
                        if (context.loaders) {
                            const componentData = await context.loaders.componentsByEntityType.load({
                                entityId: entity.id,
                                typeId: typeId
                            });
                            if (componentData?.data) {
                                // Add __typename for GraphQL union resolution
                                return {
                                    __typename: compNameToFieldName(component.name),
                                    ...componentData.data
                                };
                            }
                        }
                        
                        // Fallback
                        const comp = await entity.get(component);
                        if (comp) {
                            return {
                                __typename: compNameToFieldName(component.name),
                                ...(comp as any)
                            };
                        }
                    }
                    
                    return null;
                }
            });
        }

        // Generate resolvers for relation fields
        for (const [field, relatedArcheType] of Object.entries(this.relationMap)) {
            const relationType = this.relationTypes[field];
            const relationOptions = this.relationOptions[field];
            const isArray = relationType === 'hasMany' || relationType === 'belongsToMany';
            
            // Get the related archetype name
            let relatedTypeName: string;
            if (typeof relatedArcheType === 'string') {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(relatedArcheType.name);
                const relatedArchetypeMetadata = storage.archetypes.find(a => a.typeId === relatedArchetypeId);
                relatedTypeName = relatedArchetypeMetadata?.name || relatedArcheType.name.replace(/ArcheType$/, '');
            }
            
            if (!isArray && relationType === 'belongsTo' && relationOptions?.foreignKey) {
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: Entity, args: any, context: any) => {
                        const entity = parent;
                        if (!entity || !entity.id) {
                            return null;
                        }

                        let foreignId: string | undefined;

                        // Attempt to load the component that holds the foreign key via DataLoader
                        if (context.loaders) {
                            for (const [componentField, compCtor] of Object.entries(this.componentMap)) {
                                const typeIdForComponent = storage.getComponentId(compCtor.name);
                                const componentProps = storage.getComponentProperties(typeIdForComponent);
                                const hasForeignKey = componentProps.some(prop => prop.propertyKey === relationOptions.foreignKey);
                                if (!hasForeignKey || !relationOptions.foreignKey) continue;

                                const componentData = await context.loaders.componentsByEntityType.load({
                                    entityId: entity.id,
                                    typeId: typeIdForComponent
                                });

                                if (componentData?.data && componentData.data[relationOptions.foreignKey] !== undefined) {
                                    foreignId = componentData.data[relationOptions.foreignKey];
                                    break;
                                }
                            }
                        }

                        // Fallback: pull the component from the entity directly when DataLoader misses
                        if (!foreignId) {
                            for (const compCtor of Object.values(this.componentMap)) {
                                const typeIdForComponent = storage.getComponentId(compCtor.name);
                                const componentProps = storage.getComponentProperties(typeIdForComponent);
                                const hasForeignKey = componentProps.some(prop => prop.propertyKey === relationOptions.foreignKey);
                                if (!hasForeignKey || !relationOptions.foreignKey) continue;
                                const componentInstance = await entity.get(compCtor as any);
                                if (componentInstance && (componentInstance as any)[relationOptions.foreignKey] !== undefined) {
                                    foreignId = (componentInstance as any)[relationOptions.foreignKey];
                                    break;
                                }
                            }
                        }

                        if (!foreignId) {
                            return null;
                        }

                        // Resolve the related entity using loaders when possible, otherwise hit the database directly
                        if (context.loaders?.entityById) {
                            const relatedEntity = await context.loaders.entityById.load(foreignId);
                            if (relatedEntity) {
                                return relatedEntity;
                            }
                        }

                        return Entity.FindById(foreignId);
                    }
                });
            } else if (isArray) {
                // Array relation resolver
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: Entity, args: any, context: any) => {
                        const entity = parent;
                        
                        // Use DataLoader for relation loading if available
                        if (context.loaders && context.loaders.relationsByEntityField) {
                            return context.loaders.relationsByEntityField.load({
                                entityId: entity.id,
                                relationField: field,
                                relatedType: relatedTypeName,
                                foreignKey: relationOptions?.foreignKey
                            });
                        }
                        
                        // Fallback: return empty array or implement custom relation query
                        // This should be implemented based on your relation storage strategy
                        console.warn(`No relationsByEntityField loader found for array relation ${field} on ${archetypeName}`);
                        return [];
                    }
                });
            } else {
                // Single relation resolver
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: Entity, args: any, context: any) => {
                        const entity = parent;
                        
                        // Use DataLoader for relation loading if available
                        if (context.loaders && context.loaders.relationsByEntityField) {
                            const results = await context.loaders.relationsByEntityField.load({
                                entityId: entity.id,
                                relationField: field,
                                relatedType: relatedTypeName,
                                foreignKey: relationOptions?.foreignKey
                            });
                            if (results.length > 0) {
                                return results[0];
                            }
                        }
                        
                        // Fallback: return null or implement custom relation query
                        console.warn(`No relationsByEntityField loader found for single relation ${field} on ${archetypeName}`);
                        return null;
                    }
                });
            }
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
                propertyKey: methodName
            });
        }
    }

    // TODO: Here
    public getZodObjectSchema(): ZodObject<any> {
        const zodShapes: Record<string, any> = {};
        const storage = getMetadataStorage();
        const unionSchemas: Array<{ fieldName: string; schema: any; components: any[] }> = [];

        for (const [field, ctor] of Object.entries(this.componentMap)) {
            // Skip union fields - they'll be processed separately
            if (field.startsWith('union_')) {
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
                const componentSchema = getOrCreateComponentSchema(ctor, typeId, this.fieldOptions[field]);
                if (componentSchema) {
                    zodShapes[field] = componentSchema;
                } else {
                    // Skip components with no properties
                    continue;
                }
            }
            
            if (this.fieldOptions[field]?.nullable && zodShapes[field] && !(zodShapes[field] instanceof ZodObject)) {
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
                const componentSchema = getOrCreateComponentSchema(component, typeId, this.unionOptions[fieldName]);
                
                if (componentSchema) {
                    unionComponentSchemas.push(componentSchema);
                    unionComponentCtors.push(component);
                }
            }
            
            // Create union type using Zod with GQLoom support
            if (unionComponentSchemas.length > 0) {
                const unionSchema = z.union(unionComponentSchemas).register(asUnionType, {
                    name: fieldName.charAt(0).toUpperCase() + fieldName.slice(1), // Capitalize field name for type
                    resolveType: (it: any) => {
                        // Determine which type this is based on __typename
                        if (it.__typename) {
                            return it.__typename;
                        }
                        // Fallback: check property presence
                        for (let i = 0; i < unionComponentCtors.length; i++) {
                            const componentProps = storage.getComponentProperties(
                                storage.getComponentId(unionComponentCtors[i].name)
                            );
                            const hasUniqueProps = componentProps.some(prop => 
                                it.hasOwnProperty(prop.propertyKey)
                            );
                            if (hasUniqueProps) {
                                return compNameToFieldName(unionComponentCtors[i].name);
                            }
                        }
                        return compNameToFieldName(unionComponentCtors[0].name);
                    }
                });
                
                zodShapes[fieldName] = unionSchema;
                unionSchemas.push({
                    fieldName,
                    schema: unionSchema,
                    components: unionComponentSchemas
                });
                
                // Apply nullable option for union fields
                if (this.unionOptions[fieldName]?.nullable) {
                    zodShapes[fieldName] = zodShapes[fieldName].nullish();
                }
            }
        }

        // Process relations for GraphQL schema generation
        for (const [field, relatedArcheType] of Object.entries(this.relationMap)) {
            const relationType = this.relationTypes[field];
            const isArray = relationType === 'hasMany' || relationType === 'belongsToMany';
            
            // Get the related archetype name
            let relatedTypeName: string;
            if (typeof relatedArcheType === 'string') {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(relatedArcheType.name);
                const relatedArchetypeMetadata = storage.archetypes.find(a => a.typeId === relatedArchetypeId);
                relatedTypeName = relatedArchetypeMetadata?.name || relatedArcheType.name.replace(/ArcheType$/, '');
            }
            
            // For GraphQL relations, we just store the type name as a string reference
            // The GraphQL schema will use the type name directly, and the full type definition
            // will be generated when each archetype's getZodObjectSchema() is called
            const relatedTypeSchema = z.string().describe(`Reference to ${relatedTypeName} type`);
            
            if (isArray) {
                zodShapes[field] = z.array(relatedTypeSchema);
            } else {
                zodShapes[field] = relatedTypeSchema;
            }
            
            if (this.relationOptions[field]?.nullable) {
                zodShapes[field] = zodShapes[field].nullish();
            }
        }

        const archetypeId = storage.getComponentId(this.constructor.name);
        const nameFromStorage = storage.archetypes.find(a => a.typeId === archetypeId)?.name || this.constructor.name;
        const shape: Record<string, any> = {
            __typename: z.literal(nameFromStorage).nullish(),
            id: z.string().nullish(),  // Will be converted to ID in post-processing
        };
        for (const [field, zodType] of Object.entries(zodShapes)) {
            const isNullable = this.fieldOptions[field]?.nullable || this.unionOptions[field]?.nullable;
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
            } else if (Array.isArray(zodType) || (zodType && typeof zodType === 'object' && zodType._def?.typeName === 'ZodUnion')) {
                // Handle union types
                if (zodType._def?.typeName === 'ZodUnion') {
                    componentSchemasToWeave.push(zodType);
                }
            }
        }
        
        // Weave archetype schema along with its component schemas
        const schemasToWeave = [r, ...componentSchemasToWeave];
        const schema = weave(ZodWeaver, ...schemasToWeave);
        let graphqlSchemaString = printSchema(schema);
        
        // Post-process: Replace 'id: String' with 'id: ID' for all id fields
        graphqlSchemaString = graphqlSchemaString.replace(/\bid:\s*String\b/g, 'id: ID');
        
        // Post-process: Replace relation field types with proper GraphQL type references
        for (const [field, relatedArcheType] of Object.entries(this.relationMap)) {
            const relationType = this.relationTypes[field];
            const isArray = relationType === 'hasMany' || relationType === 'belongsToMany';
            
            let relatedTypeName: string;
            if (typeof relatedArcheType === 'string') {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(relatedArcheType.name);
                const relatedArchetypeMetadata = storage.archetypes.find(a => a.typeId === relatedArchetypeId);
                relatedTypeName = relatedArchetypeMetadata?.name || relatedArcheType.name.replace(/ArcheType$/, '');
            }
            
            // Replace the String field with proper GraphQL type reference
            if (isArray) {
                const pattern = new RegExp(`${field}:\\s*\\[String!?\\]!?`, 'g');
                graphqlSchemaString = graphqlSchemaString.replace(pattern, `${field}: [${relatedTypeName}!]!`);
            } else {
                const pattern = new RegExp(`${field}:\\s*String!?`, 'g');
                graphqlSchemaString = graphqlSchemaString.replace(pattern, `${field}: ${relatedTypeName}!`);
            }
        }
        
        // console.log("WeavedSchema:", graphqlSchemaString);
        
        // Cache the schema for this archetype
        archetypeSchemaCache.set(nameFromStorage, {
            zodSchema: r,
            graphqlSchema: graphqlSchemaString
        });
        
        // Store for unified weaving
        allArchetypeZodObjects.set(nameFromStorage, r);
        
        return r;
    }
}

export type InferArcheType<T extends BaseArcheType> = {
    [K in keyof T['componentMap']]: T['componentMap'][K] extends new (...args: any[]) => infer C ? C : never
};

// Alternative: Infer from the actual instance properties (recommended)
export type InferArcheTypeFromInstance<T extends BaseArcheType> = {
    [K in keyof T as T[K] extends BaseComponent ? K : never]: T[K]
};

export default BaseArcheType;