import { CacheProvider } from './CacheProvider.js';
import { CacheConfig } from '../config/cache.config.js';

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

  async delete(key: string): Promise<boolean> {
    let deleted = false;

    // Delete from L1 cache
    deleted = await this.l1Cache.delete(key) || deleted;

    // Delete from L2 cache if available
    if (this.l2Cache) {
      deleted = await this.l2Cache.delete(key) || deleted;
    }

    return deleted;
  }

  async has(key: string): Promise<boolean> {
    // Check L1 first
    if (await this.l1Cache.has(key)) {
      return true;
    }

    // Check L2 if L1 miss
    if (this.l2Cache) {
      return await this.l2Cache.has(key);
    }

    return false;
  }

  async clear(): Promise<void> {
    await this.l1Cache.clear();
    if (this.l2Cache) {
      await this.l2Cache.clear();
    }
  }

  async getMany(keys: string[]): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    const missingKeys: string[] = [];

    // Try L1 cache first
    const l1Results = await this.l1Cache.getMany(keys);
    for (const key of keys) {
      const value = l1Results.get(key);
      if (value !== null) {
        result.set(key, value);
      } else {
        missingKeys.push(key);
      }
    }

    // If L2 exists and we have missing keys, try L2
    if (this.l2Cache && missingKeys.length > 0) {
      const l2Results = await this.l2Cache.getMany(missingKeys);
      for (const [key, value] of l2Results) {
        if (value !== null) {
          result.set(key, value);
          // Promote to L1 cache
          await this.l1Cache.set(key, value, this.config.defaultTTL);
        }
      }
    }

    return result;
  }

  async setMany(entries: Map<string, any>, ttl?: number): Promise<void> {
    const effectiveTTL = ttl || this.config.defaultTTL;

    // Set in L1 cache
    await this.l1Cache.setMany(entries, effectiveTTL);

    // Set in L2 cache if available
    if (this.l2Cache) {
      await this.l2Cache.setMany(entries, effectiveTTL);
    }
  }

  async deleteMany(keys: string[]): Promise<boolean[]> {
    const l1Results = await this.l1Cache.deleteMany(keys);
    const l2Results = this.l2Cache ? await this.l2Cache.deleteMany(keys) : keys.map(() => false);

    // Return true if deleted from either level
    return keys.map((_, index) => l1Results[index] || l2Results[index]);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await this.l1Cache.invalidatePattern(pattern);
    if (this.l2Cache) {
      await this.l2Cache.invalidatePattern(pattern);
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; latency: number; details?: any }> {
    const l1Health = await this.l1Cache.healthCheck();

    if (!this.l2Cache) {
      return l1Health;
    }

    const l2Health = await this.l2Cache.healthCheck();

    // Multi-level cache is healthy if both levels are healthy
    const overallStatus = l1Health.status === 'healthy' && l2Health.status === 'healthy' ? 'healthy' : 'unhealthy';
    const avgLatency = (l1Health.latency + l2Health.latency) / 2;

    return {
      status: overallStatus,
      latency: avgLatency,
      details: {
        l1: l1Health,
        l2: l2Health
      }
    };
  }

  async getStats(): Promise<{
    hits: number;
    misses: number;
    hitRate: number;
    totalRequests: number;
    l1Stats?: any;
    l2Stats?: any;
  }> {
    const l1Stats = await this.l1Cache.getStats?.() || { hits: 0, misses: 0, hitRate: 0, totalRequests: 0 };
    const l2Stats = this.l2Cache ? await this.l2Cache.getStats?.() || { hits: 0, misses: 0, hitRate: 0, totalRequests: 0 } : null;

    const totalHits = l1Stats.hits + (l2Stats?.hits || 0);
    const totalMisses = l1Stats.misses + (l2Stats?.misses || 0);
    const totalRequests = totalHits + totalMisses;
    const hitRate = totalRequests > 0 ? totalHits / totalRequests : 0;

    return {
      hits: totalHits,
      misses: totalMisses,
      hitRate,
      totalRequests,
      l1Stats,
      l2Stats
    };
  }
}