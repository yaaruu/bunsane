import DataLoader from 'dataloader';
import { Entity } from './Entity';
import db from '../database';
import { inList } from '../database/sqlHelpers';
import {logger as MainLogger} from './Logger';
const logger = MainLogger.child({ module: 'RequestLoaders' });
import { getMetadataStorage } from './metadata';

export type ComponentData = {
  id: string;  // Component ID for updates
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
      // Filter out empty/invalid IDs to prevent PostgreSQL UUID parsing errors
      const validIds = ids.filter(id => id && typeof id === 'string' && id.trim() !== '');
      if (validIds.length === 0) {
        return ids.map(() => null);
      }
      const uniqueIds = [...new Set(validIds)];
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
      
      // Return null for invalid IDs
      return ids.map(id => {
        if (!id || typeof id !== 'string' || id.trim() === '') return null;
        return map.get(id) ?? null;
      });
    } catch (error) {
      console.error(`Error in entityById DataLoader:`, error);
      throw error;
    }
  });

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: string }, ComponentData | null>(
    async (keys: readonly { entityId: string; typeId: string }[]) => {
      const startTime = Date.now();
      try {
        // Filter out keys with empty/invalid entity IDs to prevent PostgreSQL UUID parsing errors
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => null);
        }
        const entityIds = [...new Set(validKeys.map(k => k.entityId))];
        const typeIds = [...new Set(validKeys.map(k => k.typeId))];
        const entityIdList = inList(entityIds, 1);
        const typeIdList = inList(typeIds, entityIdList.newParamIndex);
        const rows = await db.unsafe(`
          SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at
          FROM components
          WHERE entity_id IN ${entityIdList.sql}
            AND type_id IN ${typeIdList.sql}
            AND deleted_at IS NULL
        `, [...entityIdList.params, ...typeIdList.params]);
        const map = new Map<string, ComponentData>();
        rows.forEach((row: any) => {
          const key = `${row.entity_id}-${row.type_id}`;
          map.set(key, {
            id: row.id,  // Include component ID for updates
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
        
        // Return null for keys with invalid entity IDs
        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') return null;
          return map.get(`${k.entityId}-${k.typeId}`) ?? null;
        });
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
          
          // Skip keys with empty/invalid entity IDs to prevent PostgreSQL UUID parsing errors
          if (!key.entityId || typeof key.entityId !== 'string' || key.entityId.trim() === '') {
            const mapKey = `${key.entityId}-${key.relationField}-${key.relatedType}`;
            resultMap.set(mapKey, []);
            continue;
          }
          
          try {
            logger.trace(`[RelationLoader] Looking for ${key.relatedType} entities with foreign key ${key.foreignKey || 'auto-detect'} pointing to ${key.entityId} for field ${key.relationField}`);

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

            logger.trace(`[RelationLoader] Found ${rows.length} components with foreign keys pointing to ${key.entityId}`);
            rows.forEach((row: any) => {
              logger.trace(`[RelationLoader] Component ${row.type_id} on entity ${row.entity_id}:`, row.data);
            });
            
            // Create Entity objects for each related entity
            const entityIds = [...new Set(rows.map((row: any) => row.entity_id as string))];
            relatedEntities = entityIds.map((id: string) => {
              const entity = new Entity(id);
              entity.setPersisted(true);
              return entity;
            });

            logger.trace(`[RelationLoader] Created ${relatedEntities.length} related entities for ${key.relationField}`);

          } catch (queryError) {
            logger.error(`Error querying relations for ${key.entityId}:`);
            logger.error(queryError);
            relatedEntities = [];
          }
          
          const mapKey = `${key.entityId}-${key.relationField}-${key.relatedType}`;
          resultMap.set(mapKey, relatedEntities);
        }
        
        const duration = Date.now() - startTime;
        if (duration > 1000) {
          logger.warn(`Slow relationsByEntityField query: ${duration}ms for ${keys.length} keys`);
        }
        
        return keys.map(k => {
          const mapKey = `${k.entityId}-${k.relationField}-${k.relatedType}`;
          const result = resultMap.get(mapKey) || [];
          logger.trace(`[RelationLoader] Returning ${result.length} entities for ${k.relationField} on ${k.entityId}`);
          return result;
        });
      } catch (error) {
        logger.error(`Error in relationsByEntityField DataLoader:`);
        logger.error(error);
        // Return empty arrays for all keys on error
        return keys.map(() => []);
      }
    }
  );

  return { entityById, componentsByEntityType, relationsByEntityField };
}