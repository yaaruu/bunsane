import { Entity } from "./Entity";
import { BaseComponent } from "./components";
import { timed } from "./Decorators";
import db from "../database";
import { sql } from "bun";

interface CachedRelation {
    ids: string[];
    expiresAt: number;
    lastAccessed: number;
}

interface BatchLoaderOptions {
    fieldName?: string;
    batchSize?: number;
    maxConcurrency?: number;
    cacheTTL?: number;
}

interface BatchLoaderConfig {
    maxCacheEntries: number;
    maxCacheTypes: number;
    evictionBatchSize: number;
}

/**
 * LRU-bounded cache for relation lookups.
 * Prevents unbounded memory growth under high cardinality.
 */
class BoundedRelationCache {
    private cache = new Map<string, Map<string, CachedRelation>>();
    private accessOrder: string[] = []; // Tracks global access order for LRU eviction
    private totalEntries = 0;
    private config: BatchLoaderConfig;

    constructor(config: BatchLoaderConfig) {
        this.config = config;
    }

    getTypeCache(cacheKey: string): Map<string, CachedRelation> {
        let typeCache = this.cache.get(cacheKey);
        if (!typeCache) {
            // Evict oldest type caches if at limit
            if (this.cache.size >= this.config.maxCacheTypes) {
                this.evictOldestType();
            }
            typeCache = new Map();
            this.cache.set(cacheKey, typeCache);
        }
        return typeCache;
    }

    get(cacheKey: string, parentId: string): CachedRelation | undefined {
        const typeCache = this.cache.get(cacheKey);
        if (!typeCache) return undefined;

        const entry = typeCache.get(parentId);
        if (entry) {
            // Update access time for LRU
            entry.lastAccessed = Date.now();
        }
        return entry;
    }

    set(cacheKey: string, parentId: string, entry: CachedRelation): void {
        const typeCache = this.getTypeCache(cacheKey);

        // Evict if at capacity before adding new entries
        if (this.totalEntries >= this.config.maxCacheEntries && !typeCache.has(parentId)) {
            this.evictLRUEntries(this.config.evictionBatchSize);
        }

        if (!typeCache.has(parentId)) {
            this.totalEntries++;
        }
        typeCache.set(parentId, entry);
    }

    delete(cacheKey: string, parentId: string): boolean {
        const typeCache = this.cache.get(cacheKey);
        if (!typeCache) return false;

        const existed = typeCache.delete(parentId);
        if (existed) {
            this.totalEntries--;
        }
        return existed;
    }

    clear(): void {
        this.cache.clear();
        this.accessOrder = [];
        this.totalEntries = 0;
    }

    getStats(): { types: number; entries: number; expired: number; memoryEstimate: string } {
        let expiredEntries = 0;
        const now = Date.now();

        for (const [, typeCache] of this.cache) {
            for (const [, entry] of typeCache) {
                if (now > entry.expiresAt) {
                    expiredEntries++;
                }
            }
        }

        // Rough memory estimate: ~100 bytes per entry (UUID strings + overhead)
        const memoryBytes = this.totalEntries * 100;
        const memoryEstimate = memoryBytes > 1024 * 1024
            ? `${(memoryBytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(memoryBytes / 1024).toFixed(2)} KB`;

        return {
            types: this.cache.size,
            entries: this.totalEntries,
            expired: expiredEntries,
            memoryEstimate
        };
    }

    private evictOldestType(): void {
        // Find the type cache with oldest average access time
        let oldestKey: string | null = null;
        let oldestAvgAccess = Infinity;

        for (const [key, typeCache] of this.cache) {
            let totalAccess = 0;
            let count = 0;
            for (const [, entry] of typeCache) {
                totalAccess += entry.lastAccessed;
                count++;
            }
            const avgAccess = count > 0 ? totalAccess / count : 0;
            if (avgAccess < oldestAvgAccess) {
                oldestAvgAccess = avgAccess;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            const evictedCache = this.cache.get(oldestKey);
            if (evictedCache) {
                this.totalEntries -= evictedCache.size;
            }
            this.cache.delete(oldestKey);
        }
    }

    private evictLRUEntries(count: number): void {
        // Collect all entries with their access times
        const entries: Array<{ cacheKey: string; parentId: string; lastAccessed: number }> = [];

        for (const [cacheKey, typeCache] of this.cache) {
            for (const [parentId, entry] of typeCache) {
                entries.push({ cacheKey, parentId, lastAccessed: entry.lastAccessed });
            }
        }

        // Sort by lastAccessed ascending (oldest first)
        entries.sort((a, b) => a.lastAccessed - b.lastAccessed);

        // Evict the oldest entries
        const toEvict = entries.slice(0, count);
        for (const { cacheKey, parentId } of toEvict) {
            this.delete(cacheKey, parentId);
        }
    }

    /**
     * Prune expired entries. Call periodically to reclaim memory.
     */
    pruneExpired(): number {
        const now = Date.now();
        let prunedCount = 0;

        for (const [cacheKey, typeCache] of this.cache) {
            for (const [parentId, entry] of typeCache) {
                if (now > entry.expiresAt) {
                    typeCache.delete(parentId);
                    this.totalEntries--;
                    prunedCount++;
                }
            }
            // Remove empty type caches
            if (typeCache.size === 0) {
                this.cache.delete(cacheKey);
            }
        }

        return prunedCount;
    }
}

export class BatchLoader {
    private static cache = new BoundedRelationCache({
        maxCacheEntries: 100_000, // Max 100k relation entries (~10MB)
        maxCacheTypes: 500,       // Max 500 different component types
        evictionBatchSize: 1000   // Evict 1000 entries at a time
    });
    private static readonly DEFAULT_BATCH_SIZE = 1000;
    private static readonly DEFAULT_MAX_CONCURRENCY = 5;
    private static readonly DEFAULT_CACHE_TTL = 300_000; // 5 minutes
    private static lastPruneTime = 0;
    private static readonly PRUNE_INTERVAL = 60_000; // Prune every minute

