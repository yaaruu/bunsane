import { Entity } from "core/Entity";
import { BaseComponent } from "core/Components";
import { timed } from "./Decorators";
export class BatchLoader {
    @timed("BatchLoader.loadRelatedEntities")
    static async loadRelatedEntities<C extends BaseComponent & { value: string }>(
        entities: Entity[],
        component: new () => C,
        loader: (ids: string[]) => Promise<Entity[]>
    ): Promise<Map<string, Entity>> {
        const ids: string[] = [];
        for (const entity of entities) {
            const data = await entity.get(component) as any;
            if (data?.value) {
                ids.push(data.value);
            }
        }
        const uniqueIds = [...new Set(ids)];
        const relatedEntities = await loader(uniqueIds);
        const map = new Map<string, Entity>();
        for (const related of relatedEntities) {
            map.set(related.id, related);
        }
        return map;
    }
}