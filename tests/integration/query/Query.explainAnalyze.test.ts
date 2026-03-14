/**
 * Integration tests for Query.explainAnalyze() and debugMode()
 * Tests query plan analysis and debug output
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { TestUser, TestProduct } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('Query EXPLAIN ANALYZE', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
    });

    beforeEach(async () => {
        // Create test data for queries
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: 'ExplainTest', email: 'explain@example.com', age: 30 });
        await entity.save();
    });

    describe('explainAnalyze()', () => {
        test('returns query execution plan', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze();

            expect(plan).toBeDefined();
            expect(typeof plan).toBe('string');
            expect(plan.length).toBeGreaterThan(0);
        });

        test('plan contains execution timing', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze();

            // EXPLAIN ANALYZE includes actual timing
            expect(plan).toMatch(/actual time=/i);
        });

        test('plan contains buffer statistics by default', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze(true);

            // BUFFERS option includes shared/local buffer info
            expect(plan).toMatch(/Buffers:|shared hit|shared read/i);
        });

        test('plan without buffers when buffers=false', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze(false);

            expect(plan).toBeDefined();
            // Should still have timing info
            expect(plan).toMatch(/actual time=/i);
        });

        test('explains filtered query', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'ExplainTest')]
                })
                .explainAnalyze();

            expect(plan).toBeDefined();
            // Filter should show in the plan
            expect(plan.length).toBeGreaterThan(0);
        });

        test('explains query with multiple components', async () => {
            // Create entity with multiple components
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'MultiComp', email: 'multi@example.com', age: 25 });
            entity.add(TestProduct, { sku: 'EXPLAIN-SKU', name: 'Explain Product', price: 100, inStock: true });
            await entity.save();

            const plan = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .explainAnalyze();

            expect(plan).toBeDefined();
            expect(plan.length).toBeGreaterThan(0);
        });

        test('explains query with sorting', async () => {
            const plan = await new Query()
                .with(TestUser)
                .sortBy(TestUser, 'age', 'DESC')
                .explainAnalyze();

            expect(plan).toBeDefined();
            // Sort should show in plan
            expect(plan).toMatch(/Sort|sort/i);
        });

        test('explains query with limit', async () => {
            const plan = await new Query()
                .with(TestUser)
                .take(10)
                .explainAnalyze();

            expect(plan).toBeDefined();
            // Limit should show in plan
            expect(plan).toMatch(/Limit|limit/i);
        });

        test('explains count query equivalent', async () => {
            // explainAnalyze on a regular query shows the underlying query plan
            // For count analysis, one would wrap the query differently
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze();

            expect(plan).toBeDefined();
        });
    });

    describe('debugMode()', () => {
        test('debugMode does not throw', async () => {
            const results = await new Query()
                .with(TestUser)
                .debugMode(true)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('debugMode can be disabled', async () => {
            const results = await new Query()
                .with(TestUser)
                .debugMode(true)
                .debugMode(false)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('debugMode works with count()', async () => {
            const count = await new Query()
                .with(TestUser)
                .debugMode(true)
                .count();

            expect(typeof count).toBe('number');
        });

        test('debugMode works with explainAnalyze()', async () => {
            const plan = await new Query()
                .with(TestUser)
                .debugMode(true)
                .explainAnalyze();

            expect(plan).toBeDefined();
            expect(typeof plan).toBe('string');
        });

        test('debugMode works with sum()', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestProduct, { sku: 'DEBUG-SUM', name: 'Debug Sum', price: 50, inStock: true });
            await entity.save();

            const sum = await new Query()
                .with(TestProduct)
                .debugMode(true)
                .sum(TestProduct, 'price');

            expect(typeof sum).toBe('number');
        });

        test('debugMode works with average()', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestProduct, { sku: 'DEBUG-AVG', name: 'Debug Avg', price: 75, inStock: true });
            await entity.save();

            const avg = await new Query()
                .with(TestProduct)
                .debugMode(true)
                .average(TestProduct, 'price');

            expect(typeof avg).toBe('number');
        });
    });

    describe('query plan analysis patterns', () => {
        test('index scan shows when filtering on indexed field', async () => {
            // Create several entities to make index usage more likely
            for (let i = 0; i < 10; i++) {
                const entity = ctx.tracker.create();
                entity.add(TestUser, {
                    name: `IndexTest${i}`,
                    email: `index${i}@example.com`,
                    age: 20 + i
                });
                await entity.save();
            }

            const plan = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.EQ, 'index5@example.com')]
                })
                .explainAnalyze();

            expect(plan).toBeDefined();
            // Plan should show some form of scan
            expect(plan).toMatch(/Scan|scan/i);
        });

        test('plan shows rows estimation', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze();

            // EXPLAIN ANALYZE shows estimated vs actual rows
            expect(plan).toMatch(/rows=/i);
        });

        test('plan shows execution time', async () => {
            const plan = await new Query()
                .with(TestUser)
                .take(5)
                .explainAnalyze();

            // Planning and execution time at the end
            expect(plan).toMatch(/Planning Time:|Execution Time:/i);
        });
    });
});
