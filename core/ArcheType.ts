import type { BaseComponent, ComponentDataType } from "./Components";
import type { ComponentPropertyMetadata } from "./metadata/definitions/Component";
import type { ArcheTypeFieldOptions } from "./metadata/definitions/ArcheType";
import { Entity } from "./Entity";
import { getMetadataStorage } from "./metadata";
import { z, ZodObject, type ZodTypeAny } from "zod";
import {weave, silk, resolver} from "@gqloom/core";
import { ZodWeaver, asEnumType } from "@gqloom/zod";
import { GraphQLID } from "graphql";
import { printSchema } from "graphql";
import "reflect-metadata";

const customTypeRegistry = new Map<any, z.ZodTypeAny>();
const customTypeNameRegistry = new Map<any, string>();
const registeredCustomTypes = new Map<string, z.ZodTypeAny>();
const customTypeSilks = new Map<string, any>(); // Store silk types for unified weaving
const customTypeResolvers: any[] = []; // Store resolvers for custom types

// Component-level schema cache
const componentSchemaCache = new Map<string, ZodObject<any>>(); // componentId -> Zod schema

const archetypeSchemaCache = new Map<string, { zodSchema: ZodObject<any>, graphqlSchema: string }>();
const allArchetypeZodObjects = new Map<string, ZodObject<any>>();

export function registerCustomZodType(type: any, schema: z.ZodTypeAny, typeName?: string) {
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
    if (allArchetypeZodObjects.size === 0) {
        return null;
    }
    // Weave all archetype schemas together
    // Component schemas are already cached and reused, so @gqloom will deduplicate them
    const schemas = Array.from(allArchetypeZodObjects.values());
    const schema = weave(ZodWeaver, ...schemas);
    let schemaString = printSchema(schema);
    
    // Post-process: Replace 'id: String' with 'id: ID' for all id fields
    schemaString = schemaString.replace(/\bid:\s*String\b/g, 'id: ID');
    
    return schemaString;
}

