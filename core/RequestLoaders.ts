import DataLoader from 'dataloader';
import { Entity } from './Entity';
import db from '../database';
import { inList } from '../database/sqlHelpers';
import { timedUnsafe, incrementDataLoaderCall, type PerRequestCounters } from '../database/instrumentedDb';
import {logger as MainLogger} from './Logger';
const logger = MainLogger.child({ module: 'RequestLoaders' });
import { getMetadataStorage } from './metadata';
import type { CacheManager } from './cache/CacheManager';
import { COMPONENT_TOMBSTONE } from './cache/CacheManager';

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
  relationsByComponentFk: DataLoader<{ entityId: string; componentTypeId: string; foreignKeyField: string }, Entity[]>;
};

export function createRequestLoaders(
  db: any,
  cacheManager?: CacheManager,
  signal?: AbortSignal,
  perRequest?: PerRequestCounters,
): RequestLoaders {
  const entityById = new DataLoader<string, Entity | null>(async (ids: readonly string[]) => {
    incrementDataLoaderCall('entity', perRequest);
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
        const rows = await timedUnsafe<any[]>(db, `
          SELECT id
          FROM entities
          WHERE id IN ${idList.sql}
            AND deleted_at IS NULL
        `, idList.params, signal, perRequest);
        
        const entities = rows.map((row: any) => {
          const entity = new Entity(row.id);
          entity.setPersisted(true);
          return entity;
        });

        // Cache the loaded entities if cache is enabled
        if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().entity?.enabled) {
          try {
            await cacheManager.setEntitiesWriteThrough(entities, cacheManager.getConfig().entity!.ttl);
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
    } catch (error: any) {
      logger.error(`Error in entityById DataLoader:`, error);
      throw error;
    }
  }, {
    maxBatchSize: 100 // Prevent extremely large batches
  });

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: string }, ComponentData | null, string>(
    async (keys: readonly { entityId: string; typeId: string }[]) => {
      incrementDataLoaderCall('component', perRequest);
      const startTime = Date.now();
      try {
        // Filter out keys with empty/invalid entity IDs to prevent PostgreSQL UUID parsing errors
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => null);
        }

        const results = new Map<string, ComponentData | null>();

        // Check cache first if cache manager is available. Tombstone hits
        // are recorded as null in `results` so the DB-fetch step skips them.
        let cacheHits = 0;
        let cacheMisses = 0;
        if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().component?.enabled) {
          try {
            const cachedComponents = await cacheManager.getComponents(validKeys);
            cachedComponents.forEach((value, index) => {
              const key = `${validKeys[index]!.entityId}-${validKeys[index]!.typeId}`;
              if (value === COMPONENT_TOMBSTONE) {
                results.set(key, null);
                cacheHits++;
              } else if (value) {
                results.set(key, value);
                cacheHits++;
              } else {
                cacheMisses++;
              }
            });
          } catch (error: any) {
            logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache read failed for components, falling back to database', error });
            cacheMisses += validKeys.length;
          }
        } else {
          cacheMisses += validKeys.length;
        }

        if (validKeys.length > 0) {
          const hitRate = (cacheHits / validKeys.length) * 100;
          logger.trace({
            scope: 'cache',
            component: 'RequestLoaders',
            msg: 'Component cache statistics',
            total: validKeys.length,
            hits: cacheHits,
            misses: cacheMisses,
            hitRate: `${hitRate.toFixed(1)}%`,
          });
        }

        // Find missing components that weren't in cache
        const missingKeys = validKeys.filter(k => !results.has(`${k.entityId}-${k.typeId}`));
        
        if (missingKeys.length > 0) {
          const entityIds = [...new Set(missingKeys.map(k => k.entityId))];
          const typeIds = [...new Set(missingKeys.map(k => k.typeId))];
          const entityIdList = inList(entityIds, 1);
          const typeIdList = inList(typeIds, entityIdList.newParamIndex);
          const rows = await timedUnsafe<any[]>(db, `
            SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at
            FROM components
            WHERE entity_id IN ${entityIdList.sql}
              AND type_id IN ${typeIdList.sql}
              AND deleted_at IS NULL
          `, [...entityIdList.params, ...typeIdList.params], signal, perRequest);
          
          const components: ComponentData[] = rows.map((row: any) => ({
            id: row.id,
            entityId: row.entity_id,
            typeId: row.type_id,
            data: row.data,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            deletedAt: row.deleted_at,
          }));

          // Cache the loaded components + tombstone any requested keys whose
          // row was absent (single setMany — see CacheManager.setComponentsWriteThrough).
          if (cacheManager && cacheManager.getConfig().enabled && cacheManager.getConfig().component?.enabled) {
            try {
              await cacheManager.setComponentsWriteThrough(
                components,
                missingKeys,
                cacheManager.getConfig().component!.ttl,
              );
            } catch (error: any) {
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
      } catch (error: any) {
        logger.error(`Error in componentsByEntityType DataLoader:`, error);
        throw error;
      }
    },
    {
      maxBatchSize: 100, // Prevent extremely large batches
      // Object keys default to identity (===) comparison, which never dedups
      // distinct literals — collapse to a stable string so sibling resolvers
      // requesting the same (entity, type) share one load within a request.
      cacheKeyFn: (k: { entityId: string; typeId: string }) => `${k.entityId}\x00${k.typeId}`,
    }
  );

  const relationsByEntityField = new DataLoader<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }, Entity[], string>(
    async (keys: readonly { entityId: string; relationField: string; relatedType: string; foreignKey?: string }[]) => {
      incrementDataLoaderCall('relation', perRequest);
      const startTime = Date.now();
      try {
        // Filter valid keys
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => []);
        }

        const resultMap = new Map<string, Entity[]>();

        // Negative-cache lookup: skip DB for keys recorded as empty.
        let keysToQuery = validKeys;
        const relCacheEnabled = !!(cacheManager
          && cacheManager.getConfig().enabled
          && cacheManager.getConfig().relation?.negativeCacheEnabled);
        if (relCacheEnabled) {
          try {
            const tombstones = await cacheManager!.getRelationsEmpty(validKeys);
            const remaining: typeof validKeys = [];
            tombstones.forEach((isEmpty, i) => {
              const k = validKeys[i]!;
              if (isEmpty) {
                const mapKey = `${k.entityId}\x00${k.relationField}\x00${k.relatedType}`;
                resultMap.set(mapKey, []);
              } else {
                remaining.push(k);
              }
            });
            keysToQuery = remaining;
          } catch (error) {
            logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache read failed for relation tombstones', error });
          }
        }

        // Group keys by foreign key for efficient batching
        const keysByForeignKey = new Map<string, typeof keysToQuery>();
        for (const key of keysToQuery) {
          const fk = key.foreignKey || 'default';
          if (!keysByForeignKey.has(fk)) {
            keysByForeignKey.set(fk, []);
          }
          keysByForeignKey.get(fk)!.push(key);
        }

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
          const rows = await timedUnsafe<any[]>(db, `
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
          `, [entityIds], signal, perRequest);

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
              const entity = new Entity(id as string);
              entity.setPersisted(true);
              return entity;
            });

            // Use null byte separator to prevent key collision when fields contain hyphens
            const mapKey = `${key.entityId}\x00${key.relationField}\x00${key.relatedType}`;
            resultMap.set(mapKey, entities);
            
            logger.trace(`[RelationLoader] Mapped ${entities.length} entities for ${key.relationField} on ${key.entityId}`);
          }
        }

        // Write tombstones for queried keys whose result was empty.
        if (relCacheEnabled && keysToQuery.length > 0) {
          const emptyKeys = keysToQuery.filter(k => {
            const mapKey = `${k.entityId}\x00${k.relationField}\x00${k.relatedType}`;
            const r = resultMap.get(mapKey);
            return !r || r.length === 0;
          });
          if (emptyKeys.length > 0) {
            try {
              await cacheManager!.setRelationsEmpty(emptyKeys);
            } catch (error) {
              logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache write failed for relation tombstones', error });
            }
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
          // Use null byte separator to prevent key collision when fields contain hyphens
          const mapKey = `${k.entityId}\x00${k.relationField}\x00${k.relatedType}`;
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
      maxBatchSize: 50,
      // Stable string key (null-byte separated, matches the result-map key) so
      // identical relation requests dedup within a request instead of being
      // treated as distinct object identities.
      cacheKeyFn: (k: { entityId: string; relationField: string; relatedType: string; foreignKey?: string }) =>
        `${k.entityId}\x00${k.relationField}\x00${k.relatedType}\x00${k.foreignKey ?? ''}`,
    }
  );

  // Type-scoped foreign-key relation loader. Backs @HasMany/@BelongsToMany
  // array relations that declare a `foreignKey`. Previously those resolved one
  // `new Query().exec()` PER PARENT ROW (a hard N+1). This batches all parents
  // sharing a (componentType, fkField) into a single `data->>'fk' = ANY($2)`
  // query. Unlike relationsByEntityField it pins `type_id`, preserving the
  // exact semantics of the per-parent Query (which filtered by the specific
  // component type) rather than matching any component sharing the field name.
  const relationsByComponentFk = new DataLoader<{ entityId: string; componentTypeId: string; foreignKeyField: string }, Entity[], string>(
    async (keys: readonly { entityId: string; componentTypeId: string; foreignKeyField: string }[]) => {
      incrementDataLoaderCall('relation', perRequest);
      const startTime = Date.now();
      try {
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) return keys.map(() => []);

        const resultMap = new Map<string, Entity[]>();

        // Group by (componentTypeId, foreignKeyField) so each distinct relation
        // shape is one batched query.
        const groups = new Map<string, typeof validKeys>();
        for (const key of validKeys) {
          const gk = `${key.componentTypeId}\x00${key.foreignKeyField}`;
          if (!groups.has(gk)) groups.set(gk, []);
          groups.get(gk)!.push(key);
        }

        for (const [gk, groupedKeys] of groups) {
          const sep = gk.indexOf('\x00');
          const componentTypeId = gk.slice(0, sep);
          const foreignKeyField = gk.slice(sep + 1);
          const entityIds = [...new Set(groupedKeys.map(k => k.entityId))];
          if (entityIds.length === 0) continue;

          // type_id + entity ids are parameterized via inList (the proven
          // pattern — passing a JS array to `= ANY($n)` is serialized as a
          // comma-string by the Bun SQL driver and fails). foreignKeyField
          // comes from trusted relation decorator metadata.
          const entityList = inList(entityIds, 2);
          const rows = await timedUnsafe<any[]>(db, `
            SELECT c.entity_id, c.data->>'${foreignKeyField}' AS fk_value
            FROM components c
            INNER JOIN entities e ON c.entity_id = e.id
            WHERE c.type_id = $1
              AND c.deleted_at IS NULL
              AND e.deleted_at IS NULL
              AND c.data->>'${foreignKeyField}' IN ${entityList.sql}
          `, [componentTypeId, ...entityList.params], signal, perRequest);

          for (const key of groupedKeys) {
            const relatedIds = [...new Set(
              rows.filter((r: any) => r.fk_value === key.entityId).map((r: any) => r.entity_id)
            )];
            const entities = relatedIds.map(id => {
              const e = new Entity(id as string);
              e.setPersisted(true);
              return e;
            });
            resultMap.set(`${key.entityId}\x00${componentTypeId}\x00${foreignKeyField}`, entities);
          }
        }

        const duration = Date.now() - startTime;
        if (duration > 1000) {
          logger.warn(`Slow relationsByComponentFk query: ${duration}ms for ${keys.length} keys`);
        }

        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') return [];
          return resultMap.get(`${k.entityId}\x00${k.componentTypeId}\x00${k.foreignKeyField}`) || [];
        });
      } catch (error) {
        logger.error(`Error in relationsByComponentFk DataLoader:`);
        logger.error(error);
        return keys.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cacheKeyFn: (k: { entityId: string; componentTypeId: string; foreignKeyField: string }) =>
        `${k.entityId}\x00${k.componentTypeId}\x00${k.foreignKeyField}`,
    }
  );

  return { entityById, componentsByEntityType, relationsByEntityField, relationsByComponentFk };
}