import { CacheProvider } from './CacheProvider.js';

/**
 * CacheReport provides comprehensive analytics about cache performance
 * and recommendations for optimization.
 */
export interface CacheReport {
  /** Overall cache hit rate (0.0 to 1.0) */
  hitRate: number;

  /** Total number of cache requests */
  totalRequests: number;

  /** Number of cache hits */
  hits: number;

  /** Number of cache misses */
  misses: number;

  /** Average response time in milliseconds */
  averageLatency: number;

  /** Peak memory usage in bytes */
  memoryUsage?: number;

  /** Cache efficiency score (0.0 to 1.0) */
  efficiency: number;

  /** List of optimization recommendations */
  recommendations: string[];

  /** Detailed breakdown by operation type */
  breakdown: {
    get: { hits: number; misses: number; hitRate: number };
    set: { operations: number; averageLatency: number };
    delete: { operations: number; averageLatency: number };
  };

  /** Time period covered by this report */
  timeRange: {
    start: Date;
    end: Date;
  };
}

/**
 * CacheAnalytics tracks cache performance metrics and provides
 * optimization recommendations based on usage patterns.
 *
 * Features:
 * - Hit/miss rate tracking
 * - Latency monitoring
 * - Memory usage analysis
 * - Automated recommendations
 * - Performance trend analysis
 */
export class CacheAnalytics {
  private metrics: {
    hits: number;
    misses: number;
    totalRequests: number;
    latencies: number[];
    operationLatencies: Map<string, number[]>;
    memoryUsage: number[];
    startTime: Date;
  };

  private readonly maxLatencySamples = 1000;
  private readonly maxMemorySamples = 100;

  constructor() {
    this.metrics = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      latencies: [],
      operationLatencies: new Map(),
      memoryUsage: [],
      startTime: new Date()
    };
  }

  /**
   * Records a cache hit
   */
  recordHit(operation: string = 'get', latency?: number): void {
    this.metrics.hits++;
    this.metrics.totalRequests++;
    this.recordLatency(operation, latency);
  }

  /**
   * Records a cache miss
   */
  recordMiss(operation: string = 'get', latency?: number): void {
    this.metrics.misses++;
    this.metrics.totalRequests++;
    this.recordLatency(operation, latency);
  }

  /**
   * Records operation latency
   */
  private recordLatency(operation: string, latency?: number): void {
    if (latency !== undefined) {
      this.metrics.latencies.push(latency);

      // Keep only recent samples
      if (this.metrics.latencies.length > this.maxLatencySamples) {
        this.metrics.latencies.shift();
      }

      // Record per-operation latency
      if (!this.metrics.operationLatencies.has(operation)) {
        this.metrics.operationLatencies.set(operation, []);
      }
      const opLatencies = this.metrics.operationLatencies.get(operation)!;
      opLatencies.push(latency);

      // Keep only recent samples per operation
      if (opLatencies.length > this.maxLatencySamples / 10) {
        opLatencies.shift();
      }
    }
  }

  /**
   * Records memory usage
   */
  recordMemoryUsage(bytes: number): void {
    this.metrics.memoryUsage.push(bytes);

    // Keep only recent samples
    if (this.metrics.memoryUsage.length > this.maxMemorySamples) {
      this.metrics.memoryUsage.shift();
    }
  }

  /**
   * Generates a comprehensive cache performance report
   */
  getReport(): CacheReport {
    const hitRate = this.metrics.totalRequests > 0 ? this.metrics.hits / this.metrics.totalRequests : 0;
    const averageLatency = this.metrics.latencies.length > 0
      ? this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length
      : 0;

    const memoryUsage = this.metrics.memoryUsage.length > 0
      ? Math.max(...this.metrics.memoryUsage)
      : undefined;

    const efficiency = this.calculateEfficiency(hitRate, averageLatency);

    const recommendations = this.generateRecommendations(hitRate, averageLatency, memoryUsage);

    const breakdown = this.generateBreakdown();

    return {
      hitRate,
      totalRequests: this.metrics.totalRequests,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      averageLatency,
      memoryUsage,
      efficiency,
      recommendations,
      breakdown,
      timeRange: {
        start: this.metrics.startTime,
        end: new Date()
      }
    };
  }

  /**
   * Calculates cache efficiency score
   */
  private calculateEfficiency(hitRate: number, averageLatency: number): number {
    // Efficiency is based on hit rate and latency
    // Higher hit rate and lower latency = higher efficiency
    const latencyScore = Math.max(0, 1 - (averageLatency / 100)); // Assume 100ms is poor
    const hitRateScore = hitRate;

    return (latencyScore + hitRateScore) / 2;
  }

  /**
   * Generates optimization recommendations
   */
  private generateRecommendations(hitRate: number, averageLatency: number, memoryUsage?: number): string[] {
    const recommendations: string[] = [];

    if (hitRate < 0.5) {
      recommendations.push('Cache hit rate is below 50%. Consider increasing TTL or preloading frequently accessed data.');
    }

    if (hitRate > 0.9) {
      recommendations.push('Excellent hit rate! Consider increasing TTL to reduce database load further.');
    }

    if (averageLatency > 50) {
      recommendations.push('High latency detected. Consider using faster storage or optimizing cache key generation.');
    }

    if (averageLatency < 1) {
      recommendations.push('Very low latency achieved. Cache performance is optimal.');
    }

    if (memoryUsage && memoryUsage > 100 * 1024 * 1024) { // 100MB
      recommendations.push('High memory usage detected. Consider implementing compression or reducing TTL.');
    }

    if (this.metrics.totalRequests < 100) {
      recommendations.push('Low request volume. Monitor performance as traffic increases.');
    }

    return recommendations;
  }

  /**
   * Generates detailed breakdown by operation type
   */
  private generateBreakdown() {
    const getLatencies = this.metrics.operationLatencies.get('get') || [];
    const setLatencies = this.metrics.operationLatencies.get('set') || [];
    const deleteLatencies = this.metrics.operationLatencies.get('delete') || [];

    const getHits = this.metrics.hits; // Assuming all hits are from get operations
    const getMisses = this.metrics.misses; // Assuming all misses are from get operations
    const getHitRate = (getHits + getMisses) > 0 ? getHits / (getHits + getMisses) : 0;

    return {
      get: {
        hits: getHits,
        misses: getMisses,
        hitRate: getHitRate
      },
      set: {
        operations: setLatencies.length,
        averageLatency: setLatencies.length > 0 ? setLatencies.reduce((a, b) => a + b, 0) / setLatencies.length : 0
      },
      delete: {
        operations: deleteLatencies.length,
        averageLatency: deleteLatencies.length > 0 ? deleteLatencies.reduce((a, b) => a + b, 0) / deleteLatencies.length : 0
      }
    };
  }

  /**
   * Resets all metrics
   */
  reset(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      latencies: [],
      operationLatencies: new Map(),
      memoryUsage: [],
      startTime: new Date()
    };
  }

  /**
   * Gets current metrics summary
   */
  getSummary(): {
    hitRate: number;
    totalRequests: number;
    averageLatency: number;
    efficiency: number;
  } {
    const report = this.getReport();
    return {
      hitRate: report.hitRate,
      totalRequests: report.totalRequests,
      averageLatency: report.averageLatency,
      efficiency: report.efficiency
    };
  }
}