// Generate Zod schema for a component and cache it
function getOrCreateComponentSchema(componentCtor: new (...args: any[]) => BaseComponent, componentId: string, fieldOptions?: ArcheTypeFieldOptions): z.ZodTypeAny | null {
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
        __typename: z.literal(compNameToFieldName(componentCtor.name))
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
        } else if (prop.isEnum && prop.enumValues && prop.enumKeys) {
            const enumTypeName = prop.propertyType?.name || `${componentCtor.name}_${prop.propertyKey}_Enum`;
            zodFields[prop.propertyKey] = z.enum(prop.enumValues as any).register(asEnumType, {
                name: enumTypeName,
                valuesConfig: prop.enumKeys.reduce((acc: Record<string, { description: string }>, key, idx) => { 
                    acc[key] = { description: prop.enumValues![idx]! }; 
                    return acc; 
                }, {})
            });
        } else if (customTypeRegistry.has(prop.propertyType)) {
            zodFields[prop.propertyKey] = customTypeRegistry.get(prop.propertyType)!;
        } else {
            zodFields[prop.propertyKey] = z.any();
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
// TODO: Implement archetype with GraphQL support
export function ArcheType<T extends new () => BaseArcheType>(nameOrOptions?: string | ArcheTypeOptions) {
    console.log("ArcheType decorator applied with:", nameOrOptions);
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
        console.log("archetypeFields for", archetype_name, ":", fields);
        if (fields) {
            for (const {propertyKey, component, options} of fields) {
                const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
                storage.collectArchetypeField(archetype_name, propertyKey, component, options, type);
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

/**
 * ArcheType provides a layer of abstraction for creating entities with predefined sets of components.
 * This makes entity creation more elegant and reduces code repetition.
 * 
 * Example usage:
 * ```typescript
 * const UserArcheType = new ArcheType([NameComponent, EmailComponent, PasswordComponent]);
 *
 * 
 * // FROM Request or other source 
 * const userInput = { name: "John Doe", email: "john@example.com", password: "securepassword" };
 * const entity = UserArcheType.fill(userInput).createEntity();
 * await entity.save();
 * ```
 */
class BaseArcheType {
    protected components: Set<{ ctor: new (...args: any[]) => BaseComponent, data: any }> = new Set();
    public componentMap: Record<string, typeof BaseComponent> = {}; 
    protected fieldOptions: Record<string, ArcheTypeFieldOptions> = {};
    protected fieldTypes: Record<string, any> = {};
    public resolver?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor() {
        const storage = getMetadataStorage();
        const archetypeName = this.constructor.name.replace(/ArcheType$/, '');
        const fields = storage.archetypes_field_map.get(archetypeName);
        if (fields) {
            for (const {fieldName, component, options, type} of fields) {
                this.componentMap[fieldName] = component;
                if (options) this.fieldOptions[fieldName] = options;
                if (type) this.fieldTypes[fieldName] = type;
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
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    this.addComponent(compCtor, { value });
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

    async updateEntity<T>(entity: Entity, updates: Partial<T>) {
        for (const key of Object.keys(updates)) {
            if(key === 'id' || key === '_id') continue;
            const value = updates[key as keyof T];
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    await entity.set(compCtor, { value });
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
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            if (exclude.includes(field)) continue;
            const comp = await entity.get(ctor as any);
            if (comp) {
                result[field] = (comp as any).value;
            }
        }
        // for direct fields
        for (const field of Object.keys(this.fieldTypes)) {
            if (exclude.includes(field)) continue;
            if (!this.componentMap[field]) {
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
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const typeId = storage.getComponentId(ctor.name);
            result[field] = storage.getComponentProperties(typeId);
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
            resolver: (parent: any) => parent.id
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
                    resolver: async (parent: any, args: any, context: any) => {
                        const entity = parent._entity;
                        if (!entity) return parent[field];
                        
                        // Use DataLoader if available
                        if (context.loaders) {
                            const componentData = await context.loaders.componentsByEntityType.load({
                                entityId: entity.id,
                                typeId: typeIdHex  // Pass hex string directly
                            });
                            return componentData?.data?.value;
                        }
                        
                        // Fallback: direct query
                        const comp = await entity.get(ctor as unknown);
                        return (comp as any)?.value;
                    }
                });
            } else {
                // For complex components, return the full component object
                resolvers.push({
                    typeName: archetypeName,
                    fieldName: field,
                    resolver: async (parent: any, args: any, context: any) => {
                        const entity = parent._entity;
                        if (!entity) return parent[field];
                        
                        // Use DataLoader if available
                        if (context.loaders) {
                            const componentData = await context.loaders.componentsByEntityType.load({
                                entityId: entity.id,
                                typeId: typeIdHex  // Pass hex string directly
                            });
                            return componentData?.data;
                        }
                        
                        // Fallback: direct query
                        const comp = await entity.get(ctor as unknown);
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
        console.log("Field Resolvers: ");
        console.log(resolvers)
        
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
        const zodShapes: Record<string, z.ZodTypeAny> = {};
        const storage = getMetadataStorage();
        for (const [field, ctor] of Object.entries(this.componentMap)) {
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
        const archetypeId = storage.getComponentId(this.constructor.name);
        const nameFromStorage = storage.archetypes.find(a => a.typeId === archetypeId)?.name || this.constructor.name;
        console.log("NameFromStorage: ",nameFromStorage)
        const shape: Record<string, z.ZodTypeAny> = {
            __typename: z.literal(nameFromStorage).nullish(),
            id: z.string().nullish(),  // Will be converted to ID in post-processing
        };
        for (const [field, zodType] of Object.entries(zodShapes)) {
            if (this.fieldOptions[field]?.nullable && zodType instanceof ZodObject) {
                shape[field] = zodType.optional();
            } else {
                shape[field] = zodType;
            }
        }
        const r = z.object(shape);
        const schema_arr = [r];
        const schema = weave(ZodWeaver, ...schema_arr);
        let graphqlSchemaString = printSchema(schema);
        
        // Post-process: Replace 'id: String' with 'id: ID' for all id fields
        graphqlSchemaString = graphqlSchemaString.replace(/\bid:\s*String\b/g, 'id: ID');
        
        console.log("WeavedSchema:", graphqlSchemaString);
        
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