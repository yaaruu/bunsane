import { createHash } from 'crypto';
import type { 
    ComponentMetadata,
    ComponentPropertyMetadata
 } from "./definitions/Component";
import { uuidv7 } from "utils/uuid";

function generateTypeId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}
export class MetadataStorage {
    components_ids_map: Map<string, string> = new Map();
    components: ComponentMetadata[] = [];
    componentProperties: Map<string, ComponentPropertyMetadata[]> = new Map();

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
    }

    collectComponentPropertyMetadata(metadata: ComponentPropertyMetadata ) {
        if(!this.componentProperties.has(metadata.component_id)) {
            this.componentProperties.set(metadata.component_id, []);
        }
        this.componentProperties.get(metadata.component_id)!.push(metadata);
    }
}

