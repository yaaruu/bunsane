import { createHash } from 'crypto';
import type { 
    ComponentMetadata,
    ComponentPropertyMetadata,
    IndexedFieldMetadata
 } from "./definitions/Component";
import type { ArcheTypeMetadata, ArcheTypeFieldOptions, ArcheTypeFunctionMetadata } from './definitions/ArcheType';
import type { RelationOptions } from '../ArcheType';

// Mirror of decorators.archetypeFunctionsSymbol — referenced via the global symbol
// registry to avoid a circular import between metadata-storage and archetype/decorators.
const archetypeFunctionsSymbol = Symbol.for("bunsane:archetypeFunctions");

type ArcheTypeFunctionOptions = ArcheTypeFunctionMetadata["options"];
type ArcheTypeFunctionHandler = (entity: any, ...args: any[]) => any;

function generateTypeId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

type ArcheTypeRelationMap = {fieldName: string, relatedArcheType: new (...args: any[]) => any | string, relationType: 'hasMany' | 'belongsTo' | 'hasOne' | 'belongsToMany', options?: RelationOptions, type?: any}
type ArcheTypeFieldMap = {fieldName: string, component: new (...args: any[]) => any, options?: ArcheTypeFieldOptions, type?: any};
type ArcheTypeUnionMap = {fieldName: string, components: (new (...args:any[]) => any)[], options?: ArcheTypeFieldOptions, type?:any};
export class MetadataStorage {
    components_ids_map: Map<string, string> = new Map();
    components: ComponentMetadata[] = [];
    components_map: Map<string, ComponentMetadata> = new Map();
    componentProperties: Map<string, ComponentPropertyMetadata[]> = new Map();
    indexedFields: Map<string, IndexedFieldMetadata[]> = new Map();
    archetypes: ArcheTypeMetadata[] = [];
    archetypes_field_map: Map<string, ArcheTypeFieldMap[]> = new Map();
    archetypes_relations_map: Map<string, ArcheTypeRelationMap[]> = new Map();
    archetypes_union_map: Map<string, ArcheTypeUnionMap[]> = new Map();


    graphql_types: Map<string, any> = new Map();

    getComponentId(componentName: string): string {
        if(this.components_ids_map.has(componentName)) {
            return this.components_ids_map.get(componentName)!;
        }
        const typeId = generateTypeId(componentName);
        this.components_ids_map.set(componentName, typeId);
        return typeId;
    }

    collectComponentMetadata(metadata: ComponentMetadata) {
        this.components.push(metadata);
        this.components_map.set(metadata.name, metadata);
    }


    collectComponentPropertyMetadata(metadata: ComponentPropertyMetadata ) {
        if(!this.componentProperties.has(metadata.component_id)) {
            this.componentProperties.set(metadata.component_id, []);
        }
        this.componentProperties.get(metadata.component_id)!.push(metadata);
    }

    collectIndexedFieldMetadata(metadata: IndexedFieldMetadata) {
        if(!this.indexedFields.has(metadata.componentId)) {
            this.indexedFields.set(metadata.componentId, []);
        }
        this.indexedFields.get(metadata.componentId)!.push(metadata);
    }

    getIndexedFields(componentId: string): IndexedFieldMetadata[] {
        return this.indexedFields.get(componentId) || [];
    }


    getComponentProperties(component_id: string): ComponentPropertyMetadata[] {
        return this.componentProperties.get(component_id) || [];
    }

    collectArchetypeField(archetype_id: string, fieldName: string, component: new (...args: any[]) => any, options?: ArcheTypeFieldOptions, type?: any) {
        if(!this.archetypes_field_map.has(archetype_id)) {
            this.archetypes_field_map.set(archetype_id, []);
        }
        this.archetypes_field_map.get(archetype_id)!.push({fieldName, component, options, type});
    }

    collectArchetypeUnion(archetype_id: string, fieldName: string, components: (new (...args: any[]) => any)[], options?: ArcheTypeFieldOptions, type?: any) {
        if(!this.archetypes_union_map.has(archetype_id)) {
            this.archetypes_union_map.set(archetype_id, []);
        }
        this.archetypes_union_map.get(archetype_id)!.push({fieldName, components, options, type});
    }

    collectArchetypeRelation(archetype_id: string, fieldName: string, relatedArcheType: new (...args: any[]) => any | string, relationType: 'hasMany' | 'belongsTo' | 'hasOne' | 'belongsToMany', options?: RelationOptions, type?: any) {
        if(!this.archetypes_relations_map.has(archetype_id)) {
            this.archetypes_relations_map.set(archetype_id, []);
        }
        this.archetypes_relations_map.get(archetype_id)!.push({fieldName, relatedArcheType, relationType, options, type});
    }

    /**
     * Register a computed (@ArcheTypeFunction-equivalent) field at runtime, with no decorator.
     *
     * Wires all three sites the decorator path touches in one call:
     *  - prototype symbol array → instances pick it up via `this.functions`
     *  - prototype method → resolver invokes `archetype[propertyKey](entity, ...)`
     *  - archetype metadata.functions → weaver emits the field in the SDL
     *
     * The archetype must already be registered (via @ArcheType or runtime registration)
     * so its target class is known; throws otherwise.
     */
    collectArchetypeFunction(
        name: string,
        propertyKey: string,
        handler: ArcheTypeFunctionHandler,
        options?: ArcheTypeFunctionOptions
    ) {
        const metadata = this.archetypes.find(a => a.name === name);
        if (!metadata) {
            throw new Error(`Cannot register function '${propertyKey}': archetype '${name}' is not registered`);
        }

        const prototype = (metadata.target as any).prototype;

        // 1. prototype symbol array (consumed by BaseArcheType ctor → this.functions)
        if (!prototype[archetypeFunctionsSymbol]) {
            prototype[archetypeFunctionsSymbol] = [];
        }
        const protoFns: ArcheTypeFunctionMetadata[] = prototype[archetypeFunctionsSymbol];
        const protoIdx = protoFns.findIndex(f => f.propertyKey === propertyKey);
        if (protoIdx !== -1) {
            protoFns[protoIdx] = { propertyKey, options };
        } else {
            protoFns.push({ propertyKey, options });
        }

        // 2. prototype method (invoked by the field resolver)
        prototype[propertyKey] = handler;

        // 3. metadata.functions (read by the weaver to build SDL)
        if (!metadata.functions) {
            metadata.functions = [];
        }
        const metaIdx = metadata.functions.findIndex(f => f.propertyKey === propertyKey);
        if (metaIdx !== -1) {
            metadata.functions[metaIdx] = { propertyKey, options };
        } else {
            metadata.functions.push({ propertyKey, options });
        }
    }

    collectArcheTypeMetadata(metadata: ArcheTypeMetadata) {
        // Check if archetype already exists and update it
        const existingIndex = this.archetypes.findIndex(
            a => a.typeId === metadata.typeId
        );
        if (existingIndex !== -1) {
            // Update existing metadata
            const existing = this.archetypes[existingIndex];
            if (existing && metadata.functions) {
                existing.functions = metadata.functions;
            }
        } else {
            // Add new metadata
            this.archetypes.push(metadata);
        }
    }
}

