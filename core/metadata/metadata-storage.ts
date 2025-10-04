import { createHash } from 'crypto';
import type { 
    ComponentMetadata,
    ComponentPropertyMetadata
 } from "./definitions/Component";
import type { ArcheTypeMetadata } from './definitions/ArcheType';

function generateTypeId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

export class MetadataStorage {
    components_ids_map: Map<string, string> = new Map();
    components: ComponentMetadata[] = [];
    components_map: Map<string, ComponentMetadata> = new Map();
    componentProperties: Map<string, ComponentPropertyMetadata[]> = new Map();
    archetypes: ArcheTypeMetadata[] = [];
    archetypes_field_map: Map<string, string[]> = new Map();


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


    getComponentProperties(component_id: string): ComponentPropertyMetadata[] {
        return this.componentProperties.get(component_id) || [];
    }

    collectArchetypeField(archetype_id: string, fieldName: string) {
        if(!this.archetypes_field_map.has(archetype_id)) {
            this.archetypes_field_map.set(archetype_id, []);
        }
        this.archetypes_field_map.get(archetype_id)!.push(fieldName);
    }

    collectArcheTypeMetadata(metadata: ArcheTypeMetadata) {
        this.archetypes.push(metadata);
    }
}

