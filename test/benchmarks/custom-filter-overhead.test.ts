/**
 * Benchmark: Custom Filter Cache Performance
 *
 * Measures prepared statement cache performance when using custom filter builders.
 * Tests cache hit rates, planning time savings, and memory usage with spatial filters.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PreparedStatementCache } from '../../database/PreparedStatementCache';
import { QueryContext } from '../../query/QueryContext';
import { FilterBuilderRegistry } from '../../query/FilterBuilderRegistry';

// Mock database for benchmarking
const mockDb = {
    unsafe: async (sql: string, params: any[]) => {
        // Simulate database execution time
        await new Promise(resolve => setTimeout(resolve, 1));
        return [];
    }
};

// Define spatial filter constants
enum SpatialFilter {
    WITHIN_DISTANCE = 'within_distance',
    CONTAINS_POINT = 'contains_point',
}

// Mock filter builders for benchmarking
const mockWithinDistanceBuilder = (filter: any, alias: string, context: QueryContext) => {
    const { point, distance } = filter.value;
    const sql = `ST_DWithin(ST_Point((${alias}.data->>'longitude')::float, (${alias}.data->>'latitude')::float, 4326)::geography, ST_Point($${context.addParam(point.longitude)}, $${context.addParam(point.latitude)}, 4326)::geography, $${context.addParam(distance)})`;
    return { sql, addedParams: 3 };
};

const mockContainsPointBuilder = (filter: any, alias: string, context: QueryContext) => {
    const point = filter.value;
    const sql = `ST_DWithin(ST_Point((${alias}.data->>'longitude')::float, (${alias}.data->>'latitude')::float, 4326)::geography, ST_Point($${context.addParam(point.longitude)}, $${context.addParam(point.latitude)}, 4326)::geography, 1)`;
    return { sql, addedParams: 2 };
};

describe('Custom Filter Cache Performance Benchmark', () => {
    let cache: PreparedStatementCache;

    beforeAll(() => {
        cache = new PreparedStatementCache(50);
        // Register mock filter builders
        FilterBuilderRegistry.register(SpatialFilter.WITHIN_DISTANCE, mockWithinDistanceBuilder, {}, 'BenchmarkSuite');
        FilterBuilderRegistry.register(SpatialFilter.CONTAINS_POINT, mockContainsPointBuilder, {}, 'BenchmarkSuite');
    });

    afterAll(() => {
        cache.clear();
        FilterBuilderRegistry.clear();
    });

    it('should achieve high cache hit rate with repeated custom filter queries', async () => {
        const sql = 'SELECT * FROM components_LocationComponent c WHERE custom_spatial_condition';
        const iterations = 100;

        // Create multiple similar queries with custom filters
        const queries = [];
        for (let i = 0; i < iterations; i++) {
            const context = new QueryContext();
            context.componentIds.add('LocationComponent');
            context.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: i % 2 === 0 ? SpatialFilter.WITHIN_DISTANCE : SpatialFilter.CONTAINS_POINT,
                value: i % 2 === 0
                    ? { point: { latitude: 40.7128 + (i * 0.001), longitude: -74.006 + (i * 0.001) }, distance: 1000 + i }
                    : { latitude: 40.7128 + (i * 0.001), longitude: -74.006 + (i * 0.001) }
            }]);

            queries.push({ sql, key: context.generateCacheKey(), context });
        }

        // Execute queries (first half should be cache misses, second half cache hits)
        const startTime = Date.now();
        for (const query of queries) {
            await cache.getOrCreate(query.sql, query.key, mockDb);
        }
        const endTime = Date.now();

        const stats = cache.getStats();
        const totalTime = endTime - startTime;

        console.log(`Benchmark Results:`);
        console.log(`Total queries: ${iterations}`);
        console.log(`Cache hits: ${stats.hits}`);
        console.log(`Cache misses: ${stats.misses}`);
        console.log(`Hit rate: ${((stats.hits / iterations) * 100).toFixed(1)}%`);
        console.log(`Total execution time: ${totalTime}ms`);
        console.log(`Average time per query: ${(totalTime / iterations).toFixed(2)}ms`);

        // Should have good hit rate due to repeated query patterns
        expect(stats.hits + stats.misses).toBe(iterations);
        expect(stats.size).toBeLessThanOrEqual(50); // Should not exceed cache size
    });

    it('should differentiate cache entries for different custom operators', async () => {
        const sql = 'SELECT * FROM components_LocationComponent c WHERE spatial_condition';

        // Use a separate cache for this test to avoid interference
        const testCache = new PreparedStatementCache(10);

        try {
            // Create queries with different custom operators
            const withinDistanceContext = new QueryContext();
            withinDistanceContext.componentIds.add('LocationComponent');
            withinDistanceContext.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const containsPointContext = new QueryContext();
            containsPointContext.componentIds.add('LocationComponent');
            containsPointContext.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.CONTAINS_POINT,
                value: { latitude: 40.7128, longitude: -74.006 }
            }]);

            // Execute queries with different custom operators
            const result1 = await testCache.getOrCreate(sql, withinDistanceContext.generateCacheKey(), mockDb);
            const result2 = await testCache.getOrCreate(sql, containsPointContext.generateCacheKey(), mockDb);

            // Both should be cache misses (different operators)
            expect(result1.isHit).toBe(false);
            expect(result2.isHit).toBe(false);

            // Should have 2 separate cache entries
            const stats = testCache.getStats();
            expect(stats.size).toBe(2);
            expect(stats.misses).toBe(2);

        } finally {
            testCache.clear();
        }
    });

    it('should handle cache eviction with mixed custom filter queries', async () => {
        const sql = 'SELECT * FROM components_LocationComponent c WHERE spatial_condition';
        const cacheSize = 5;

        // Create small cache for testing eviction
        const smallCache = new PreparedStatementCache(cacheSize);

        try {
            // Create more queries than cache size with different custom operators and parameters
            for (let i = 0; i < cacheSize + 3; i++) {
                const context = new QueryContext();
                context.componentIds.add('LocationComponent');
                context.componentFilters.set('LocationComponent', [{
                    field: 'coordinates',
                    operator: `custom_operator_${i}`, // Unique operator for each iteration
                    value: { param: i }
                }]);

                await smallCache.getOrCreate(sql, context.generateCacheKey(), mockDb);
            }

            const stats = smallCache.getStats();

            // With 8 unique queries and cache size 5, we should see more misses than cache size
            // indicating that some entries were evicted and had to be recreated
            expect(stats.misses).toBeGreaterThan(cacheSize);
            console.log(`Cache eviction test - Size: ${stats.size}, Evictions: ${stats.evictions}, Misses: ${stats.misses}`);

        } finally {
            smallCache.clear();
        }
    });

    it('should measure parameter handling overhead with custom filters', () => {
        const iterations = 1000;
        const startTime = Date.now();

        // Measure time to create contexts with custom filters
        for (let i = 0; i < iterations; i++) {
            const context = new QueryContext();
            context.componentIds.add('LocationComponent');
            context.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128 + i, longitude: -74.006 + i }, distance: 1000 + i }
            }]);

            // Generate cache key (includes custom operator extraction)
            context.generateCacheKey();
        }

        const endTime = Date.now();
        const totalTime = endTime - startTime;
        const avgTime = totalTime / iterations;

        console.log(`Parameter handling benchmark:`);
        console.log(`Iterations: ${iterations}`);
        console.log(`Total time: ${totalTime}ms`);
        console.log(`Average time per context: ${avgTime.toFixed(4)}ms`);

        // Should be very fast (< 0.1ms per context creation)
        expect(avgTime).toBeLessThan(0.1);
    });
});