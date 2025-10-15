import DataLoader from 'dataloader';
import { Entity } from './Entity';
import db from '../database';
import { inList } from '../database/sqlHelpers';
import { getMetadataStorage } from './metadata';

export type ComponentData = {
  typeId: string;
  data: any;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type RequestLoaders = {
  entityById: DataLoader<string, Entity | null>;
  componentsByEntityType: DataLoader<{ entityId: string; typeId: string }, ComponentData | null>;
  relationsByEntityField: DataLoader<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }, Entity[]>;
};

export function createRequestLoaders(db: any): RequestLoaders {
  const entityById = new DataLoader<string, Entity | null>(async (ids: readonly string[]) => {
    const startTime = Date.now();
    try {
      const uniqueIds = [...new Set(ids)];
      const idList = inList(uniqueIds, 1);
      const rows = await db.unsafe(`
        SELECT id
        FROM entities
        WHERE id IN ${idList.sql}
          AND deleted_at IS NULL
      `, idList.params);
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

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: string }, ComponentData | null>(
    async (keys: readonly { entityId: string; typeId: string }[]) => {
      const startTime = Date.now();
      try {
        const entityIds = [...new Set(keys.map(k => k.entityId))];
        const typeIds = [...new Set(keys.map(k => k.typeId))];
        const entityIdList = inList(entityIds, 1);
        const typeIdList = inList(typeIds, entityIdList.newParamIndex);
        const rows = await db.unsafe(`
          SELECT entity_id, type_id, data, created_at, updated_at, deleted_at
          FROM components
          WHERE entity_id IN ${entityIdList.sql}
            AND type_id IN ${typeIdList.sql}
            AND deleted_at IS NULL
        `, [...entityIdList.params, ...typeIdList.params]);
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

  const relationsByEntityField = new DataLoader<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }, Entity[]>(
    async (keys: readonly { entityId: string; relationField: string; relatedType: string; foreignKey?: string }[]) => {
      const startTime = Date.now();
      try {
        // Group keys by relation type for efficient querying
        const resultMap = new Map<string, Entity[]>();
        
        // For each key, find related entities based on foreign key relationships
        for (const key of keys) {
          let relatedEntities: Entity[] = [];
          
          try {
            console.log(`[RelationLoader] Looking for ${key.relatedType} entities with foreign key ${key.foreignKey || 'auto-detect'} pointing to ${key.entityId} for field ${key.relationField}`);
            
            let whereClause: string;
            if (key.foreignKey) {
              // Use specific foreign key from relation metadata
              whereClause = `(c.data->>'${key.foreignKey}' = $1)`;
            } else {
              // Fallback to common patterns for backward compatibility
              // TODO: Remove this fallback in future versions
              whereClause = `(
                (c.data->>'user_id' = $1) OR
                (c.data->>'parent_id' = $1)
              )`;
            }
            
            // Look for entities that have components with foreign keys pointing to our entity
            const rows = await db.unsafe(`
              SELECT DISTINCT c.entity_id, c.data, c.type_id
              FROM components c
              INNER JOIN entities e ON c.entity_id = e.id
              WHERE e.deleted_at IS NULL 
                AND c.deleted_at IS NULL
                AND ${whereClause}
            `, [key.entityId]);
            
            console.log(`[RelationLoader] Found ${rows.length} components with foreign keys pointing to ${key.entityId}`);
            rows.forEach((row: any) => {
              console.log(`[RelationLoader] Component ${row.type_id} on entity ${row.entity_id}:`, row.data);
            });
            
            // Create Entity objects for each related entity
            const entityIds = [...new Set(rows.map((row: any) => row.entity_id as string))];
            relatedEntities = entityIds.map((id: string) => {
              const entity = new Entity(id);
              entity.setPersisted(true);
              return entity;
            });
            
            console.log(`[RelationLoader] Created ${relatedEntities.length} related entities for ${key.relationField}`);
            
          } catch (queryError) {
            console.error(`Error querying relations for ${key.entityId}:`, queryError);
            relatedEntities = [];
          }
          
          const mapKey = `${key.entityId}-${key.relationField}-${key.relatedType}`;
          resultMap.set(mapKey, relatedEntities);
        }
        
        const duration = Date.now() - startTime;
        if (duration > 1000) {
          console.warn(`Slow relationsByEntityField query: ${duration}ms for ${keys.length} keys`);
        }
        
        return keys.map(k => {
          const mapKey = `${k.entityId}-${k.relationField}-${k.relatedType}`;
          const result = resultMap.get(mapKey) || [];
          console.log(`[RelationLoader] Returning ${result.length} entities for ${k.relationField} on ${k.entityId}`);
          return result;
        });
      } catch (error) {
        console.error(`Error in relationsByEntityField DataLoader:`, error);
        // Return empty arrays for all keys on error
        return keys.map(() => []);
      }
    }
  );

  return { entityById, componentsByEntityType, relationsByEntityField };
}