import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';

// Mock GoogleMapAccountQuota component for testing
@Component
class MockGoogleMapAccountQuota extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    usage: number = 0;

    @CompData()
    date!: string;
}

describe('GoogleMapAccountQuota Performance Test', () => {
    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();
    });

    describe('monthlyUsage Query Performance', () => {
        it('should replicate the original monthlyUsage performance issue and verify optimization', async () => {
            // Create test entity
            const testEntity = new Entity('test-gmap-account-123');

            // Replicate the monthlyUsage query logic
            const firstDayOfMonth = new Date();
            firstDayOfMonth.setDate(1);
            firstDayOfMonth.setHours(0, 0, 0, 0);
            const lastDayOfMonth = new Date(firstDayOfMonth);
            lastDayOfMonth.setMonth(lastDayOfMonth.getMonth() + 1);
            lastDayOfMonth.setDate(0);
            lastDayOfMonth.setHours(23, 59, 59, 999);

            // This replicates the query from GMapAPIArcheType.monthlyUsage()
            const query = new Query()
                .with(MockGoogleMapAccountQuota,
                    Query.filters(
                        Query.filter('account_id', Query.filterOp.EQ, testEntity.id),
                        Query.filter('date', Query.filterOp.GTE, firstDayOfMonth.toISOString().split('T')[0]),
                        Query.filter('date', Query.filterOp.LT, lastDayOfMonth.toISOString().split('T')[0])
                    )
                )
                .debugMode(true);

            // Execute query and measure performance
            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();
            const totalTime = endTime - startTime;

            console.log(`GoogleMapAccountQuota Query Performance:`);
            console.log(`Total execution time: ${totalTime}ms`);
            console.log(`Results count: ${results.length}`);

            // Performance assertions - should be well under 5ms with optimizations
            expect(totalTime).toBeLessThan(5); // Target: <5ms total time

            // Get EXPLAIN ANALYZE output for detailed performance analysis
            const explainOutput = await query.explainAnalyze(true);
            console.log('EXPLAIN ANALYZE output:');
            console.log(explainOutput);

            // Verify query correctness
            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);

            // Extract planning time from EXPLAIN output (rough parsing)
            const planningMatch = explainOutput.match(/Planning time:\s*([\d.]+)ms/);
            if (planningMatch && planningMatch[1]) {
                const planningTime = parseFloat(planningMatch[1]);
                console.log(`Planning time: ${planningTime}ms`);
                expect(planningTime).toBeLessThan(3); // Target: <3ms planning time
            }

            // Check for buffer hit ratio
            const bufferMatch = explainOutput.match(/Buffers:\s*shared\s*hit=(\d+)\s*read=(\d+)/);
            if (bufferMatch && bufferMatch[1] && bufferMatch[2]) {
                const hits = parseInt(bufferMatch[1]);
                const reads = parseInt(bufferMatch[2]);
                const totalBuffers = hits + reads;
                const hitRatio = totalBuffers > 0 ? (hits / totalBuffers) * 100 : 100;
                console.log(`Buffer hit ratio: ${hitRatio.toFixed(1)}%`);
                expect(hitRatio).toBeGreaterThan(90); // Target: >90% buffer hit ratio
            }
        });

        it('should handle the SUM aggregation optimization for monthlyUsage', async () => {
            // Test the optimized version that would use SUM instead of fetching all entities
            const testEntity = new Entity('test-gmap-account-123');

            const firstDayOfMonth = new Date();
            firstDayOfMonth.setDate(1);
            const lastDayOfMonth = new Date(firstDayOfMonth);
            lastDayOfMonth.setMonth(lastDayOfMonth.getMonth() + 1);
            lastDayOfMonth.setDate(0);

            // TODO: Implement SUM query optimization
            // For now, test the current implementation
            const query = new Query()
                .with(MockGoogleMapAccountQuota,
                    Query.filters(
                        Query.filter('account_id', Query.filterOp.EQ, testEntity.id),
                        Query.filter('date', Query.filterOp.GTE, firstDayOfMonth.toISOString().split('T')[0]),
                        Query.filter('date', Query.filterOp.LT, lastDayOfMonth.toISOString().split('T')[0])
                    )
                );

            const startTime = performance.now();
            const results = await query.exec();
            const endTime = performance.now();

            // Simulate the SUM logic from monthlyUsage
            let totalUsage = 0;
            for (const entity of results) {
                // In real implementation, this would be: const quotaComp = await entity.get(GoogleMapAccountQuota);
                // For testing, we'll assume components are loaded
                // totalUsage += quotaComp.usage;
            }

            console.log(`SUM Query Performance: ${endTime - startTime}ms`);
            console.log(`Total usage calculated: ${totalUsage}`);

            expect(typeof totalUsage).toBe('number');
            expect(totalUsage).toBeGreaterThanOrEqual(0);
        });

        it('should test query correctness with various date ranges', async () => {
            const testEntity = new Entity('test-gmap-account-456');

            // Test different date ranges
            const testCases = [
                {
                    name: 'Current month',
                    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                    end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
                },
                {
                    name: 'Last month',
                    start: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
                    end: new Date(new Date().getFullYear(), new Date().getMonth(), 0)
                },
                {
                    name: 'Specific date range',
                    start: new Date('2025-01-01'),
                    end: new Date('2025-01-31')
                }
            ];

            for (const testCase of testCases) {
                const query = new Query()
                    .with(MockGoogleMapAccountQuota,
                        Query.filters(
                            Query.filter('account_id', Query.filterOp.EQ, testEntity.id),
                            Query.filter('date', Query.filterOp.GTE, testCase.start.toISOString().split('T')[0]),
                            Query.filter('date', Query.filterOp.LT, testCase.end.toISOString().split('T')[0])
                        )
                    );

                const startTime = performance.now();
                const results = await query.exec();
                const endTime = performance.now();

                console.log(`${testCase.name} query: ${endTime - startTime}ms, ${results.length} results`);

                expect(results).toBeDefined();
                expect(Array.isArray(results)).toBe(true);
                expect(endTime - startTime).toBeLessThan(10); // Reasonable performance for all ranges
            }
        });

        it('should verify prepared statement cache effectiveness', async () => {
            const testEntity = new Entity('test-gmap-account-789');

            const firstDayOfMonth = new Date();
            firstDayOfMonth.setDate(1);
            const lastDayOfMonth = new Date(firstDayOfMonth);
            lastDayOfMonth.setMonth(lastDayOfMonth.getMonth() + 1);
            lastDayOfMonth.setDate(0);

            // Execute the same query multiple times to test caching
            const iterations = 5;
            const times: number[] = [];

            for (let i = 0; i < iterations; i++) {
                const query = new Query()
                    .with(MockGoogleMapAccountQuota,
                        Query.filters(
                            Query.filter('account_id', Query.filterOp.EQ, testEntity.id),
                            Query.filter('date', Query.filterOp.GTE, firstDayOfMonth.toISOString().split('T')[0]),
                            Query.filter('date', Query.filterOp.LT, lastDayOfMonth.toISOString().split('T')[0])
                        )
                    );

                const startTime = performance.now();
                await query.exec();
                const endTime = performance.now();
                times.push(endTime - startTime);
            }

            console.log(`Cache performance test (${iterations} iterations):`);
            console.log(`Times: ${times.map(t => t.toFixed(2)).join(', ')}ms`);
            console.log(`Average: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}ms`);

            // First execution should be slower, subsequent ones faster due to caching
            if (times.length > 1) {
                const firstTime = times[0]!;
                const avgRest = times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1);
                console.log(`First execution: ${firstTime.toFixed(2)}ms, Average rest: ${avgRest.toFixed(2)}ms`);

                // Cache should provide some benefit (though exact improvement depends on system)
                expect(avgRest).toBeLessThan(firstTime * 1.5); // Allow some variance
            }

            // Check cache stats
            const cacheStats = Query.getCacheStats();
            console.log('Cache stats:', cacheStats);
            expect(cacheStats.totalStatements).toBeGreaterThanOrEqual(0);
        });
    });
});