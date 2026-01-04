import { type CacheProvider, type CacheStats } from './CacheProvider';
import { logger } from '../Logger';

interface CacheEntry<T> {
    value: T;
    expiresAt?: number;
    lastAccessed: number;
    accessCount: number;
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
    private accessCounter = 0; // For LRU ordering

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
            this.stats.misses++;
            this.updateMemoryUsage();
            return null;
        }

        // Update access tracking for LRU
        entry.lastAccessed = ++this.accessCounter;
        entry.accessCount++;

        this.stats.hits++;
        return entry.value;
    }

    async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        const expiresAt = ttl ? Date.now() + ttl : (this.config.defaultTTL ? Date.now() + this.config.defaultTTL : undefined);

        const entry: CacheEntry<T> = {
            value,
            expiresAt,
            lastAccessed: ++this.accessCounter,
            accessCount: 1
        };

        const wasNew = !this.cache.has(key);
        this.cache.set(key, entry);

        if (wasNew) {
            this.stats.size++;
        }

        this.updateMemoryUsage();

        // Evict if necessary
        await this.evictIfNeeded();
    }

    async delete(key: string | string[]): Promise<void> {
        const keys = Array.isArray(key) ? key : [key];
        let deletedCount = 0;

        for (const k of keys) {
            if (this.cache.delete(k)) {
                deletedCount++;
            }
        }

        this.stats.size -= deletedCount;
        this.updateMemoryUsage();
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
            await this.set(entry.key, entry.value, entry.ttl);
        }
    }

    async deleteMany(keys: string[]): Promise<void> {
        return this.delete(keys);
    }

    async invalidatePattern(pattern: string): Promise<void> {
        // Simple pattern matching - convert glob to regex
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));

        const keysToDelete: string[] = [];
        for (const key of Array.from(this.cache.keys())) {
            if (regex.test(key)) {
                keysToDelete.push(key);
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
            memoryUsage: this.stats.memoryUsage
        };
    }

    private updateMemoryUsage(): void {
        // Rough estimation of memory usage
        // Each entry has overhead for the key, value, and metadata
        let memoryUsage = 0;
        for (const [key, entry] of Array.from(this.cache.entries())) {
            memoryUsage += key.length * 2; // Rough string overhead
            memoryUsage += this.estimateValueSize(entry.value);
            memoryUsage += 100; // Overhead for entry metadata
        }
        this.stats.memoryUsage = memoryUsage;
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
        // Check size limit
        if (this.stats.size > this.config.maxSize) {
            await this.evictLRU(Math.ceil(this.config.maxSize * 0.1)); // Evict 10% of max size
        }

        // Check memory limit
        if (this.stats.memoryUsage > this.config.maxMemory) {
            await this.evictLRU(Math.ceil(this.config.maxSize * 0.1)); // Evict 10% of max size
        }
    }

    private async evictLRU(count: number): Promise<void> {
        // Sort entries by last accessed time (oldest first)
        const entries = Array.from(this.cache.entries())
            .map(([key, entry]) => ({ key, entry }))
            .sort((a, b) => a.entry.lastAccessed - b.entry.lastAccessed);

        const keysToDelete = entries.slice(0, count).map(item => item.key);
        await this.delete(keysToDelete);

        logger.debug(`Evicted ${keysToDelete.length} entries from cache due to LRU policy`);
    }

    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired();
        }, this.config.cleanupInterval);
    }

    private cleanupExpired(): void {
        const now = Date.now();
        const keysToDelete: string[] = [];

        for (const [key, entry] of Array.from(this.cache.entries())) {
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