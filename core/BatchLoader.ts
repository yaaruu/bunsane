import { Entity } from "./Entity";
import { BaseComponent } from "./components";
import { timed } from "./Decorators";
import db from "../database";
import { sql } from "bun";

interface CachedRelation {
    ids: string[];
    expiresAt: number;
}

interface BatchLoaderOptions {
    fieldName?: string;
    batchSize?: number;
    maxConcurrency?: number;
    cacheTTL?: number;
}

export class BatchLoader {
    private static cache = new Map<string, Map<string, CachedRelation>>();
    private static readonly DEFAULT_BATCH_SIZE = 1000;
    private static readonly DEFAULT_MAX_CONCURRENCY = 5;
    private static readonly DEFAULT_CACHE_TTL = 300_000; // 5 minutes

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

        const {
            fieldName = 'value',
            batchSize = this.DEFAULT_BATCH_SIZE,
            maxConcurrency = this.DEFAULT_MAX_CONCURRENCY,
            cacheTTL = this.DEFAULT_CACHE_TTL
        } = options;

        const comp = new component();
        const typeId = comp.getTypeID();
        const parentIds = entities.map(e => e.id);

        // Check cache first
        const cacheKey = `${typeId}:${fieldName}`;
        let cachedResults = this.cache.get(cacheKey);
        if (!cachedResults) {
            cachedResults = new Map();
            this.cache.set(cacheKey, cachedResults);
        }

        const now = Date.now();

        // Get uncached or expired parent IDs
        const uncachedParentIds = parentIds.filter(id => {
            const entry = cachedResults.get(id);
            if (!entry) return true;
            if (now > entry.expiresAt) {
                cachedResults.delete(id);
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

                // Cache the related IDs for each parent
                for (const [parentId, relatedIds] of parentGroups) {
                    cachedResults.set(parentId, { ids: relatedIds, expiresAt });
                }

                // Cache empty arrays for parents with no relations
                for (const parentId of batch) {
                    if (!parentGroups.has(parentId)) {
                        cachedResults.set(parentId, { ids: [], expiresAt });
                    }
                }
            }
        }

        // Collect all unique related IDs from cache
        const allRelatedIds = new Set<string>();
        for (const parentId of parentIds) {
            const entry = cachedResults.get(parentId);
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
     * Get cache statistics including expired entry count
     */
    static getCacheStats(): { size: number; entries: number; expired: number } {
        let totalEntries = 0;
        let expiredEntries = 0;
        const now = Date.now();
        for (const [, parentMap] of this.cache) {
            for (const [, entry] of parentMap) {
                totalEntries++;
                if (now > entry.expiresAt) {
                    expiredEntries++;
                }
            }
        }
        return { size: this.cache.size, entries: totalEntries, expired: expiredEntries };
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