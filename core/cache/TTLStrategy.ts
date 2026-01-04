import { CacheProvider } from './CacheProvider.js';

/**
 * TTLStrategy implements dynamic TTL management based on data access patterns.
 * Tracks access frequency and adjusts TTL accordingly to optimize cache efficiency.
 *
 * Features:
 * - Hot data detection: doubles TTL for frequently accessed data
 * - Cold data detection: halves TTL for rarely accessed data
 * - Access pattern tracking with sliding window
 * - Configurable thresholds for hot/cold classification
 */
export class TTLStrategy {
  private accessCounts: Map<string, number> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  private baseTTL: number;
  private hotThreshold: number;
  private coldThreshold: number;
  private windowSize: number;

  constructor(
    baseTTL: number = 3600000, // 1 hour default
    hotThreshold: number = 10, // 10 accesses = hot
    coldThreshold: number = 1, // 1 access = cold
    windowSize: number = 300000 // 5 minutes window
  ) {
    this.baseTTL = baseTTL;
    this.hotThreshold = hotThreshold;
    this.coldThreshold = coldThreshold;
    this.windowSize = windowSize;
  }

  /**
   * Records an access to a cache key and returns the appropriate TTL
   */
  recordAccess(key: string): number {
    const now = Date.now();
    const lastAccess = this.lastAccessTime.get(key) || 0;
    const timeDiff = now - lastAccess;

    // Reset count if outside window
    if (timeDiff > this.windowSize) {
      this.accessCounts.set(key, 1);
    } else {
      const currentCount = this.accessCounts.get(key) || 0;
      this.accessCounts.set(key, currentCount + 1);
    }

    this.lastAccessTime.set(key, now);

    const accessCount = this.accessCounts.get(key) || 0;
    return this.calculateTTL(accessCount);
  }

  /**
   * Calculates TTL based on access frequency
   */
  private calculateTTL(accessCount: number): number {
    if (accessCount >= this.hotThreshold) {
      // Hot data: double TTL
      return this.baseTTL * 2;
    } else if (accessCount <= this.coldThreshold) {
      // Cold data: halve TTL
      return Math.max(this.baseTTL / 2, 60000); // Minimum 1 minute
    } else {
      // Normal data: base TTL
      return this.baseTTL;
    }
  }

  /**
   * Gets current access statistics for a key
   */
  getAccessStats(key: string): { count: number; lastAccess: number; ttl: number; category: 'hot' | 'cold' | 'normal' } {
    const count = this.accessCounts.get(key) || 0;
    const lastAccess = this.lastAccessTime.get(key) || 0;
    const ttl = this.calculateTTL(count);

    let category: 'hot' | 'cold' | 'normal';
    if (count >= this.hotThreshold) {
      category = 'hot';
    } else if (count <= this.coldThreshold) {
      category = 'cold';
    } else {
      category = 'normal';
    }

    return { count, lastAccess, ttl, category };
  }

  /**
   * Cleans up old access records to prevent memory leaks
   */
  cleanup(maxAge: number = 3600000): void { // 1 hour default
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, lastAccess] of this.lastAccessTime) {
      if (now - lastAccess > maxAge) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.accessCounts.delete(key);
      this.lastAccessTime.delete(key);
    }
  }

  /**
   * Gets overall statistics
   */
  getStats(): {
    totalKeys: number;
    hotKeys: number;
    coldKeys: number;
    normalKeys: number;
    averageAccessCount: number;
  } {
    let hotKeys = 0;
    let coldKeys = 0;
    let normalKeys = 0;
    let totalAccessCount = 0;

    for (const [key, count] of this.accessCounts) {
      totalAccessCount += count;

      if (count >= this.hotThreshold) {
        hotKeys++;
      } else if (count <= this.coldThreshold) {
        coldKeys++;
      } else {
        normalKeys++;
      }
    }

    const totalKeys = this.accessCounts.size;
    const averageAccessCount = totalKeys > 0 ? totalAccessCount / totalKeys : 0;

    return {
      totalKeys,
      hotKeys,
      coldKeys,
      normalKeys,
      averageAccessCount
    };
  }

  /**
   * Resets all tracking data
   */
  reset(): void {
    this.accessCounts.clear();
    this.lastAccessTime.clear();
  }
}

/**
 * Enhanced cache provider that integrates TTL strategy
 */
export class AdaptiveTTLProvider implements CacheProvider {
  private cache: CacheProvider;
  private ttlStrategy: TTLStrategy;

  constructor(cache: CacheProvider, ttlStrategy: TTLStrategy) {
    this.cache = cache;
    this.ttlStrategy = ttlStrategy;
  }

  async get(key: string): Promise<any | null> {
    const result = await this.cache.get(key);
    if (result !== null) {
      // Record access for TTL adjustment
      this.ttlStrategy.recordAccess(key);
    }
    return result;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Use TTL strategy if no explicit TTL provided
    const effectiveTTL = ttl || this.ttlStrategy.recordAccess(key);
    await this.cache.set(key, value, effectiveTTL);
  }

  async delete(key: string): Promise<boolean> {
    return await this.cache.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return await this.cache.has(key);
  }

  async clear(): Promise<void> {
    await this.cache.clear();
    this.ttlStrategy.reset();
  }

  async getMany(keys: string[]): Promise<Map<string, any>> {
    const result = await this.cache.getMany(keys);

    // Record access for found keys
    for (const key of keys) {
      if (result.has(key)) {
        this.ttlStrategy.recordAccess(key);
      }
    }

    return result;
  }

  async setMany(entries: Map<string, any>, ttl?: number): Promise<void> {
    const entriesWithTTL = new Map<string, any>();

    for (const [key] of entries) {
      const effectiveTTL = ttl || this.ttlStrategy.recordAccess(key);
      entriesWithTTL.set(key, { value: entries.get(key), ttl: effectiveTTL });
    }

    // Note: This assumes the underlying cache supports per-entry TTL
    // If not, we fall back to the provided TTL or base TTL
    await this.cache.setMany(entries, ttl);
  }

  async deleteMany(keys: string[]): Promise<boolean[]> {
    return await this.cache.deleteMany(keys);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await this.cache.invalidatePattern(pattern);
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; latency: number; details?: any }> {
    return await this.cache.healthCheck();
  }

  getStats(): Promise<{ hits: number; misses: number; hitRate: number; totalRequests: number }> | undefined {
    return this.cache.getStats?.();
  }

  /**
   * Gets TTL strategy statistics
   */
  getTTLStats() {
    return this.ttlStrategy.getStats();
  }

  /**
   * Gets access stats for a specific key
   */
  getKeyAccessStats(key: string) {
    return this.ttlStrategy.getAccessStats(key);
  }

  /**
   * Cleans up old access records
   */
  cleanupAccessRecords(maxAge?: number) {
    this.ttlStrategy.cleanup(maxAge);
  }
}