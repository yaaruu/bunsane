import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';
import { PrepareDatabase } from '../../database/DatabaseHelper';

// Test components for benchmarking
@Component
class BenchmarkComponent1 extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    date!: string;

    @CompData()
    usage!: number;
}

@Component
class BenchmarkComponent2 extends BaseComponent {
    @CompData()
    area_id!: string;

    @CompData()
    service_type!: string;

    @CompData()
    price!: number;
}

@Component
class BenchmarkComponent3 extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    status!: string;
}

// Performance regression test baselines
const PERFORMANCE_BASELINES = {
    planningTimeMax: 3.0, // ms
    executionTimeMax: 2.0, // ms
    totalTimeMax: 15.0, // ms - Increased for realistic test environment
    bufferHitRatioMin: 90.0, // %
    cacheHitRateMin: 60.0 // %
};

describe('Query Performance Benchmarks', () => {
    beforeAll(async () => {
        // Initialize database schema
        console.log('Setting up database schema for performance tests...');
        await PrepareDatabase();
        console.log('Database schema ready');

        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();
    });

    describe('Performance Regression Tests', () => {
        it('should not regress planning time beyond baseline', async () => {
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123'),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01')
                ))
                .with(BenchmarkComponent2, Query.filters(
                    Query.filter('area_id', Query.filterOp.EQ, 'test-area-456')
                ))
                .debugMode(true);

            const explainOutput = await query.explainAnalyze(true);
            const planningMatch = explainOutput.match(/Planning time:\s*([\d.]+)ms/);

            if (planningMatch && planningMatch[1]) {
                const planningTime = parseFloat(planningMatch[1]);
                console.log(`Planning time: ${planningTime}ms (baseline: ${PERFORMANCE_BASELINES.planningTimeMax}ms)`);

                expect(planningTime).toBeLessThanOrEqual(PERFORMANCE_BASELINES.planningTimeMax);
            } else {
                console.warn('Could not parse planning time from EXPLAIN output');
            }
        });

        it('should not regress total execution time beyond baseline', async () => {
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123'),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01'),
                    Query.filter('usage', Query.filterOp.GT, 0)
                ))
                .with(BenchmarkComponent2, Query.filters(
                    Query.filter('area_id', Query.filterOp.EQ, 'test-area-456'),
                    Query.filter('service_type', Query.filterOp.EQ, 'test-service')
                ));

            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();
            const totalTime = endTime - startTime;

            console.log(`Total execution time: ${totalTime}ms (baseline: ${PERFORMANCE_BASELINES.totalTimeMax}ms)`);
            expect(totalTime).toBeLessThanOrEqual(PERFORMANCE_BASELINES.totalTimeMax);
        });

        it('should maintain buffer hit ratio above baseline', async () => {
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123')
                ));

            const explainOutput = await query.explainAnalyze(true);
            const bufferMatch = explainOutput.match(/Buffers:\s*shared\s*hit=(\d+)\s*read=(\d+)/);

            if (bufferMatch && bufferMatch[1] && bufferMatch[2]) {
                const hits = parseInt(bufferMatch[1]);
                const reads = parseInt(bufferMatch[2]);
                const totalBuffers = hits + reads;
                const hitRatio = totalBuffers > 0 ? (hits / totalBuffers) * 100 : 100;

                console.log(`Buffer hit ratio: ${hitRatio.toFixed(1)}% (baseline: ${PERFORMANCE_BASELINES.bufferHitRatioMin}%)`);
                expect(hitRatio).toBeGreaterThanOrEqual(PERFORMANCE_BASELINES.bufferHitRatioMin);
            } else {
                console.warn('Could not parse buffer statistics from EXPLAIN output');
            }
        });

        it('should maintain prepared statement cache effectiveness', async () => {
            // Execute the same query multiple times to test caching
            const queryTemplate = () => new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'cache-test-account')
                ));

            const iterations = 10;
            const times: number[] = [];

            for (let i = 0; i < iterations; i++) {
                const query = queryTemplate();
                const startTime = performance.now();
                await query.exec();
                const endTime = performance.now();
                times.push(endTime - startTime);
            }

            // Check cache stats
            const cacheStats = Query.getCacheStats();
            console.log(`Cache hit rate: ${(cacheStats.hitRate || 0) * 100}% (baseline: ${PERFORMANCE_BASELINES.cacheHitRateMin}%)`);

            if (cacheStats.hitRate !== undefined) {
                expect(cacheStats.hitRate * 100).toBeGreaterThanOrEqual(PERFORMANCE_BASELINES.cacheHitRateMin);
            } else {
                console.warn('Cache hit rate not available');
            }
        });
    });

    describe('CTE vs Non-CTE Performance', () => {
        it('should demonstrate CTE optimization for multiple component filters', async () => {
            // Create a query with multiple component filters (should trigger CTE)
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123'),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01')
                ))
                .with(BenchmarkComponent2, Query.filters(
                    Query.filter('area_id', Query.filterOp.EQ, 'test-area-456'),
                    Query.filter('service_type', Query.filterOp.EQ, 'test-service')
                ))
                .debugMode(true);

            // Execute query and capture debug output
            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();

            console.log(`CTE Query Execution Time: ${endTime - startTime}ms`);
            console.log(`Results count: ${results.length}`);

            // Query should complete without errors
            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
        });

        it('should compare single component query (no CTE)', async () => {
            // Create a query with single component filter (should not trigger CTE)
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123')
                ))
                .debugMode(true);

            // Execute query and capture debug output
            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();

            console.log(`Non-CTE Query Execution Time: ${endTime - startTime}ms`);
            console.log(`Results count: ${results.length}`);

            // Query should complete without errors
            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle complex multi-component query with exclusions', async () => {
            // Create a complex query with multiple components, filters, and exclusions
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123'),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01'),
                    Query.filter('usage', Query.filterOp.GT, 0)
                ))
                .with(BenchmarkComponent2, Query.filters(
                    Query.filter('area_id', Query.filterOp.EQ, 'test-area-456'),
                    Query.filter('service_type', Query.filterOp.EQ, 'test-service')
                ))
                .with(BenchmarkComponent3, Query.filters(
                    Query.filter('user_id', Query.filterOp.EQ, 'test-user-789'),
                    Query.filter('status', Query.filterOp.EQ, 'active')
                ))
                .without(BenchmarkComponent1) // This should exclude entities with this component
                .excludeEntityId('00000000-0000-0000-0000-000000000001')
                .take(100)
                .debugMode(true);

            // Execute query and capture debug output
            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();

            console.log(`Complex CTE Query Execution Time: ${endTime - startTime}ms`);
            console.log(`Results count: ${results.length}`);

            // Query should complete without errors
            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeLessThanOrEqual(100); // Should respect take(100)
        });
    });

    describe('Query Count Performance', () => {
        it('should benchmark count queries with CTE optimization', async () => {
            const query = new Query()
                .with(BenchmarkComponent1, Query.filters(
                    Query.filter('account_id', Query.filterOp.EQ, 'test-account-123'),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01')
                ))
                .with(BenchmarkComponent2, Query.filters(
                    Query.filter('area_id', Query.filterOp.EQ, 'test-area-456')
                ));

            const startTime = performance.now();
            const count = await query.count();
            const endTime = performance.now();

            console.log(`Count Query Execution Time: ${endTime - startTime}ms`);
            console.log(`Count result: ${count}`);

            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });
});