/**
 * Enhanced cache provider with analytics integration
 */
export class AnalyticsCacheProvider implements CacheProvider {
  private cache: CacheProvider;
  private analytics: CacheAnalytics;

  constructor(cache: CacheProvider, analytics?: CacheAnalytics) {
    this.cache = cache;
    this.analytics = analytics || new CacheAnalytics();
  }

  async get(key: string): Promise<any | null> {
    const startTime = Date.now();
    const result = await this.cache.get(key);
    const latency = Date.now() - startTime;

    if (result !== null) {
      this.analytics.recordHit('get', latency);
    } else {
      this.analytics.recordMiss('get', latency);
    }

    return result;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const startTime = Date.now();
    await this.cache.set(key, value, ttl);
    const latency = Date.now() - startTime;

    this.analytics.recordLatency('set', latency);
  }

  async delete(key: string): Promise<boolean> {
    const startTime = Date.now();
    const result = await this.cache.delete(key);
    const latency = Date.now() - startTime;

    this.analytics.recordLatency('delete', latency);
    return result;
  }

  async has(key: string): Promise<boolean> {
    return await this.cache.has(key);
  }

  async clear(): Promise<void> {
    await this.cache.clear();
    this.analytics.reset();
  }

  async getMany(keys: string[]): Promise<Map<string, any>> {
    const startTime = Date.now();
    const result = await this.cache.getMany(keys);
    const latency = Date.now() - startTime;

    // Count hits and misses
    let hits = 0;
    let misses = 0;

    for (const key of keys) {
      if (result.has(key)) {
        hits++;
      } else {
        misses++;
      }
    }

    // Record metrics (approximate - we don't know individual latencies)
    for (let i = 0; i < hits; i++) {
      this.analytics.recordHit('get', latency / keys.length);
    }
    for (let i = 0; i < misses; i++) {
      this.analytics.recordMiss('get', latency / keys.length);
    }

    return result;
  }

  async setMany(entries: Map<string, any>, ttl?: number): Promise<void> {
    const startTime = Date.now();
    await this.cache.setMany(entries, ttl);
    const latency = Date.now() - startTime;

    this.analytics.recordLatency('set', latency);
  }

  async deleteMany(keys: string[]): Promise<boolean[]> {
    const startTime = Date.now();
    const result = await this.cache.deleteMany(keys);
    const latency = Date.now() - startTime;

    this.analytics.recordLatency('delete', latency);
    return result;
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
   * Gets the analytics instance
   */
  getAnalytics(): CacheAnalytics {
    return this.analytics;
  }

  /**
   * Gets current performance report
   */
  getReport(): CacheReport {
    return this.analytics.getReport();
  }
}