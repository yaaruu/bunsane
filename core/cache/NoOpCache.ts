import { type CacheProvider, type CacheStats } from './CacheProvider';

/**
 * No-op cache implementation for testing and cache-disabled scenarios
 * All operations return null/void and stats show zero activity
 */
export class NoOpCache implements CacheProvider {
    async get<T>(key: string): Promise<T | null> {
        return null;
    }

    async set<T>(key: string, value: T, ttl?: number): Promise<void> {
        // No-op
    }

    async delete(key: string | string[]): Promise<void> {
        // No-op
    }

    async clear(): Promise<void> {
        // No-op
    }

    async getMany<T>(keys: string[]): Promise<(T | null)[]> {
        return new Array(keys.length).fill(null);
    }

    async setMany<T>(entries: Array<{key: string, value: T, ttl?: number}>): Promise<void> {
        // No-op
    }

    async deleteMany(keys: string[]): Promise<void> {
        // No-op
    }

    async invalidatePattern(pattern: string): Promise<void> {
        // No-op
    }

    async ping(): Promise<boolean> {
        return true; // No-op cache is always "available"
    }

    async getStats(): Promise<CacheStats> {
        return {
            hits: 0,
            misses: 0,
            hitRate: 0,
            size: 0,
            memoryUsage: 0
        };
    }
}