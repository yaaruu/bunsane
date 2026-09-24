import { type CacheProvider, type CacheStats } from './CacheProvider';
import { logger } from '../Logger';
import { cacheInvalidateMax, CacheInvalidateCapExceededError, matchGlob } from './invalidateBounds';

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(2)} ${units[i]}`;
}

interface CacheEntry<T> {
    value: T;
    expiresAt?: number;
    accessCount: number;
    size: number; // Estimated bytes (key + value + metadata), cached for O(1) memory accounting
}

export interface MemoryCacheConfig {
    maxSize?: number; // Maximum number of entries
    maxMemory?: number; // Maximum memory usage in bytes
    defaultTTL?: number; // Default TTL in milliseconds
    cleanupInterval?: number; // Cleanup interval in milliseconds
}

/**
 * In-memory cache implementation with TTL and LRU eviction
 */
export class MemoryCache implements CacheProvider {
    private cache = new Map<string, CacheEntry<any>>();
    private config: Required<MemoryCacheConfig>;
    private cleanupTimer?: Timer;
    private stats = {
        hits: 0,
        misses: 0,
        size: 0,
        memoryUsage: 0
    };

    constructor(config: MemoryCacheConfig = {}) {
        this.config = {
            maxSize: config.maxSize ?? 10000,
            maxMemory: config.maxMemory ?? 100 * 1024 * 1024, // 100MB default
            defaultTTL: config.defaultTTL ?? 3600000, // 1 hour default
            cleanupInterval: config.cleanupInterval ?? 60000 // 1 minute default
        };

        this.startCleanupTimer();
    }

    async get<T>(key: string): Promise<T | null> {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Check if expired
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.stats.size--;
            this.stats.memoryUsage = Math.max(0, this.stats.memoryUsage - entry.size);
            this.stats.misses++;
            return null;
        }

        // Move to end of Map iteration order (most recently used) for O(1) LRU.
        this.cache.delete(key);
        this.cache.set(key, entry);
        entry.accessCount++;

        this.stats.hits++;
        return entry.value;
    }

    async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        this.writeEntry(key, value, ttl);
        await this.evictIfNeeded();
    }

    private writeEntry<T>(key: string, value: T, ttl?: number): void {
        const expiresAt = ttl ? Date.now() + ttl : (this.config.defaultTTL ? Date.now() + this.config.defaultTTL : undefined);

        const size = this.entrySize(key, value);
        const entry: CacheEntry<T> = {
            value,
            expiresAt,
            accessCount: 1,
            size
        };

        const existing = this.cache.get(key);
        if (existing) {
            this.stats.memoryUsage = Math.max(0, this.stats.memoryUsage - existing.size);
            this.cache.delete(key);
        } else {
            this.stats.size++;
        }
        this.cache.set(key, entry);
        this.stats.memoryUsage += size;
    }

    async delete(key: string | string[]): Promise<void> {
        const keys = Array.isArray(key) ? key : [key];

        for (const k of keys) {
            const entry = this.cache.get(k);
            if (entry) {
                this.cache.delete(k);
                this.stats.size--;
                this.stats.memoryUsage = Math.max(0, this.stats.memoryUsage - entry.size);
            }
        }
    }

    async clear(): Promise<void> {
        this.cache.clear();
        this.stats.size = 0;
        this.stats.memoryUsage = 0;
        this.stats.hits = 0;
        this.stats.misses = 0;
    }

    async getMany<T>(keys: string[]): Promise<(T | null)[]> {
        const results: (T | null)[] = [];

        for (const key of keys) {
            const value = await this.get<T>(key);
            results.push(value);
        }

        return results;
    }

    async setMany<T>(entries: Array<{key: string, value: T, ttl?: number}>): Promise<void> {
        for (const entry of entries) {
            this.writeEntry(entry.key, entry.value, entry.ttl);
        }
        await this.evictIfNeeded();
    }

    async deleteMany(keys: string[]): Promise<void> {
        return this.delete(keys);
    }

    async invalidatePattern(pattern: string): Promise<void> {
        const max = cacheInvalidateMax();
        const keysToDelete: string[] = [];
        for (const key of this.cache.keys()) {
            if (!matchGlob(pattern, key)) continue;
            keysToDelete.push(key);
            if (keysToDelete.length > max) {
                throw new CacheInvalidateCapExceededError(pattern, max);
            }
        }

        await this.delete(keysToDelete);
    }

    async ping(): Promise<boolean> {
        return true; // Memory cache is always available
    }

    async getStats(): Promise<CacheStats> {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;

        return {
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate,
            size: this.stats.size,
            memoryUsage: this.stats.memoryUsage,
            memoryUsageHuman: formatBytes(this.stats.memoryUsage)
        };
    }

    private entrySize(key: string, value: any): number {
        // key string overhead + value estimate + fixed per-entry metadata
        return key.length * 2 + this.estimateValueSize(value) + 100;
    }

    private estimateValueSize(value: any): number {
        if (value === null || value === undefined) return 8;
        if (typeof value === 'string') return value.length * 2;
        if (typeof value === 'number') return 8;
        if (typeof value === 'boolean') return 1;
        if (Array.isArray(value)) {
            return value.reduce((size, item) => size + this.estimateValueSize(item), 16); // Array overhead
        }
        if (typeof value === 'object') {
            let size = 16; // Object overhead
            for (const key in value) {
                size += key.length * 2 + this.estimateValueSize(value[key]);
            }
            return size;
        }
        return 16; // Default size for other types
    }

    private async evictIfNeeded(): Promise<void> {
        // setMany can cross the cap by many entries in one call. Keep evicting
        // until both limits hold, matching the per-write behavior of set().
        while (this.stats.size > this.config.maxSize || this.stats.memoryUsage > this.config.maxMemory) {
            const before = this.stats.size;
            await this.evictLRU(Math.max(1, Math.ceil(this.config.maxSize * 0.1)));
            if (this.stats.size >= before) break;
        }
    }

    private async evictLRU(count: number): Promise<void> {
        // Map iteration order is insertion order. get() and set() move accessed/
        // updated keys to the end, so keys at the front are least recently used.
        // Collect the first `count` keys without sorting or materialising a full array.
        const keysToDelete: string[] = [];
        for (const key of this.cache.keys()) {
            if (keysToDelete.length >= count) break;
            keysToDelete.push(key);
        }

        await this.delete(keysToDelete);
        logger.debug(`Evicted ${keysToDelete.length} entries from cache due to LRU policy`);
    }

    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired();
        }, this.config.cleanupInterval);
        // Allow the process to exit without waiting for this maintenance timer.
        this.cleanupTimer?.unref?.();
    }

    private cleanupExpired(): void {
        const now = Date.now();
        const keysToDelete: string[] = [];

        for (const [key, entry] of this.cache) {
            if (entry.expiresAt && now > entry.expiresAt) {
                keysToDelete.push(key);
            }
        }

        if (keysToDelete.length > 0) {
            this.delete(keysToDelete).catch(error => {
                logger.error('Error during cache cleanup:', error);
            });
        }
    }

    /**
     * Stop the cleanup timer (useful for testing or shutdown)
     */
    stopCleanup(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
    }
}