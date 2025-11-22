/**
 * Unit tests for PreparedStatementCache with Custom Filter Integration
 *
 * Tests cache key generation and behavior when using custom filter builders.
 * Ensures that queries with different custom operators generate different cache keys.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PreparedStatementCache } from '../PreparedStatementCache';
import { QueryContext } from '../../query/QueryContext';
import { FilterBuilderRegistry } from '../../query/FilterBuilderRegistry';

// Mock database for testing
const mockDb = {
    unsafe: async (sql: string, params: any[]) => {
        // Mock execution - just return empty result
        return [];
    }
};

// Define spatial filter constants (matching SpatialDataPlugin)
enum SpatialFilter {
    WITHIN_DISTANCE = 'within_distance',
    CONTAINS_POINT = 'contains_point',
}

// Mock filter builders for testing
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

describe('PreparedStatementCache with Custom Filters', () => {
    let cache: PreparedStatementCache;

    beforeEach(() => {
        cache = new PreparedStatementCache(10);
        // Register mock filter builders
        FilterBuilderRegistry.register(SpatialFilter.WITHIN_DISTANCE, mockWithinDistanceBuilder, {}, 'TestSuite');
        FilterBuilderRegistry.register(SpatialFilter.CONTAINS_POINT, mockContainsPointBuilder, {}, 'TestSuite');
    });

    afterEach(() => {
        cache.clear();
        FilterBuilderRegistry.clear();
    });

    describe('cache key generation with custom filters', () => {
        it('should generate different cache keys for queries with different custom operators', () => {
            // Create context with within_distance filter
            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            // Create context with contains_point filter
            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.CONTAINS_POINT,
                value: { latitude: 40.7128, longitude: -74.006 }
            }]);

            const key1 = context1.generateCacheKey();
            const key2 = context2.generateCacheKey();

            expect(key1).not.toBe(key2);
            expect(key1).toContain('customOps:within_distance');
            expect(key2).toContain('customOps:contains_point');
        });

        it('should generate the same cache key for identical custom filter queries', () => {
            // Create two identical contexts with within_distance filter
            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const key1 = context1.generateCacheKey();
            const key2 = context2.generateCacheKey();

            expect(key1).toBe(key2);
        });

        it('should include multiple custom operators in cache key', () => {
            const context = new QueryContext();
            context.componentIds.add('LocationComponent');
            context.componentFilters.set('LocationComponent', [
                {
                    field: 'coordinates',
                    operator: SpatialFilter.WITHIN_DISTANCE,
                    value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
                },
                {
                    field: 'coordinates',
                    operator: SpatialFilter.CONTAINS_POINT,
                    value: { latitude: 40.7128, longitude: -74.006 }
                }
            ]);

            const key = context.generateCacheKey();

            // Should contain both operators in sorted order
            expect(key).toContain('customOps:contains_point,within_distance');
        });

        it('should generate the same cache key for custom filters with different parameter values', () => {
            // Same operator but different distance values - should have same cache key
            // because the SQL structure is identical, only parameter values differ
            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 2000 }
            }]);

            const key1 = context1.generateCacheKey();
            const key2 = context2.generateCacheKey();

            // Keys should be the same because the SQL structure is identical
            // (same operator, same fields, different parameter values don't affect cache key)
            expect(key1).toBe(key2);
        });
    });

    describe('cache behavior with custom filters', () => {
        it('should cache queries with custom filters separately', async () => {
            const sql1 = 'SELECT * FROM components_LocationComponent c WHERE ST_DWithin(...)';
            const sql2 = 'SELECT * FROM components_LocationComponent c WHERE ST_DWithin(...) AND other_condition';

            // Create contexts with different custom filters
            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.CONTAINS_POINT,
                value: { latitude: 40.7128, longitude: -74.006 }
            }]);

            const key1 = context1.generateCacheKey();
            const key2 = context2.generateCacheKey();

            // First query - cache miss
            const result1 = await cache.getOrCreate(sql1, key1, mockDb);
            expect(result1.isHit).toBe(false);

            // Second query with different custom filter - cache miss
            const result2 = await cache.getOrCreate(sql2, key2, mockDb);
            expect(result2.isHit).toBe(false);

            // Repeat first query - cache hit
            const result3 = await cache.getOrCreate(sql1, key1, mockDb);
            expect(result3.isHit).toBe(true);
        });

        it('should maintain separate cache entries for different custom operators', async () => {
            const sql = 'SELECT * FROM components_LocationComponent c WHERE custom_filter_condition';

            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.CONTAINS_POINT,
                value: { latitude: 40.7128, longitude: -74.006 }
            }]);

            const key1 = context1.generateCacheKey();
            const key2 = context2.generateCacheKey();

            // Cache both queries
            await cache.getOrCreate(sql, key1, mockDb);
            await cache.getOrCreate(sql, key2, mockDb);

            // Check cache stats
            const stats = cache.getStats();
            expect(stats.size).toBe(2);
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(2);
        });
    });

    describe('parameter handling with custom filters', () => {
        it('should handle different parameter counts for custom filters', () => {
            // within_distance uses 3 parameters, contains_point uses 2
            const context1 = new QueryContext();
            context1.componentIds.add('LocationComponent');
            context1.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.WITHIN_DISTANCE,
                value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 }
            }]);

            const context2 = new QueryContext();
            context2.componentIds.add('LocationComponent');
            context2.componentFilters.set('LocationComponent', [{
                field: 'coordinates',
                operator: SpatialFilter.CONTAINS_POINT,
                value: { latitude: 40.7128, longitude: -74.006 }
            }]);

            // Simulate parameter addition (what happens in ComponentInclusionNode)
            const mockAlias = 'c';

            // For within_distance: adds 3 params
            const result1 = mockWithinDistanceBuilder(
                { field: 'coordinates', operator: SpatialFilter.WITHIN_DISTANCE, value: { point: { latitude: 40.7128, longitude: -74.006 }, distance: 1000 } },
                mockAlias,
                context1
            );

            // For contains_point: adds 2 params
            const result2 = mockContainsPointBuilder(
                { field: 'coordinates', operator: SpatialFilter.CONTAINS_POINT, value: { latitude: 40.7128, longitude: -74.006 } },
                mockAlias,
                context2
            );

            expect(result1.addedParams).toBe(3);
            expect(result2.addedParams).toBe(2);
            expect(context1.params.length).toBe(3);
            expect(context2.params.length).toBe(2);
        });
    });
});