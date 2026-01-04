import DataLoader from 'dataloader';
import { Entity } from './Entity';
import db from '../database';
import { inList } from '../database/sqlHelpers';
import {logger as MainLogger} from './Logger';
const logger = MainLogger.child({ module: 'RequestLoaders' });
import { getMetadataStorage } from './metadata';
import type { CacheManager } from './cache/CacheManager';

export type ComponentData = {
  id: string;  // Component ID for updates
  entityId: string; // Entity ID
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

export function createRequestLoaders(db: any, cacheManager?: CacheManager): RequestLoaders {
  const entityById = new DataLoader<string, Entity | null>(async (ids: readonly string[]) => {
    const startTime = Date.now();
    try {
      // Filter out empty/invalid IDs to prevent PostgreSQL UUID parsing errors
      const validIds = ids.filter(id => id && typeof id === 'string' && id.trim() !== '');
      if (validIds.length === 0) {
        return ids.map(() => null);
      }

      const uniqueIds = [...new Set(validIds)];
      const results = new Map<string, Entity | null>();

      // Note: Entity cache now only tracks existence, not full entity data
      // Full entities are always loaded from database for component access

      // Find missing entities that weren't in cache
      const missingIds = uniqueIds.filter(id => !results.has(id));
      
      if (missingIds.length > 0) {
        const idList = inList(missingIds, 1);
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

        // Cache the loaded entities if cache is enabled
        if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().entity?.enabled) {
          try {
            await cacheManager.setEntitiesWriteThrough(entities, cacheManager.getConfig().entity.ttl);
          } catch (error) {
            logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache write failed for entities', error });
          }
        }

        entities.forEach((e: Entity) => results.set(e.id, e));
      }

      const duration = Date.now() - startTime;
      if (duration > 1000) { // Log slow queries
        logger.warn(`Slow entityById query: ${duration}ms for ${ids.length} entities`);
      }
      
      // Return null for invalid IDs
      return ids.map(id => {
        if (!id || typeof id !== 'string' || id.trim() === '') return null;
        return results.get(id) ?? null;
      });
    } catch (error) {
      logger.error(`Error in entityById DataLoader:`, error);
      throw error;
    }
  }, {
    maxBatchSize: 100 // Prevent extremely large batches
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

        const results = new Map<string, ComponentData | null>();

        // Check cache first if cache manager is available
        let cacheHits = 0;
        let cacheMisses = 0;
        if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().component?.enabled) {
          try {
            const cachedComponents = await cacheManager.getComponents(validKeys);
            cachedComponents.forEach((component, index) => {
              if (component) {
                const key = `${validKeys[index].entityId}-${validKeys[index].typeId}`;
                results.set(key, component);
                cacheHits++;
              } else {
                cacheMisses++;
              }
            });
          } catch (error) {
            logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache read failed for components, falling back to database', error });
            cacheMisses += validKeys.length;
          }
        } else {
          cacheMisses += validKeys.length;
        }

        // Log cache hit/miss rates for monitoring
        if (validKeys.length > 0) {
          const hitRate = (cacheHits / validKeys.length) * 100;
          logger.debug({ 
            scope: 'cache', 
            component: 'RequestLoaders', 
            msg: 'Component cache statistics', 
            total: validKeys.length, 
            hits: cacheHits, 
            misses: cacheMisses, 
            hitRate: `${hitRate.toFixed(1)}%` 
          });
        }

        // Find missing components that weren't in cache
        const missingKeys = validKeys.filter(k => !results.has(`${k.entityId}-${k.typeId}`));
        
        if (missingKeys.length > 0) {
          const entityIds = [...new Set(missingKeys.map(k => k.entityId))];
          const typeIds = [...new Set(missingKeys.map(k => k.typeId))];
          const entityIdList = inList(entityIds, 1);
          const typeIdList = inList(typeIds, entityIdList.newParamIndex);
          const rows = await db.unsafe(`
            SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at
            FROM components
            WHERE entity_id IN ${entityIdList.sql}
              AND type_id IN ${typeIdList.sql}
              AND deleted_at IS NULL
          `, [...entityIdList.params, ...typeIdList.params]);
          
          const components: ComponentData[] = rows.map((row: any) => ({
            id: row.id,
            entityId: row.entity_id,
            typeId: row.type_id,
            data: row.data,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            deletedAt: row.deleted_at,
          }));

          // Cache the loaded components if cache is enabled
          if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().component?.enabled) {
            try {
              await cacheManager.setComponentsWriteThrough(components, cacheManager.getConfig().component.ttl);
            } catch (error) {
              logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache write failed for components', error });
            }
          }

          components.forEach((comp: ComponentData) => {
            const key = `${comp.entityId}-${comp.typeId}`;
            results.set(key, comp);
          });
        }

        const duration = Date.now() - startTime;
        if (duration > 1000) { // Log slow queries
          logger.warn(`Slow componentsByEntityType query: ${duration}ms for ${keys.length} keys`);
        }
        
        // Return null for keys with invalid entity IDs
        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') return null;
          return results.get(`${k.entityId}-${k.typeId}`) ?? null;
        });
      } catch (error) {
        logger.error(`Error in componentsByEntityType DataLoader:`, error);
        throw error;
      }
    },
    {
      maxBatchSize: 100 // Prevent extremely large batches
    }
  );

  const relationsByEntityField = new DataLoader<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }, Entity[]>(
    async (keys: readonly { entityId: string; relationField: string; relatedType: string; foreignKey?: string }[]) => {
      const startTime = Date.now();
      try {
        // Filter valid keys
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => []);
        }

        // Group keys by foreign key for efficient batching
        const keysByForeignKey = new Map<string, typeof validKeys>();
        for (const key of validKeys) {
          const fk = key.foreignKey || 'default';
          if (!keysByForeignKey.has(fk)) {
            keysByForeignKey.set(fk, []);
          }
          keysByForeignKey.get(fk)!.push(key);
        }

        const resultMap = new Map<string, Entity[]>();

        // OPTIMIZED: Batch query for each foreign key type (instead of N separate queries)
        for (const [foreignKey, groupedKeys] of keysByForeignKey) {
          const entityIds = [...new Set(groupedKeys.map(k => k.entityId))];
          const entityIdList = inList(entityIds, 1);

          let foreignKeyField: string;
          let whereClause: string;
          
          if (foreignKey !== 'default') {
            // Use specific foreign key from relation metadata
            foreignKeyField = foreignKey;
            whereClause = `c.data->>'${foreignKey}' = ANY($1)`;
          } else {
            // Fallback for backward compatibility
            foreignKeyField = 'user_id'; // Default field for result mapping
            whereClause = `(c.data->>'user_id' = ANY($1) OR c.data->>'parent_id' = ANY($1))`;
          }

          logger.trace(`[RelationLoader] Batched query for ${groupedKeys.length} keys with foreign key ${foreignKey}`);

          // SINGLE BATCHED QUERY for all entities in this group
          const rows = await db.unsafe(`
            SELECT DISTINCT 
              c.entity_id, 
              c.data, 
              c.type_id,
              c.data->>'${foreignKeyField}' as fk_value,
              COALESCE(c.data->>'user_id', c.data->>'parent_id') as fallback_fk_value
            FROM components c
            INNER JOIN entities e ON c.entity_id = e.id
            WHERE e.deleted_at IS NULL 
              AND c.deleted_at IS NULL
              AND ${whereClause}
          `, [entityIds]);

          logger.trace(`[RelationLoader] Found ${rows.length} total components for ${entityIds.length} entities`);

          // Map results back to original keys
          for (const key of groupedKeys) {
            const relatedEntityIds = rows
              .filter((row: any) => {
                // Match by specific foreign key or fallback
                const fkValue = foreignKey !== 'default' ? row.fk_value : row.fallback_fk_value;
                return fkValue === key.entityId;
              })
              .map((row: any) => row.entity_id);

            const uniqueEntityIds = [...new Set(relatedEntityIds)];
            const entities = uniqueEntityIds.map(id => {
              const entity = new Entity(id);
              entity.setPersisted(true);
              return entity;
            });

            const mapKey = `${key.entityId}-${key.relationField}-${key.relatedType}`;
            resultMap.set(mapKey, entities);
            
            logger.trace(`[RelationLoader] Mapped ${entities.length} entities for ${key.relationField} on ${key.entityId}`);
          }
        }

        const duration = Date.now() - startTime;
        if (duration > 1000) {
          logger.warn(`Slow relationsByEntityField query: ${duration}ms for ${keys.length} keys`);
        } else {
          logger.trace(`[RelationLoader] Batched query completed in ${duration}ms for ${keys.length} keys`);
        }

        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') {
            return [];
          }
          const mapKey = `${k.entityId}-${k.relationField}-${k.relatedType}`;
          const result = resultMap.get(mapKey) || [];
          return result;
        });
      } catch (error) {
        logger.error(`Error in relationsByEntityField DataLoader:`);
        logger.error(error);
        // Return empty arrays for all keys on error
        return keys.map(() => []);
      }
    },
    {
      // Add batch size limit to prevent extremely large queries
      maxBatchSize: 50
    }
  );

  return { entityById, componentsByEntityType, relationsByEntityField };
}