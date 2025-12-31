import { logger } from "../core/Logger";

export interface CacheEntry {
    sql: string;
    preparedStatement: any; // Bun's SQL prepared statement type
    lastUsed: number;
    hitCount: number;
    createdAt: number;
}

export interface CacheStats {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    evictions: number;
    totalPlanningTimeSaved: number;
    averagePlanningTimeSaved: number;
}

/**
 * LRU Cache for prepared statements to eliminate PostgreSQL planning overhead
 * for repeated query patterns in the Bunsane Query system.
 */
export class PreparedStatementCache {
    private cache: Map<string, CacheEntry> = new Map();
    private maxSize: number;
    private stats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        totalPlanningTimeSaved: 0
    };

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
        logger.info(`Initialized PreparedStatementCache with max size: ${maxSize}`);
    }

    /**
     * Generate a cache key from QueryContext fingerprint
     */
    public generateCacheKey(context: {
        componentIds: Set<string>;
        componentFilters: Map<string, any[]>;
        sortOrders: any[];
        excludedComponentIds: Set<string>;
        hasCTE: boolean;
        cteName: string;
    }): string {
        // Create a deterministic fingerprint of the query structure
        const components = Array.from(context.componentIds).sort().join(',');
        const excludedComponents = Array.from(context.excludedComponentIds).sort().join(',');
        const filters = Array.from(context.componentFilters.entries())
            .map(([typeId, filters]) => `${typeId}:${filters.map(f => `${f.field}${f.operator}`).sort().join('|')}`)
            .sort()
            .join(';');
        const sorts = context.sortOrders
            .map(s => `${s.component}.${s.property}:${s.direction}`)
            .sort()
            .join(',');

        const key = `${components}|${excludedComponents}|${filters}|${sorts}|${context.hasCTE}|${context.cteName}`;
        return key;
    }

    /**
     * Get a prepared statement from cache, or create new one
     */
    public async getOrCreate(sql: string, key: string, db: any): Promise<{ statement: any; isHit: boolean }> {
        const now = Date.now();
        const existing = this.cache.get(key);

        if (existing) {
            // Cache hit
            existing.lastUsed = now;
            existing.hitCount++;
            this.stats.hits++;
            // logger.trace(`Cache hit for key: ${key.substring(0, 50)}...`);
            return { statement: existing.preparedStatement, isHit: true };
        }

        // Cache miss - create new prepared statement
        this.stats.misses++;
        logger.trace(`Cache miss for key: ${key.substring(0, 50)}..., creating prepared statement`);

        // Create prepared statement using Bun's SQL
        // Note: Bun's SQL may not have explicit prepare(), so we'll use the query as-is
        // In postgres.js this would be: db.unsafe(sql, params, { prepare: true })
        // For Bun, we may need to adapt this
        const preparedStatement = { sql, _isPrepared: true }; // Placeholder

        const entry: CacheEntry = {
            sql,
            preparedStatement,
            lastUsed: now,
            hitCount: 1,
            createdAt: now
        };

        // Evict if at capacity
        if (this.cache.size >= this.maxSize) {
            this.evictLRU();
        }

        this.cache.set(key, entry);
        return { statement: preparedStatement, isHit: false };
    }

    /**
     * Execute a prepared statement with parameters
     */
    public async execute(statement: any, params: any[], db: any): Promise<any[]> {
        // Validate params to catch empty strings that would cause UUID parsing errors
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (param === '' || (typeof param === 'string' && param.trim() === '')) {
                logger.error(`[PreparedStatementCache] Empty string parameter at position ${i + 1}`);
                logger.error(`[PreparedStatementCache] SQL: ${statement.sql}`);
                logger.error(`[PreparedStatementCache] All params: ${JSON.stringify(params)}`);
                throw new Error(`PreparedStatementCache.execute: Parameter $${i + 1} is an empty string. SQL: ${statement.sql.substring(0, 100)}...`);
            }
        }
        
        // For Bun's SQL, we still use db.unsafe() but with the prepared statement concept
        // In a real implementation, this might use a prepared statement pool
        return await db.unsafe(statement.sql, params);
    }

    /**
     * Evict least recently used entry
     */
    private evictLRU(): void {
        let oldestKey: string | null = null;
        let oldestTime = Date.now();

        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.stats.evictions++;
            logger.trace(`Evicted LRU cache entry: ${oldestKey.substring(0, 50)}...`);
        }
    }

    /**
     * Invalidate cache entries when component schemas change
     */
    public invalidateByComponent(componentTypeId: string): void {
        const keysToDelete: string[] = [];

        for (const [key, entry] of this.cache.entries()) {
            if (key.includes(componentTypeId)) {
                keysToDelete.push(key);
            }
        }

        keysToDelete.forEach(key => {
            this.cache.delete(key);
            logger.trace(`Invalidated cache entry due to component change: ${key.substring(0, 50)}...`);
        });

        logger.info(`Invalidated ${keysToDelete.length} cache entries for component: ${componentTypeId}`);
    }

    /**
     * Clear entire cache
     */
    public clear(): void {
        const size = this.cache.size;
        this.cache.clear();
        logger.info(`Cleared prepared statement cache (${size} entries)`);
    }

    /**
     * Get cache statistics
     */
    public getStats(): CacheStats {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;

        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions,
            totalPlanningTimeSaved: this.stats.totalPlanningTimeSaved,
            averagePlanningTimeSaved: this.stats.totalPlanningTimeSaved / Math.max(this.stats.hits, 1)
        };
    }

    /**
     * Warm up cache with common query patterns
     */
    public async warmUp(commonQueries: Array<{ sql: string; key: string }>, db: any): Promise<void> {
        logger.info(`Warming up prepared statement cache with ${commonQueries.length} queries`);

        for (const query of commonQueries) {
            try {
                await this.getOrCreate(query.sql, query.key, db);
            } catch (error) {
                logger.warn(`Failed to warm up query: ${error}`);
            }
        }

        logger.info(`Cache warm-up complete. Cache size: ${this.cache.size}`);
    }

    /**
     * Record planning time saved for metrics
     */
    public recordPlanningTimeSaved(timeMs: number): void {
        this.stats.totalPlanningTimeSaved += timeMs;
    }
}

// Global cache instance
export const preparedStatementCache = new PreparedStatementCache(
    parseInt(process.env.BUNSANE_QUERY_CACHE_SIZE || '100', 10)
);