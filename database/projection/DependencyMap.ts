import { getMetadataStorage } from '../../core/metadata';
import { deriveProjectedColumns } from './ProjectionMetadata';

export function buildDependencyMap(
    archetypeNames: string[],
    storage = getMetadataStorage()
): Map<string, string[]> {
    const map = new Map<string, string[]>();

    for (const archetypeName of archetypeNames) {
        const cols = deriveProjectedColumns(archetypeName, storage);
        const componentNames = Array.from(new Set(cols.map(col => col.component)));
        for (const componentName of componentNames) {
            const typeId = storage.getComponentId(componentName);
            const archetypes = map.get(typeId) ?? [];
            archetypes.push(archetypeName);
            map.set(typeId, archetypes);
        }
    }

    return map;
}
