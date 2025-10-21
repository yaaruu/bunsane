import { Entity } from "core/Entity";
import { BaseComponent } from "core/Components";
import { timed } from "./Decorators";
import db from "../database";
import { sql } from "bun";

class EntityPool {
    private static instance: EntityPool;
    private pool: Map<string, Entity[]> = new Map();
    private maxPoolSize = 1000;

    static getInstance(): EntityPool {
        if (!EntityPool.instance) {
            EntityPool.instance = new EntityPool();
        }
        return EntityPool.instance;
    }

    get(entityId: string): Entity | null {
        const entities = this.pool.get(entityId);
        if (entities && entities.length > 0) {
            return entities.pop()!;
        }
        return null;
    }

    put(entity: Entity): void {
        const entityId = entity.id;
        let entities = this.pool.get(entityId);
        if (!entities) {
            entities = [];
            this.pool.set(entityId, entities);
        }
        if (entities.length < this.maxPoolSize) {
            entities.push(entity);
        }
    }

    clear(): void {
        this.pool.clear();
    }
}

export class BatchLoader {
    private static entityPool = EntityPool.getInstance();

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
    static async loadRelatedEntitiesBatched<C extends BaseComponent>(
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