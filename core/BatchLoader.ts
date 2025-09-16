import { Entity } from "core/Entity";
import { BaseComponent } from "core/Components";
import { timed } from "./Decorators";
import db from "../database";
import { sql } from "bun";
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

    @timed("BatchLoader.loadRelatedEntitiesBatched")
    static async loadRelatedEntitiesBatched<C extends BaseComponent & { value: string }>(
        entities: Entity[],
        component: new () => C,
        loader: (ids: string[]) => Promise<Entity[]>
    ): Promise<Map<string, Entity>> {
        if (entities.length === 0) return new Map();

        const comp = new component();
        const typeId = comp.getTypeID();
        const parentIds = entities.map(e => e.id);

        const rows = await db`
            SELECT c.entity_id, (c.data->>'value') AS related_id
            FROM components c
            WHERE c.entity_id IN ${sql(parentIds)}
              AND c.type_id = ${typeId}
              AND c.deleted_at IS NULL
        `;

        const uniqueIds = [...new Set(rows.map((r: any) => r.related_id).filter(Boolean))] as string[];
        if (uniqueIds.length === 0) return new Map();

        const relatedEntities = await loader(uniqueIds);
        const map = new Map<string, Entity>();
        for (const related of relatedEntities) {
            map.set(related.id, related);
        }
        return map;
    }
}