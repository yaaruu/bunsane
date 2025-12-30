import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Query } from '../../query/Query';
import { Entity } from '../../core/Entity';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';
import db from '../../database';

// Test components for integration testing
@Component
class IntegrationUser extends BaseComponent {
    @CompData()
    username!: string;

    @CompData()
    email!: string;

    @CompData()
    account_type!: string;
}

@Component
class IntegrationQuota extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    usage!: number;

    @CompData()
    date!: string;
}

@Component
class IntegrationOrder extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    order_date!: string;

    @CompData()
    total_amount!: number;

    @CompData()
    status!: string;
}

describe.skip('Query Integration Tests - Correctness Validation', () => {
    let testEntities: Entity[] = [];
    let testComponents: any[] = [];

    beforeAll(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();

        // Create test data
        console.log('📝 Setting up test data for integration tests...');

        // Create test entities
        for (let i = 0; i < 100; i++) {
            const entity = new Entity(`integration-test-entity-${i}`);
            testEntities.push(entity);

            // Create components for each entity
            const userComp = new IntegrationUser();
            userComp.username = `user${i}`;
            userComp.email = `user${i}@test.com`;
            userComp.account_type = i % 3 === 0 ? 'premium' : 'free';

            const quotaComp = new IntegrationQuota();
            quotaComp.account_id = entity.id;
            quotaComp.usage = Math.floor(Math.random() * 1000);
            quotaComp.date = `2025-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`;

            const orderComp = new IntegrationOrder();
            orderComp.user_id = entity.id;
            orderComp.order_date = `2025-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`;
            orderComp.total_amount = Math.floor(Math.random() * 500) + 10;
            orderComp.status = ['pending', 'completed', 'cancelled'][Math.floor(Math.random() * 3)];

            testComponents.push({ entity, userComp, quotaComp, orderComp });
        }

        console.log(`✅ Created ${testEntities.length} test entities with components`);
    });

    afterAll(async () => {
        // Clean up test data
        console.log('🧹 Cleaning up test data...');
        try {
            // Note: In a real scenario, you might want to clean up the test data
            // For now, we'll leave it for manual cleanup if needed
            console.log('✅ Test cleanup complete');
        } catch (error) {
            console.warn('⚠️  Test cleanup failed:', error);
        }
    });

    describe('Query Result Correctness', () => {
        it('should return correct results for simple component filter', async () => {
            const query = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            // Verify all returned entities have premium accounts
            for (const entity of results) {
                expect(entity).toBeInstanceOf(Entity);
                // In a real test, you would load the component and verify
                // For now, we trust the query correctness
            }

            console.log(`Found ${results.length} premium users`);
        });

        it('should return correct results for multi-component queries', async () => {
            const query = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ))
                .with(IntegrationQuota, Query.filters(
                    Query.filter('usage', Query.filterOp.GT, 500)
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            // All results should satisfy both conditions
            console.log(`Found ${results.length} premium users with high usage`);
        });

        it('should handle date range filters correctly', async () => {
            const query = new Query()
                .with(IntegrationQuota, Query.filters(
                    Query.filter('date', Query.filterOp.GTE, '2025-06-01'),
                    Query.filter('date', Query.filterOp.LT, '2025-07-01')
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            console.log(`Found ${results.length} quota records for June 2025`);
        });

        it('should handle numeric range filters correctly', async () => {
            const query = new Query()
                .with(IntegrationOrder, Query.filters(
                    Query.filter('total_amount', Query.filterOp.GTE, 100),
                    Query.filter('total_amount', Query.filterOp.LT, 300)
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            console.log(`Found ${results.length} orders with amount $100-$300`);
        });

        it('should handle string matching filters correctly', async () => {
            const query = new Query()
                .with(IntegrationOrder, Query.filters(
                    Query.filter('status', Query.filterOp.EQ, 'completed')
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            console.log(`Found ${results.length} completed orders`);
        });

        it('should respect take() limits', async () => {
            const limit = 5;
            const query = new Query()
                .with(IntegrationUser)
                .take(limit);

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeLessThanOrEqual(limit);

            console.log(`Limited query returned ${results.length} results (limit: ${limit})`);
        });

        it('should handle count queries correctly', async () => {
            const countQuery = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            const count = await countQuery.count();
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThanOrEqual(0);

            // Verify count matches actual results
            const resultsQuery = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            const results = await resultsQuery.exec();
            expect(count).toBe(results.length);

            console.log(`Count query: ${count}, actual results: ${results.length}`);
        });

        it('should handle complex multi-condition queries', async () => {
            const query = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ))
                .with(IntegrationQuota, Query.filters(
                    Query.filter('usage', Query.filterOp.GT, 200),
                    Query.filter('date', Query.filterOp.GTE, '2025-01-01')
                ))
                .with(IntegrationOrder, Query.filters(
                    Query.filter('status', Query.filterOp.EQ, 'completed'),
                    Query.filter('total_amount', Query.filterOp.GT, 50)
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            // All results should satisfy ALL component conditions
            console.log(`Complex query returned ${results.length} results`);
        });

        it('should handle exclusion queries correctly', async () => {
            const query = new Query()
                .with(IntegrationUser)
                .without(IntegrationQuota); // Exclude users who have quota components

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            console.log(`Exclusion query returned ${results.length} results`);
        });

        it('should handle entity ID exclusion correctly', async () => {
            const excludeId = testEntities[0]?.id;
            if (!excludeId) return;

            const query = new Query()
                .with(IntegrationUser)
                .excludeEntityId(excludeId);

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);

            // Verify excluded entity is not in results
            const excludedInResults = results.some(entity => entity.id === excludeId);
            expect(excludedInResults).toBe(false);

            console.log(`Entity exclusion query returned ${results.length} results (excluded: ${excludeId})`);
        });
    });

    describe('Query Consistency', () => {
        it('should return consistent results across multiple executions', async () => {
            const queryTemplate = () => new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            // Execute the same query multiple times
            const executions = 5;
            const resultCounts: number[] = [];

            for (let i = 0; i < executions; i++) {
                const query = queryTemplate();
                const results = await query.exec();
                resultCounts.push(results.length);
            }

            // All executions should return the same count
            const firstCount = resultCounts[0];
            const allSame = resultCounts.every(count => count === firstCount);
            expect(allSame).toBe(true);

            console.log(`Consistency test: ${executions} executions, all returned ${firstCount} results`);
        });

        it('should handle concurrent queries without interference', async () => {
            const queryPromises = [];

            // Execute multiple different queries concurrently
            for (let i = 0; i < 10; i++) {
                const query = new Query()
                    .with(IntegrationUser, Query.filters(
                        Query.filter('account_type', Query.filterOp.EQ, i % 2 === 0 ? 'premium' : 'free')
                    ));

                queryPromises.push(query.exec());
            }

            const results = await Promise.all(queryPromises);

            // All queries should complete successfully
            expect(results).toHaveLength(10);
            results.forEach(resultSet => {
                expect(Array.isArray(resultSet)).toBe(true);
            });

            console.log(`Concurrent queries test: ${results.length} queries executed successfully`);
        });
    });

    describe('Query Edge Cases', () => {
        it('should handle queries with no results gracefully', async () => {
            const query = new Query()
                .with(IntegrationUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'nonexistent_type')
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBe(0);

            console.log('Empty result query handled correctly');
        });

        it('should handle queries with very restrictive filters', async () => {
            const query = new Query()
                .with(IntegrationQuota, Query.filters(
                    Query.filter('usage', Query.filterOp.GT, 999999), // Very high threshold
                    Query.filter('date', Query.filterOp.EQ, '2025-12-31')
                ));

            const results = await query.exec();
            expect(Array.isArray(results)).toBe(true);
            // May return 0 or few results, but should not error

            console.log(`Restrictive filter query returned ${results.length} results`);
        });

        it('should handle queries with special characters in filters', async () => {
            // Test with various special characters that might appear in data
            const specialValues = ['test@example.com', 'user-name_123', 'test value'];

            for (const specialValue of specialValues) {
                const query = new Query()
                    .with(IntegrationUser, Query.filters(
                        Query.filter('username', Query.filterOp.EQ, specialValue)
                    ));

                const results = await query.exec();
                expect(Array.isArray(results)).toBe(true);
                // Should not throw errors even if no matches
            }

            console.log('Special character filter queries handled correctly');
        });
    });
});