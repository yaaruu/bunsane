import DataLoader from 'dataloader';
import { Entity } from './Entity';
import { inList } from '../database/sqlHelpers';
import { incrementDataLoaderCall, type PerRequestCounters } from '../database/instrumentedDb';
import { dbExec } from '../database/gateway';
import { logger as MainLogger } from './Logger';
const logger = MainLogger.child({ module: 'RequestLoaders' });
import type { CacheManager } from './cache/CacheManager';
import { COMPONENT_TOMBSTONE } from './cache/CacheManager';
import { trackCacheOp } from './entity/pendingOps';
import { bumpAllComponentReadFlights, bumpComponentReadFlight, componentReadEpoch } from './cache/componentReadFlight';

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

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function componentFlightKey(entityId: string, typeId: string): string {
  return `${entityId}\0${typeId}`;
}

/**
 * Cross-request singleflight for component cache misses. The flight records
 * the epoch at start. A joiner whose signal is still live does not inherit
 * the leader's abort — that flight resolves to a sentinel and the joiner
 * re-queries. A key written or cleared after the flight started is not joinable.
 */
const FLIGHT_ABORTED = Symbol('component-flight-aborted');
type FlightValue = ComponentData | null | typeof FLIGHT_ABORTED;
const componentMissFlights = new Map<string, { promise: Promise<FlightValue>; epoch: number }>();

type Pair = { entityId: string; typeId: string };

function pairValues(pairs: readonly Pair[], paramIndex: number): { sql: string; params: string[]; newParamIndex: number } {
  const params: string[] = [];
  const tuples: string[] = [];
  let i = paramIndex;
  for (const pair of pairs) {
    tuples.push(`($${i}::uuid, $${i + 1}::varchar)`);
    params.push(pair.entityId, pair.typeId);
    i += 2;
  }
  return { sql: tuples.join(', '), params, newParamIndex: i };
}

function rowToComponent(row: {
  id: string;
  entity_id: string;
  type_id: string;
  data: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}): ComponentData {
  return {
    id: row.id,
    entityId: row.entity_id,
    typeId: row.type_id,
    data: row.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

async function queryComponentPairs(
  keys: readonly Pair[],
  signal: AbortSignal | undefined,
  perRequest: PerRequestCounters | undefined,
): Promise<Map<string, ComponentData | null>> {
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const key of keys) {
    const flightKey = componentFlightKey(key.entityId, key.typeId);
    if (seen.has(flightKey)) continue;
    seen.add(flightKey);
    pairs.push(key);
  }

  const result = new Map<string, ComponentData | null>();
  for (const pair of pairs) result.set(componentFlightKey(pair.entityId, pair.typeId), null);
  if (pairs.length === 0) return result;

  // type_id IN keeps LIST partition pruning. The VALUES predicate drops the
  // cartesian product of entity_id IN (...) AND type_id IN (...).
  const typeIds = [...new Set(pairs.map(pair => pair.typeId))];
  const typeIdList = inList(typeIds, 1);
  const pairList = pairValues(pairs, typeIdList.newParamIndex);
  const rows = await dbExec<Array<{
    id: string;
    entity_id: string;
    type_id: string;
    data: unknown;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
  }>>(`
    SELECT id, entity_id, type_id, data, created_at, updated_at, deleted_at
    FROM components
    WHERE deleted_at IS NULL
      AND type_id IN ${typeIdList.sql}
      AND (entity_id, type_id) IN (VALUES ${pairList.sql})
  `, [...typeIdList.params, ...pairList.params], {
    lane: 'request',
    label: 'loader.component.byEntityTypes',
    signal,
    perRequest,
  });

  for (const row of rows) {
    const comp = rowToComponent(row);
    result.set(componentFlightKey(comp.entityId, comp.typeId), comp);
  }
  return result;
}

function isLeaderCancellation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Join in-flight misses or become the leader for keys nobody else owns.
 * Registration is synchronous so a concurrent batch cannot start a second query
 * for the same epoch. A flight started before a write (lower epoch) is skipped.
 */
async function singleflightComponentMisses(
  keys: readonly Pair[],
  signal: AbortSignal | undefined,
  leader: (owned: Pair[]) => Promise<Map<string, ComponentData | null>>,
): Promise<Map<string, ComponentData | null>> {
  const out = new Map<string, ComponentData | null>();
  const waiting: Promise<void>[] = [];
  const retries: Pair[] = [];
  const owned: Pair[] = [];
  const resolveOwned = new Map<string, (value: FlightValue) => void>();
  const rejectOwned = new Map<string, (error: unknown) => void>();
  const registered = new Map<string, Promise<FlightValue>>();

  for (const key of keys) {
    const flightKey = componentFlightKey(key.entityId, key.typeId);
    const existing = componentMissFlights.get(flightKey);
    if (existing && existing.epoch === componentReadEpoch(key.entityId, key.typeId)) {
      waiting.push(existing.promise.then((value) => {
        if (value === FLIGHT_ABORTED) retries.push(key);
        else out.set(flightKey, value);
      }));
      continue;
    }
    owned.push(key);
    const epoch = componentReadEpoch(key.entityId, key.typeId);
    const { promise, resolve, reject } = Promise.withResolvers<FlightValue>();
    promise.catch(() => {});
    resolveOwned.set(flightKey, resolve);
    rejectOwned.set(flightKey, reject);
    registered.set(flightKey, promise);
    componentMissFlights.set(flightKey, { promise, epoch });
  }

  let leaderError: unknown;
  if (owned.length > 0) {
    try {
      const fetched = await leader(owned);
      for (const key of owned) {
        const flightKey = componentFlightKey(key.entityId, key.typeId);
        const value = fetched.get(flightKey) ?? null;
        out.set(flightKey, value);
        resolveOwned.get(flightKey)!(value);
      }
    } catch (error) {
      leaderError = error;
      const cancelled = isLeaderCancellation(signal);
      for (const key of owned) {
        const flightKey = componentFlightKey(key.entityId, key.typeId);
        if (cancelled) resolveOwned.get(flightKey)!(FLIGHT_ABORTED);
        else rejectOwned.get(flightKey)!(error);
      }
    } finally {
      for (const key of owned) {
        const flightKey = componentFlightKey(key.entityId, key.typeId);
        if (componentMissFlights.get(flightKey)?.promise === registered.get(flightKey)) {
          componentMissFlights.delete(flightKey);
        }
      }
    }
  }

  if (waiting.length > 0) {
    try {
      await Promise.all(waiting);
    } catch (error) {
      if (!leaderError) leaderError = error;
    }
  }

  if (retries.length > 0) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Query aborted');
    }
    const again = await singleflightComponentMisses(retries, signal, leader);
    for (const [key, value] of again) out.set(key, value);
  }

  if (leaderError && owned.length > 0) throw leaderError;
  return out;
}

