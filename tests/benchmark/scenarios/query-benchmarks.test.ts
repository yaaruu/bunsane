/**
 * Query Performance Benchmarks
 *
 * Tests query performance against pre-generated benchmark databases.
 * Uses BENCHMARK_TIER env var to select database tier.
 *
 * Run:
 *   BENCHMARK_TIER=xs bun test tests/benchmark/scenarios/query-benchmarks.test.ts
 *   bun run bench:run:xs
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { BenchUser, BenchProduct, BenchOrder, BenchOrderItem, BenchReview } from '../fixtures/EcommerceComponents';
import { Query, FilterOp } from '../../../query/Query';
import { BenchmarkRunner, type BenchmarkResult } from '../../stress/BenchmarkRunner';
import { ComponentRegistry } from '../../../core/components';
import { getMetadataStorage } from '../../../core/metadata';

// Generate type_id same way as framework
function generateTypeId(name: string): string {
    return createHash('sha256').update(name).digest('hex');
}

// Tier is set by run-benchmarks.ts wrapper
const tier = process.env.BENCHMARK_TIER || 'xs';
let runner: BenchmarkRunner;
const results: BenchmarkResult[] = [];

beforeAll(async () => {
    runner = new BenchmarkRunner();

    // Debug: verify environment
    console.log(`[DEBUG] POSTGRES_HOST: ${process.env.POSTGRES_HOST}`);
    console.log(`[DEBUG] POSTGRES_PORT: ${process.env.POSTGRES_PORT}`);
    console.log(`[DEBUG] USE_PGLITE: ${process.env.USE_PGLITE}`);
    console.log(`[DEBUG] BUNSANE_USE_DIRECT_PARTITION: ${process.env.BUNSANE_USE_DIRECT_PARTITION}`);

    // Manually register components without triggering partition table creation
    // ComponentRegistry is already the singleton instance (exported as default)
    const registry = ComponentRegistry as any;  // Access private members
    const storage = getMetadataStorage();

    const components = [
        { name: 'BenchUser', ctor: BenchUser },
        { name: 'BenchProduct', ctor: BenchProduct },
        { name: 'BenchOrder', ctor: BenchOrder },
        { name: 'BenchOrderItem', ctor: BenchOrderItem },
        { name: 'BenchReview', ctor: BenchReview },
    ];

    for (const { name, ctor } of components) {
        const typeId = generateTypeId(name);
        // Register in ComponentRegistry's internal maps
        registry.componentsMap.set(name, typeId);
        registry.typeIdToName.set(typeId, name);
        registry.typeIdToCtor.set(typeId, ctor);
        // Also register in metadata storage
        storage.getComponentId(name);
    }

    console.log(`\n=== Query Benchmarks [${tier.toUpperCase()}] ===\n`);
});

afterAll(async () => {
    // Print summary
    console.log('\n=== Benchmark Summary ===');
    const summary = runner.getSummary();
    console.log(`Passed: ${summary.passed}/${summary.total}`);

    if (results.length > 0) {
        console.log('\nDetailed Results:');
        for (const r of results) {
            const status = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
            console.log(`  ${status} ${r.name.padEnd(40)} p95=${r.timings.p95.toFixed(1).padStart(8)}ms  rows=${String(r.rowsReturned).padStart(6)}`);
        }
    }
});

describe(`Query Benchmarks [${tier.toUpperCase()}]`, () => {
    describe('Single Component Queries', () => {
        test('indexed field filter (user by status)', async () => {
            const result = await runner.run(
                'indexed-filter-status',
                async () => {
                    return await new Query()
                        .with(BenchUser, {
                            filters: [Query.filter('status', FilterOp.EQ, 'active')]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('indexed field filter (product by category)', async () => {
            const result = await runner.run(
                'indexed-filter-category',
                async () => {
                    return await new Query()
                        .with(BenchProduct, {
                            filters: [Query.filter('category', FilterOp.EQ, 'Electronics')]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('numeric range filter (product by price)', async () => {
            const result = await runner.run(
                'numeric-range-price',
                async () => {
                    return await new Query()
                        .with(BenchProduct, {
                            filters: [
                                Query.filter('price', FilterOp.GTE, 50),
                                Query.filter('price', FilterOp.LTE, 200)
                            ]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('sorting with pagination (products by rating DESC)', async () => {
            const result = await runner.run(
                'sort-rating-desc',
                async () => {
                    return await new Query()
                        .with(BenchProduct)
                        .sortBy(BenchProduct, 'rating', 'DESC')
                        .take(50)
                        .offset(100)
                        .exec();
                },
                { iterations: 20, targetP95: 150 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });

    describe('Multi-Component Queries', () => {
        test('two components (order + order item)', async () => {
            const result = await runner.run(
                'multi-2-components',
                async () => {
                    return await new Query()
                        .with(BenchOrder, {
                            filters: [Query.filter('status', FilterOp.EQ, 'delivered')]
                        })
                        .with(BenchOrderItem)
                        .take(50)
                        .exec();
                },
                { iterations: 15, targetP95: 200 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('three components (user + order + item)', async () => {
            const result = await runner.run(
                'multi-3-components',
                async () => {
                    return await new Query()
                        .with(BenchUser, {
                            filters: [Query.filter('tier', FilterOp.EQ, 'premium')]
                        })
                        .with(BenchOrder)
                        .with(BenchOrderItem)
                        .take(50)
                        .exec();
                },
                { iterations: 15, targetP95: 300 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });

    describe('Foreign Key Relation Queries', () => {
        test('orders by userId', async () => {
            // First get a user ID
            const users = await new Query()
                .with(BenchUser, {
                    filters: [Query.filter('orderCount', FilterOp.GT, 0)]
                })
                .take(1)
                .populate()
                .exec();

            if (users.length === 0) {
                console.log('Skipping: no users with orders found');
                return;
            }

            const userId = users[0]!.id;

            const result = await runner.run(
                'fk-orders-by-user',
                async () => {
                    return await new Query()
                        .with(BenchOrder, {
                            filters: [Query.filter('userId', FilterOp.EQ, userId)]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('reviews by productId', async () => {
            // First get a product ID
            const products = await new Query()
                .with(BenchProduct, {
                    filters: [Query.filter('reviewCount', FilterOp.GT, 0)]
                })
                .take(1)
                .populate()
                .exec();

            if (products.length === 0) {
                console.log('Skipping: no products with reviews found');
                return;
            }

            const productId = products[0]!.id;

            const result = await runner.run(
                'fk-reviews-by-product',
                async () => {
                    return await new Query()
                        .with(BenchReview, {
                            filters: [Query.filter('productId', FilterOp.EQ, productId)]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('order items by orderId', async () => {
            // First get an order ID
            const orders = await new Query()
                .with(BenchOrder, {
                    filters: [Query.filter('itemCount', FilterOp.GT, 0)]
                })
                .take(1)
                .populate()
                .exec();

            if (orders.length === 0) {
                console.log('Skipping: no orders with items found');
                return;
            }

            const orderId = orders[0]!.id;

            const result = await runner.run(
                'fk-items-by-order',
                async () => {
                    return await new Query()
                        .with(BenchOrderItem, {
                            filters: [Query.filter('orderId', FilterOp.EQ, orderId)]
                        })
                        .take(100)
                        .exec();
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });

    describe('Complex Queries with Sorting', () => {
        test('multi-component with filter and sort', async () => {
            const result = await runner.run(
                'complex-filter-sort',
                async () => {
                    return await new Query()
                        .with(BenchProduct, {
                            filters: [
                                Query.filter('status', FilterOp.EQ, 'active'),
                                Query.filter('stock', FilterOp.GT, 10)
                            ]
                        })
                        .with(BenchReview)
                        .sortBy(BenchProduct, 'rating', 'DESC')
                        .take(50)
                        .exec();
                },
                { iterations: 15, targetP95: 300 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('date range with sorting', async () => {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const result = await runner.run(
                'date-range-sorted',
                async () => {
                    return await new Query()
                        .with(BenchOrder, {
                            filters: [
                                Query.filter('orderedAt', FilterOp.GTE, thirtyDaysAgo.toISOString())
                            ]
                        })
                        .sortBy(BenchOrder, 'total', 'DESC')
                        .take(100)
                        .exec();
                },
                { iterations: 15, targetP95: 200 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });

    describe('Pagination Performance', () => {
        test('deep pagination (offset 1000)', async () => {
            const result = await runner.run(
                'pagination-offset-1000',
                async () => {
                    return await new Query()
                        .with(BenchProduct)
                        .take(50)
                        .offset(1000)
                        .exec();
                },
                { iterations: 15, targetP95: 200 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('very deep pagination (offset 5000)', async () => {
            const result = await runner.run(
                'pagination-offset-5000',
                async () => {
                    return await new Query()
                        .with(BenchProduct)
                        .take(50)
                        .offset(5000)
                        .exec();
                },
                { iterations: 10, targetP95: 500 }
            );
            results.push(result);
            // Less strict for deep pagination
            expect(result.timings.p95).toBeLessThan(1000);
        });
    });

    describe('Count and Aggregations', () => {
        test('count query', async () => {
            const result = await runner.run(
                'count-products',
                async () => {
                    const count = await new Query()
                        .with(BenchProduct, {
                            filters: [Query.filter('status', FilterOp.EQ, 'active')]
                        })
                        .count();
                    return [{ count }];
                },
                { iterations: 20, targetP95: 100 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('sum aggregation', async () => {
            const result = await runner.run(
                'sum-order-totals',
                async () => {
                    const sum = await new Query()
                        .with(BenchOrder, {
                            filters: [Query.filter('status', FilterOp.EQ, 'delivered')]
                        })
                        .sum(BenchOrder, 'total');
                    return [{ sum }];
                },
                { iterations: 20, targetP95: 150 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('average aggregation', async () => {
            const result = await runner.run(
                'avg-product-price',
                async () => {
                    const avg = await new Query()
                        .with(BenchProduct, {
                            filters: [Query.filter('category', FilterOp.EQ, 'Electronics')]
                        })
                        .average(BenchProduct, 'price');
                    return [{ avg }];
                },
                { iterations: 20, targetP95: 150 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });

    describe('Populate Performance', () => {
        test('populate single component', async () => {
            const result = await runner.run(
                'populate-single',
                async () => {
                    return await new Query()
                        .with(BenchUser, {
                            filters: [Query.filter('tier', FilterOp.EQ, 'premium')]
                        })
                        .populate()
                        .take(50)
                        .exec();
                },
                { iterations: 15, targetP95: 200 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });

        test('populate multi-component', async () => {
            const result = await runner.run(
                'populate-multi',
                async () => {
                    return await new Query()
                        .with(BenchProduct, {
                            filters: [Query.filter('status', FilterOp.EQ, 'active')]
                        })
                        .with(BenchReview)
                        .populate()
                        .take(30)
                        .exec();
                },
                { iterations: 10, targetP95: 500 }
            );
            results.push(result);
            expect(result.passed).toBe(true);
        });
    });
});
