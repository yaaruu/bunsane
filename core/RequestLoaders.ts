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
    const uniqueIds = [...new Set(ids)];
    const rows = await db`
      SELECT id
      FROM entities
      WHERE id IN ${inList(uniqueIds)}
        AND deleted_at IS NULL
    `;
    const entities = rows.map((row: any) => {
      const entity = new Entity(row.id);
      entity.setPersisted(true);
      return entity;
    });
    const map = new Map<string, Entity>();
    entities.forEach((e: Entity) => map.set(e.id, e));
    return ids.map(id => map.get(id) ?? null);
  });

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: number }, ComponentData | null>(
    async (keys: readonly { entityId: string; typeId: number }[]) => {
      const entityIds = [...new Set(keys.map(k => k.entityId))];
      const typeIds = [...new Set(keys.map(k => k.typeId))];
      const rows = await db`
        SELECT entity_id, type_id, data, created_at, updated_at, deleted_at
        FROM components
        WHERE entity_id IN ${inList(entityIds)}
          AND type_id IN ${inList(typeIds)}
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
      return keys.map(k => map.get(`${k.entityId}-${k.typeId}`) ?? null);
    }
  );

  return { entityById, componentsByEntityType };
}