function cacheEnabled(cacheManager: CacheManager | undefined, kind: 'entity' | 'component'): boolean {
  if (!cacheManager) return false;
  const config = cacheManager.getConfig();
  if (!config.enabled) return false;
  return kind === 'entity' ? !!config.entity?.enabled : !!config.component?.enabled;
}

export function createRequestLoaders(
  _db: unknown,
  cacheManager?: CacheManager,
  signal?: AbortSignal,
  perRequest?: PerRequestCounters,
): RequestLoaders {
  const entityById = new DataLoader<string, Entity | null>(async (ids: readonly string[]) => {
    incrementDataLoaderCall('entity', perRequest);
    const startTime = Date.now();
    try {
      const validIds = ids.filter(id => id && typeof id === 'string' && id.trim() !== '');
      if (validIds.length === 0) {
        return ids.map(() => null);
      }

      const uniqueIds = [...new Set(validIds)];
      const results = new Map<string, Entity | null>();

      // Entity cache stores only the id and nothing on the read path consults
      // it (full entities are always loaded from the database). Do not
      // write-through those ids — it added a Redis round trip for no hit.

      const idList = inList(uniqueIds, 1);
      const rows = await dbExec<Array<{ id: string }>>(`
        SELECT id
        FROM entities
        WHERE id IN ${idList.sql}
          AND deleted_at IS NULL
      `, idList.params, { lane: 'request', label: 'loader.entity.byIds', signal, perRequest });

      for (const row of rows) {
        const entity = new Entity(row.id);
        entity.setPersisted(true);
        results.set(entity.id, entity);
      }

      const duration = Date.now() - startTime;
      if (duration > 1000) {
        logger.warn(`Slow entityById query: ${duration}ms for ${ids.length} entities`);
      }

      return ids.map(id => {
        if (!id || typeof id !== 'string' || id.trim() === '') return null;
        return results.get(id) ?? null;
      });
    } catch (error) {
      logger.error({ error }, 'Error in entityById DataLoader');
      throw error;
    }
  }, {
    maxBatchSize: 100
  });

  const componentsByEntityType = new DataLoader<{ entityId: string; typeId: string }, ComponentData | null, string>(
    async (keys: readonly { entityId: string; typeId: string }[]) => {
      incrementDataLoaderCall('component', perRequest);
      const startTime = Date.now();
      try {
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => null);
        }

        const results = new Map<string, ComponentData | null>();
        const componentCacheOn = cacheEnabled(cacheManager, 'component');

        let cacheHits = 0;
        let cacheMisses = 0;
        if (componentCacheOn) {
          try {
            const cachedComponents = await cacheManager!.getComponents(validKeys);
            cachedComponents.forEach((value, index) => {
              const key = componentFlightKey(validKeys[index]!.entityId, validKeys[index]!.typeId);
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
          } catch (error) {
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

        const missingKeys = validKeys.filter(k => !results.has(componentFlightKey(k.entityId, k.typeId)));
        if (missingKeys.length > 0) {
          const fetched = await singleflightComponentMisses(missingKeys, signal, async (owned) => {
            const map = await queryComponentPairs(owned, signal, perRequest);
            if (componentCacheOn) {
              const components: ComponentData[] = [];
              for (const value of map.values()) {
                if (value) components.push(value);
              }
              trackCacheOp(
                cacheManager!.setComponentsWriteThrough(
                  components,
                  owned,
                  cacheManager!.getConfig().component!.ttl,
                ).catch((error) => {
                  logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache write failed for components', error });
                })
              );
            }
            return map;
          });
          for (const [key, value] of fetched) results.set(key, value);
        }

        const duration = Date.now() - startTime;
        if (duration > 1000) {
          logger.warn(`Slow componentsByEntityType query: ${duration}ms for ${keys.length} keys`);
        }

        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') return null;
          return results.get(componentFlightKey(k.entityId, k.typeId)) ?? null;
        });
      } catch (error) {
        logger.error({ error }, 'Error in componentsByEntityType DataLoader');
        throw error;
      }
    },
    {
      maxBatchSize: 100,
      cacheKeyFn: (k: { entityId: string; typeId: string }) => `${k.entityId}\x00${k.typeId}`,
    }
  );

  const clearKey = componentsByEntityType.clear.bind(componentsByEntityType);
  componentsByEntityType.clear = (key) => {
    bumpComponentReadFlight(key.entityId, key.typeId);
    return clearKey(key);
  };
  const clearAllKeys = componentsByEntityType.clearAll.bind(componentsByEntityType);
  componentsByEntityType.clearAll = () => {
    bumpAllComponentReadFlights();
    return clearAllKeys();
  };

  const relationsByEntityField = new DataLoader<{ entityId: string; relationField: string; relatedType: string; foreignKey?: string }, Entity[], string>(
    async (keys: readonly { entityId: string; relationField: string; relatedType: string; foreignKey?: string }[]) => {
      incrementDataLoaderCall('relation', perRequest);
      const startTime = Date.now();
      try {
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) {
          return keys.map(() => []);
        }

        const resultMap = new Map<string, Entity[]>();

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
                resultMap.set(`${k.entityId}\x00${k.relationField}\x00${k.relatedType}`, []);
              } else {
                remaining.push(k);
              }
            });
            keysToQuery = remaining;
          } catch (error) {
            logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache read failed for relation tombstones', error });
          }
        }

        const keysByForeignKey = new Map<string, typeof keysToQuery>();
        for (const key of keysToQuery) {
          const fk = key.foreignKey || 'default';
          const group = keysByForeignKey.get(fk);
          if (group) group.push(key);
          else keysByForeignKey.set(fk, [key]);
        }

        for (const [foreignKey, groupedKeys] of keysByForeignKey) {
          const entityIds = [...new Set(groupedKeys.map(k => k.entityId))];
          let foreignKeyField: string;
          let whereClause: string;

          if (foreignKey !== 'default') {
            foreignKeyField = assertSqlIdentifier(foreignKey, 'relation foreign key');
            whereClause = `c.data->>'${foreignKeyField}' = ANY($1)`;
          } else {
            foreignKeyField = 'user_id';
            whereClause = `(c.data->>'user_id' = ANY($1) OR c.data->>'parent_id' = ANY($1))`;
          }

          logger.trace(`[RelationLoader] Batched query for ${groupedKeys.length} keys with foreign key ${foreignKey}`);

          const rows = await dbExec<Array<{ entity_id: string; fk_value: string | null; fallback_fk_value: string | null }>>(`
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
          `, [entityIds], { lane: 'request', label: 'loader.relation.distinct', signal, perRequest });

          logger.trace(`[RelationLoader] Found ${rows.length} total components for ${entityIds.length} entities`);

          for (const key of groupedKeys) {
            const relatedEntityIds = rows
              .filter(row => {
                const fkValue = foreignKey !== 'default' ? row.fk_value : row.fallback_fk_value;
                return fkValue === key.entityId;
              })
              .map(row => row.entity_id);

            const entities = [...new Set(relatedEntityIds)].map(id => {
              const entity = new Entity(id);
              entity.setPersisted(true);
              return entity;
            });

            resultMap.set(`${key.entityId}\x00${key.relationField}\x00${key.relatedType}`, entities);
            logger.trace(`[RelationLoader] Mapped ${entities.length} entities for ${key.relationField} on ${key.entityId}`);
          }
        }

        if (relCacheEnabled && keysToQuery.length > 0) {
          const emptyKeys = keysToQuery.filter(k => {
            const mapped = resultMap.get(`${k.entityId}\x00${k.relationField}\x00${k.relatedType}`);
            return !mapped || mapped.length === 0;
          });
          if (emptyKeys.length > 0) {
            trackCacheOp(
              cacheManager!.setRelationsEmpty(emptyKeys).catch((error) => {
                logger.warn({ scope: 'cache', component: 'RequestLoaders', msg: 'Cache write failed for relation tombstones', error });
              })
            );
          }
        }

        const duration = Date.now() - startTime;
        if (duration > 1000) {
          logger.warn(`Slow relationsByEntityField query: ${duration}ms for ${keys.length} keys`);
        } else {
          logger.trace(`[RelationLoader] Batched query completed in ${duration}ms for ${keys.length} keys`);
        }

        return keys.map(k => {
          if (!k.entityId || typeof k.entityId !== 'string' || k.entityId.trim() === '') return [];
          return resultMap.get(`${k.entityId}\x00${k.relationField}\x00${k.relatedType}`) ?? [];
        });
      } catch (error) {
        logger.error({ error }, 'Error in relationsByEntityField DataLoader');
        throw error;
      }
    },
    {
      maxBatchSize: 50,
      cacheKeyFn: (k: { entityId: string; relationField: string; relatedType: string; foreignKey?: string }) =>
        `${k.entityId}\x00${k.relationField}\x00${k.relatedType}\x00${k.foreignKey ?? ''}`,
    }
  );

  const relationsByComponentFk = new DataLoader<{ entityId: string; componentTypeId: string; foreignKeyField: string }, Entity[], string>(
    async (keys: readonly { entityId: string; componentTypeId: string; foreignKeyField: string }[]) => {
      incrementDataLoaderCall('relation', perRequest);
      const startTime = Date.now();
      try {
        const validKeys = keys.filter(k => k.entityId && typeof k.entityId === 'string' && k.entityId.trim() !== '');
        if (validKeys.length === 0) return keys.map(() => []);

        const resultMap = new Map<string, Entity[]>();
        const groups = new Map<string, typeof validKeys>();
        for (const key of validKeys) {
          const gk = `${key.componentTypeId}\x00${key.foreignKeyField}`;
          const group = groups.get(gk);
          if (group) group.push(key);
          else groups.set(gk, [key]);
        }

        for (const [gk, groupedKeys] of groups) {
          const sep = gk.indexOf('\x00');
          const componentTypeId = gk.slice(0, sep);
          const foreignKeyField = assertSqlIdentifier(gk.slice(sep + 1), 'relation foreign key');
          const entityIds = [...new Set(groupedKeys.map(k => k.entityId))];
          if (entityIds.length === 0) continue;

          const entityList = inList(entityIds, 2);
          const rows = await dbExec<Array<{ entity_id: string; fk_value: string | null }>>(`
            SELECT c.entity_id, c.data->>'${foreignKeyField}' AS fk_value
            FROM components c
            INNER JOIN entities e ON c.entity_id = e.id
            WHERE c.type_id = $1
              AND c.deleted_at IS NULL
              AND e.deleted_at IS NULL
              AND c.data->>'${foreignKeyField}' IN ${entityList.sql}
          `, [componentTypeId, ...entityList.params], { lane: 'request', label: 'loader.relation.fk', signal, perRequest });

          for (const key of groupedKeys) {
            const relatedIds = [...new Set(
              rows.filter(row => row.fk_value === key.entityId).map(row => row.entity_id)
            )];
            const entities = relatedIds.map(id => {
              const entity = new Entity(id);
              entity.setPersisted(true);
              return entity;
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
          return resultMap.get(`${k.entityId}\x00${k.componentTypeId}\x00${k.foreignKeyField}`) ?? [];
        });
      } catch (error) {
        logger.error({ error }, 'Error in relationsByComponentFk DataLoader');
        throw error;
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
