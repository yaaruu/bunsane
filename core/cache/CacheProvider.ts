/**
 * Cache Provider Interface for BunSane Framework
 * Defines the contract for all cache implementations
 */

export interface CacheStats {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    memoryUsage?: number;
}

export interface CacheProvider {
    // Basic operations
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttl?: number): Promise<void>;
    delete(key: string | string[]): Promise<void>;
    clear(): Promise<void>;

    // Batch operations
    getMany<T>(keys: string[]): Promise<(T | null)[]>;
    setMany<T>(entries: Array<{key: string, value: T, ttl?: number}>): Promise<void>;
    deleteMany(keys: string[]): Promise<void>;

    // Pattern-based operations
    invalidatePattern(pattern: string): Promise<void>;

    // Health check
    ping(): Promise<boolean>;

    // Statistics
    getStats(): Promise<CacheStats>;
}