    /**
     * Load related entities efficiently with caching and batching
     */
    @timed("BatchLoader.loadRelatedEntitiesBatched")
    static async loadRelatedEntitiesBatched<C extends BaseComponent>(
        entities: Entity[],
        component: new () => C,
        loader: (ids: string[]) => Promise<Entity[]>,
        options: BatchLoaderOptions = {}
    ): Promise<Map<string, Entity>> {
        if (entities.length === 0) return new Map();

        // Periodic pruning of expired entries
        const now = Date.now();
        if (now - this.lastPruneTime > this.PRUNE_INTERVAL) {
            this.cache.pruneExpired();
            this.lastPruneTime = now;
        }

        const {
            fieldName = 'value',
            batchSize = this.DEFAULT_BATCH_SIZE,
            maxConcurrency = this.DEFAULT_MAX_CONCURRENCY,
            cacheTTL = this.DEFAULT_CACHE_TTL
        } = options;

        const comp = new component();
        const typeId = comp.getTypeID();
        const parentIds = entities.map(e => e.id);

        // Cache key uses null byte separator to prevent collision
        const cacheKey = `${typeId}\x00${fieldName}`;

        // Get uncached or expired parent IDs
        const uncachedParentIds = parentIds.filter(id => {
            const entry = this.cache.get(cacheKey, id);
            if (!entry) return true;
            if (now > entry.expiresAt) {
                this.cache.delete(cacheKey, id);
                return true;
            }
            return false;
        });

        if (uncachedParentIds.length > 0) {
            // Batch the parent IDs to avoid huge IN clauses
            const batches = this.chunkArray(uncachedParentIds, batchSize);

            for (const batch of batches) {
                const rows = await db`
                    SELECT c.entity_id, (c.data->>${sql(fieldName)}) AS related_id
                    FROM components c
                    WHERE c.entity_id IN ${sql(batch)}
                      AND c.type_id = ${typeId}
                      AND c.deleted_at IS NULL
                      AND c.data->>${sql(fieldName)} IS NOT NULL
                `;

                // Group by parent entity for caching
                const parentGroups = new Map<string, string[]>();
                for (const row of rows) {
                    const parentId = row.entity_id;
                    const relatedId = row.related_id;
                    if (!parentGroups.has(parentId)) {
                        parentGroups.set(parentId, []);
                    }
                    parentGroups.get(parentId)!.push(relatedId);
                }

                const expiresAt = Date.now() + cacheTTL;
                const lastAccessed = Date.now();

                // Cache the related IDs for each parent
                for (const [parentId, relatedIds] of parentGroups) {
                    this.cache.set(cacheKey, parentId, { ids: relatedIds, expiresAt, lastAccessed });
                }

                // Cache empty arrays for parents with no relations
                for (const parentId of batch) {
                    if (!parentGroups.has(parentId)) {
                        this.cache.set(cacheKey, parentId, { ids: [], expiresAt, lastAccessed });
                    }
                }
            }
        }

        // Collect all unique related IDs from cache
        const allRelatedIds = new Set<string>();
        for (const parentId of parentIds) {
            const entry = this.cache.get(cacheKey, parentId);
            const relatedIds = entry?.ids || [];
            relatedIds.forEach((id: string) => allRelatedIds.add(id));
        }

        if (allRelatedIds.size === 0) return new Map();

        // Load related entities with concurrency control
        const relatedIdArray = Array.from(allRelatedIds);
        const entityBatches = this.chunkArray(relatedIdArray, batchSize);

        const relatedEntities: Entity[] = [];
        const semaphore = new Semaphore(maxConcurrency);

        await Promise.all(
            entityBatches.map(async (batch) => {
                await semaphore.acquire();
                try {
                    const entities = await loader(batch);
                    relatedEntities.push(...entities);
                } finally {
                    semaphore.release();
                }
            })
        );

        const map = new Map<string, Entity>();
        for (const related of relatedEntities) {
            map.set(related.id, related);
        }
        return map;
    }

    /**
     * Clear the cache (useful for testing or memory management)
     */
    static clearCache(): void {
        this.cache.clear();
    }

    /**
     * Get cache statistics including memory estimate
     */
    static getCacheStats(): { size: number; entries: number; expired: number; memoryEstimate?: string } {
        const stats = this.cache.getStats();
        return {
            size: stats.types,
            entries: stats.entries,
            expired: stats.expired,
            memoryEstimate: stats.memoryEstimate
        };
    }

    /**
     * Manually prune expired entries. Returns count of pruned entries.
     */
    static pruneExpiredEntries(): number {
        return this.cache.pruneExpired();
    }

    private static chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
    private permits: number;
    private waitQueue: (() => void)[] = [];

    constructor(permits: number) {
        this.permits = permits;
    }

    async acquire(): Promise<void> {
        if (this.permits > 0) {
            this.permits--;
            return;
        }

        return new Promise((resolve) => {
            this.waitQueue.push(resolve);
        });
    }

    release(): void {
        this.permits++;
        if (this.waitQueue.length > 0) {
            const resolve = this.waitQueue.shift()!;
            this.permits--;
            resolve();
        }
    }
}
