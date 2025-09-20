import DataLoader from 'dataloader';
import { Entity } from './Entity';
import db from '../database';
import { inList } from '../database/sqlHelpers';

export type ComponentData = {
  typeId: number;
  data: any;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type RequestLoaders = {
  entityById: DataLoader<string, Entity | null>;
  componentsByEntityType: DataLoader<{ entityId: string; typeId: number }, ComponentData | null>;
};

export function createRequestLoaders(db: any): RequestLoaders {
  const entityById = new DataLoader<string, Entity | null>(async (ids: readonly string[]) => {
    const startTime = Date.now();
    try {
      const uniqueIds = [...new Set(ids)];
      const rows = await db`
        SELECT id
        FROM entities
        WHERE id IN ${inList(uniqueIds, 1)}
          AND deleted_at IS NULL
      `;
      const entities = rows.map((row: any) => {
        const entity = new Entity(row.id);
        entity.setPersisted(true);
        return entity;
      });
      const map = new Map<string, Entity>();
      entities.forEach((e: Entity) => map.set(e.id, e));
      
      const duration = Date.now() - startTime;
      if (duration > 1000) { // Log slow queries
        console.warn(`Slow entityById query: ${duration}ms for ${ids.length} entities`);
      }
      
      return ids.map(id => map.get(id) ?? null);
    } catch (error) {
      console.error(`Error in entityById DataLoader:`, error);
      throw error;
    }
  });

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: number }, ComponentData | null>(
    async (keys: readonly { entityId: string; typeId: number }[]) => {
      const startTime = Date.now();
      try {
        const entityIds = [...new Set(keys.map(k => k.entityId))];
        const typeIds = [...new Set(keys.map(k => k.typeId))];
        const rows = await db`
          SELECT entity_id, type_id, data, created_at, updated_at, deleted_at
          FROM components
          WHERE entity_id IN ${inList(entityIds, 1)}
            AND type_id IN ${inList(typeIds, entityIds.length + 1)}
            AND deleted_at IS NULL
        `;
        const map = new Map<string, ComponentData>();
        rows.forEach((row: any) => {
          const key = `${row.entity_id}-${row.type_id}`;
          map.set(key, {
            typeId: row.type_id,
            data: row.data,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            deletedAt: row.deleted_at,
          });
        });
        
        const duration = Date.now() - startTime;
        if (duration > 1000) { // Log slow queries
          console.warn(`Slow componentsByEntityType query: ${duration}ms for ${keys.length} keys`);
        }
        
        return keys.map(k => map.get(`${k.entityId}-${k.typeId}`) ?? null);
      } catch (error) {
        console.error(`Error in componentsByEntityType DataLoader:`, error);
        throw error;
      }
    }
  );

  return { entityById, componentsByEntityType };
}