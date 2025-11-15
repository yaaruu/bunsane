import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';

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

describe('Query Performance Benchmarks', () => {
    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();
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
                .excludeEntityId('excluded-entity-id')
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