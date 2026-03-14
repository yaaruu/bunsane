/**
 * Edge case tests for Query SQL generation
 * These tests verify that various edge cases don't produce invalid SQL
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { Query, FilterOp } from '../../../query/Query';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('Query Edge Cases', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('IN/NOT IN operator edge cases', () => {
        beforeEach(async () => {
            // Create test data
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'InTest', email: 'in@test.com', age: 25 });
            await entity.save();
        });

        test('IN with single element array works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.IN, ['InTest'])]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('IN with multiple elements works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.IN, ['InTest', 'Other', 'Another'])]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('IN with empty array returns no results (not SQL error)', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.IN, [])]
                })
                .exec();

            // Empty IN should return no results, not throw SQL error
            expect(results.length).toBe(0);
        });

        test('NOT IN with empty array returns all results (not SQL error)', async () => {
            const allResults = await new Query()
                .with(TestUser)
                .exec();

            const notInResults = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.NOT_IN, [])]
                })
                .exec();

            // Empty NOT IN should return all results (nothing excluded)
            expect(notInResults.length).toBe(allResults.length);
        });

        test('NOT IN with single element works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.NOT_IN, ['InTest'])]
                })
                .exec();

            // Should not include 'InTest'
            const hasInTest = results.some(e => e.getInMemory(TestUser)?.name === 'InTest');
            expect(hasInTest).toBe(false);
        });

        test('IN combined with other filters works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [
                        Query.filter('name', FilterOp.IN, ['InTest', 'Other']),
                        Query.filter('age', FilterOp.GTE, 18)
                    ]
                })
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Multi-component query edge cases', () => {
        beforeEach(async () => {
            // Create entity with multiple components
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'MultiComp', email: 'multi@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'MULTI-SKU', name: 'Multi Product', price: 100, inStock: true });
            await entity.save();

            // Create entity with only user
            const userOnly = ctx.tracker.create();
            userOnly.add(TestUser, { name: 'UserOnly', email: 'useronly@test.com', age: 25 });
            await userOnly.save();
        });

        test('two components with no filters works', async () => {
            const results = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('two components with filter on first works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'MultiComp')]
                })
                .with(TestProduct)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('two components with filter on second works', async () => {
            const results = await new Query()
                .with(TestUser)
                .with(TestProduct, {
                    filters: [Query.filter('sku', FilterOp.EQ, 'MULTI-SKU')]
                })
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('two components with filters on both works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'MultiComp')]
                })
                .with(TestProduct, {
                    filters: [Query.filter('price', FilterOp.GTE, 50)]
                })
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('three components with mixed filters works', async () => {
            // Add order to existing entity
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'TripleComp', email: 'triple@test.com', age: 35 });
            entity.add(TestProduct, { sku: 'TRIPLE-SKU', name: 'Triple Product', price: 200, inStock: true });
            entity.add(TestOrder, { orderNumber: 'ORD-TRIPLE', status: 'pending', total: 200 });
            await entity.save();

            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GTE, 18)]
                })
                .with(TestProduct)
                .with(TestOrder, {
                    filters: [Query.filter('status', FilterOp.EQ, 'pending')]
                })
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Sorting edge cases', () => {
        beforeEach(async () => {
            // Create entities with various ages
            for (const age of [20, 30, 40]) {
                const entity = ctx.tracker.create();
                entity.add(TestUser, {
                    name: `SortEdge${age}`,
                    email: `sortedge${age}@test.com`,
                    age
                });
                await entity.save();
            }
        });

        test('sort with no filters works', async () => {
            const results = await new Query()
                .with(TestUser)
                .sortBy(TestUser, 'age', 'ASC')
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('sort with filter on same component works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, 'sortedge%')]
                })
                .sortBy(TestUser, 'age', 'DESC')
                .populate()
                .exec();

            expect(Array.isArray(results)).toBe(true);
            // Verify sort order
            for (let i = 1; i < results.length; i++) {
                const prevAge = results[i - 1]!.getInMemory(TestUser)?.age ?? 0;
                const currAge = results[i]!.getInMemory(TestUser)?.age ?? 0;
                expect(currAge).toBeLessThanOrEqual(prevAge);
            }
        });

        test('sort on component different from filter works', async () => {
            // Create entity with both components
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'SortDiffComp', email: 'sortdiff@test.com', age: 50 });
            entity.add(TestProduct, { sku: 'SORT-DIFF', name: 'Sort Product', price: 75, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .with(TestProduct, {
                    filters: [Query.filter('price', FilterOp.GTE, 50)]
                })
                .sortBy(TestUser, 'age', 'ASC')
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('multi-component query with sort works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'MultiSort', email: 'multisort@test.com', age: 28 });
            entity.add(TestProduct, { sku: 'MULTI-SORT', name: 'MultiSort Product', price: 150, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .sortBy(TestProduct, 'price', 'DESC')
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Exclusion edge cases', () => {
        test('without() with no matching entities works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'WithoutTest', email: 'without@test.com', age: 22 });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .without(TestOrder) // This entity doesn't have TestOrder
                .exec();

            expect(results.some(e => e.id === entity.id)).toBe(true);
        });

        test('excludeEntityId with non-existent ID works', async () => {
            const results = await new Query()
                .with(TestUser)
                .excludeEntityId('00000000-0000-0000-0000-000000000000')
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('multiple excludeEntityId calls work', async () => {
            const entity1 = ctx.tracker.create();
            entity1.add(TestUser, { name: 'Exclude1', email: 'exclude1@test.com', age: 30 });
            await entity1.save();

            const entity2 = ctx.tracker.create();
            entity2.add(TestUser, { name: 'Exclude2', email: 'exclude2@test.com', age: 31 });
            await entity2.save();

            const results = await new Query()
                .with(TestUser)
                .excludeEntityId(entity1.id)
                .excludeEntityId(entity2.id)
                .exec();

            expect(results.some(e => e.id === entity1.id)).toBe(false);
            expect(results.some(e => e.id === entity2.id)).toBe(false);
        });

        test('without() combined with filters works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GTE, 18)]
                })
                .without(TestProduct)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Pagination edge cases', () => {
        test('limit 0 returns empty array', async () => {
            const results = await new Query()
                .with(TestUser)
                .take(0)
                .exec();

            expect(results.length).toBe(0);
        });

        test('offset larger than result set returns empty', async () => {
            const count = await new Query().with(TestUser).count();

            const results = await new Query()
                .with(TestUser)
                .offset(count + 100)
                .take(10)
                .exec();

            expect(results.length).toBe(0);
        });

        test('pagination with filters works', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GTE, 18)]
                })
                .take(5)
                .offset(0)
                .exec();

            expect(results.length).toBeLessThanOrEqual(5);
        });

        test('pagination with sort works', async () => {
            const results = await new Query()
                .with(TestUser)
                .sortBy(TestUser, 'age', 'ASC')
                .take(5)
                .offset(0)
                .exec();

            expect(results.length).toBeLessThanOrEqual(5);
        });

        test('pagination with multi-component query works', async () => {
            const results = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .take(5)
                .offset(0)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Boolean filter edge cases', () => {
        beforeEach(async () => {
            const inStock = ctx.tracker.create();
            inStock.add(TestProduct, { sku: 'BOOL-IN', name: 'In Stock', price: 50, inStock: true });
            await inStock.save();

            const outOfStock = ctx.tracker.create();
            outOfStock.add(TestProduct, { sku: 'BOOL-OUT', name: 'Out of Stock', price: 50, inStock: false });
            await outOfStock.save();
        });

        test('boolean true filter works', async () => {
            const results = await new Query()
                .with(TestProduct, {
                    filters: [Query.filter('inStock', FilterOp.EQ, true)]
                })
                .populate()
                .exec();

            for (const entity of results) {
                const product = entity.getInMemory(TestProduct);
                if (product) {
                    expect(product.inStock).toBe(true);
                }
            }
        });

        test('boolean false filter works', async () => {
            const results = await new Query()
                .with(TestProduct, {
                    filters: [Query.filter('inStock', FilterOp.EQ, false)]
                })
                .populate()
                .exec();

            for (const entity of results) {
                const product = entity.getInMemory(TestProduct);
                if (product) {
                    expect(product.inStock).toBe(false);
                }
            }
        });
    });

    describe('Numeric filter edge cases', () => {
        test('zero value filter works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestProduct, { sku: 'ZERO-PRICE', name: 'Free Product', price: 0, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestProduct, {
                    filters: [Query.filter('price', FilterOp.EQ, 0)]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('negative value filter works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'NegAge', email: 'neg@test.com', age: -1 });
            await entity.save();

            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.LT, 0)]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('large number filter works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestProduct, { sku: 'LARGE-PRICE', name: 'Expensive', price: 999999999, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestProduct, {
                    filters: [Query.filter('price', FilterOp.GTE, 999999999)]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('String filter edge cases', () => {
        test('LIKE with special characters works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Test%User', email: 'special@test.com', age: 25 });
            await entity.save();

            // Note: % in LIKE is a wildcard, so this tests the pattern matching
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, '%special@test.com')]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('ILIKE case-insensitive filter works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'CaseTest', email: 'UPPERCASE@TEST.COM', age: 25 });
            await entity.save();

            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.ILIKE, '%uppercase@test.com%')]
                })
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Bug reproduction: 2 components, 1 filter, LATERAL joins', () => {
        // This is the exact pattern from the bug report:
        // new Query().with(UserTag).with(PhoneComponent, Query.filters(...)).take(1).exec()

        test('exact bug pattern: 2 components, filter on second, take(1)', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'BugRepro', email: 'bug@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'BUG-SKU', name: 'Bug Product', price: 100, inStock: true });
            await entity.save();

            // This is the exact failing pattern
            const results = await new Query()
                .with(TestUser)
                .with(TestProduct, {
                    filters: [Query.filter('sku', FilterOp.EQ, 'BUG-SKU')]
                })
                .take(1)
                .exec();

            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeLessThanOrEqual(1);
        });

        test('verify SQL is valid for bug pattern', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'SQLVerify', email: 'sql@test.com', age: 25 });
            entity.add(TestProduct, { sku: 'SQL-SKU', name: 'SQL Product', price: 50, inStock: true });
            await entity.save();

            // Should not throw SQL syntax error
            const results = await new Query()
                .with(TestUser)
                .with(TestProduct, {
                    filters: [Query.filter('name', FilterOp.LIKE, '%SQL%')]
                })
                .take(10)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Combined complex queries', () => {
        test('all features combined works', async () => {
            // Create test data
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'ComplexTest', email: 'complex@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'COMPLEX-SKU', name: 'Complex Product', price: 100, inStock: true });
            await entity.save();

            // Query with everything
            const results = await new Query()
                .with(TestUser, {
                    filters: [
                        Query.filter('age', FilterOp.GTE, 18),
                        Query.filter('name', FilterOp.LIKE, 'Complex%')
                    ]
                })
                .with(TestProduct, {
                    filters: [Query.filter('inStock', FilterOp.EQ, true)]
                })
                .without(TestOrder)
                .sortBy(TestUser, 'age', 'DESC')
                .take(10)
                .offset(0)
                .populate()
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('multi-component with IN filter and sort works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'InSortTest', email: 'insort@test.com', age: 35 });
            entity.add(TestProduct, { sku: 'IN-SORT-SKU', name: 'InSort Product', price: 75, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.IN, ['InSortTest', 'Other'])]
                })
                .with(TestProduct)
                .sortBy(TestProduct, 'price', 'ASC')
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });

        test('filters on all components with pagination works', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'AllFilters', email: 'allfilters@test.com', age: 40 });
            entity.add(TestProduct, { sku: 'ALL-FILTERS', name: 'All Filters Product', price: 200, inStock: true });
            entity.add(TestOrder, { orderNumber: 'ORD-ALL', status: 'completed', total: 200 });
            await entity.save();

            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GTE, 30)]
                })
                .with(TestProduct, {
                    filters: [Query.filter('price', FilterOp.GTE, 100)]
                })
                .with(TestOrder, {
                    filters: [Query.filter('status', FilterOp.EQ, 'completed')]
                })
                .take(5)
                .offset(0)
                .exec();

            expect(Array.isArray(results)).toBe(true);
        });
    });
});
