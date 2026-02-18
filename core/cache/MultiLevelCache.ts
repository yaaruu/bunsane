import type { CacheProvider, CacheStats } from './CacheProvider.js';
import type { CacheConfig } from '../../config/cache.config.js';

/**
 * MultiLevelCache implements a two-tier caching strategy with L1 in-memory cache
 * and L2 persistent cache (Redis). This provides optimal performance by serving
 * frequently accessed data from memory while maintaining persistence across requests.
 *
 * Key Features:
 * - L1 MemoryCache for fast access to hot data
 * - L2 RedisCache for persistence and cross-instance sharing
 * - Automatic L1 promotion on L2 cache hits
 * - Configurable TTL strategies for each level
 * - Write-through strategy for data consistency
 */
export class MultiLevelCache implements CacheProvider {
  private l1Cache: CacheProvider;
  private l2Cache: CacheProvider | null;
  private config: CacheConfig;

  constructor(l1Cache: CacheProvider, l2Cache: CacheProvider | null, config: CacheConfig) {
    this.l1Cache = l1Cache;
    this.l2Cache = l2Cache;
    this.config = config;
  }

  getL1Cache(): CacheProvider {
    return this.l1Cache;
  }

  getL2Cache(): CacheProvider | null {
    return this.l2Cache;
  }

  async get(key: string): Promise<any | null> {
    // Try L1 cache first
    const l1Result = await this.l1Cache.get(key);
    if (l1Result !== null) {
      return l1Result;
    }

    // If L1 miss and L2 exists, try L2
    if (this.l2Cache) {
      const l2Result = await this.l2Cache.get(key);
      if (l2Result !== null) {
        // Promote to L1 cache for faster future access
        await this.l1Cache.set(key, l2Result, this.config.defaultTTL);
        return l2Result;
      }
    }

    return null;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const effectiveTTL = ttl || this.config.defaultTTL;

    // Set in L1 cache
    await this.l1Cache.set(key, value, effectiveTTL);

    // Set in L2 cache if available
    if (this.l2Cache) {
      await this.l2Cache.set(key, value, effectiveTTL);
    }
  }

  async delete(key: string | string[]): Promise<void> {
    // Delete from L1 cache
    await this.l1Cache.delete(key);

    // Delete from L2 cache if available
    if (this.l2Cache) {
      await this.l2Cache.delete(key);
    }
  }

  async clear(): Promise<void> {
    await this.l1Cache.clear();
    if (this.l2Cache) {
      await this.l2Cache.clear();
    }
  }

  async getMany<T>(keys: string[]): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(keys.length).fill(null);
    const missingIndices: number[] = [];
    const missingKeys: string[] = [];

    // Try L1 cache first
    const l1Results = await this.l1Cache.getMany<T>(keys);
    for (let i = 0; i < keys.length; i++) {
      const l1Value = l1Results[i];
      const key = keys[i];
      if (l1Value !== null && l1Value !== undefined) {
        results[i] = l1Value;
      } else if (key !== undefined) {
        missingIndices.push(i);
        missingKeys.push(key);
      }
    }

    // If L2 exists and we have missing keys, try L2
    if (this.l2Cache && missingKeys.length > 0) {
      const l2Results = await this.l2Cache.getMany<T>(missingKeys);
      for (let i = 0; i < missingKeys.length; i++) {
        const value = l2Results[i];
        const originalIndex = missingIndices[i];
        const missingKey = missingKeys[i];
        if (value !== null && value !== undefined && originalIndex !== undefined && missingKey !== undefined) {
          results[originalIndex] = value;
          // Promote to L1 cache
          await this.l1Cache.set(missingKey, value, this.config.defaultTTL);
        }
      }
    }

    return results;
  }

  async setMany<T>(entries: Array<{key: string, value: T, ttl?: number}>): Promise<void> {
    // Apply default TTL to entries without one
    const entriesWithTTL = entries.map(e => ({
      ...e,
      ttl: e.ttl || this.config.defaultTTL
    }));

    // Set in L1 cache
    await this.l1Cache.setMany(entriesWithTTL);

    // Set in L2 cache if available
    if (this.l2Cache) {
      await this.l2Cache.setMany(entriesWithTTL);
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    await this.l1Cache.deleteMany(keys);
    if (this.l2Cache) {
      await this.l2Cache.deleteMany(keys);
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await this.l1Cache.invalidatePattern(pattern);
    if (this.l2Cache) {
      await this.l2Cache.invalidatePattern(pattern);
    }
  }

  async ping(): Promise<boolean> {
    const l1Ping = await this.l1Cache.ping();

    if (!this.l2Cache) {
      return l1Ping;
    }

    const l2Ping = await this.l2Cache.ping();

    // Multi-level cache is healthy if both levels are healthy
    return l1Ping && l2Ping;
  }

  async getStats(): Promise<CacheStats> {
    const l1Stats = await this.l1Cache.getStats();
    const l2Stats = this.l2Cache ? await this.l2Cache.getStats() : null;

    const totalHits = l1Stats.hits + (l2Stats?.hits || 0);
    const totalMisses = l1Stats.misses + (l2Stats?.misses || 0);
    const totalRequests = totalHits + totalMisses;
    const hitRate = totalRequests > 0 ? totalHits / totalRequests : 0;

    return {
      hits: totalHits,
      misses: totalMisses,
      hitRate,
      size: l1Stats.size + (l2Stats?.size || 0),
      memoryUsage: (l1Stats.memoryUsage || 0) + (l2Stats?.memoryUsage || 0)
    };
  }
}