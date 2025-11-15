import { createHash } from 'crypto';
import type { 
    ComponentMetadata,
    ComponentPropertyMetadata,
    IndexedFieldMetadata
 } from "./definitions/Component";
import type { ArcheTypeMetadata, ArcheTypeFieldOptions } from './definitions/ArcheType';
import type { RelationOptions } from '../ArcheType';

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

    collectArcheTypeMetadata(metadata: ArcheTypeMetadata) {
        this.archetypes.push(metadata);
    }
}

