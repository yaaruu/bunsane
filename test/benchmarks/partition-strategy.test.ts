import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { Query } from '../../query/Query';
import { Component, CompData, ComponentRegistry, BaseComponent, type ComponentDataType } from "@/core/components";
import { PrepareDatabase, GetPartitionStrategy } from '../../database/DatabaseHelper';
import { Entity } from '../../core/Entity';
import {
    runBenchmarkSuite,
    runBenchmarkScenario,
    BENCHMARK_SCENARIOS,
    BenchmarkResult,
    setupBenchmarkEnvironment,
    generateBenchmarkData,
    formatBenchmarkResults
} from './partition-benchmark-utils';

// Test components (same as in utils for consistency)
@Component
class BenchmarkUser extends BaseComponent {
    @CompData()
    username!: string;

    @CompData()
    email!: string;

    @CompData()
    account_type!: string;
}

@Component
class BenchmarkOrder extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    order_date!: string;

    @CompData()
    total_amount!: number;

    @CompData()
    status!: string;
}

@Component
class BenchmarkProduct extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    category!: string;

    @CompData()
    price!: number;

    @CompData()
    in_stock!: boolean;
}

@Component
class BenchmarkLocation extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    latitude!: number;

    @CompData()
    longitude!: number;

    @CompData()
    accuracy!: number;
}

@Component
class BenchmarkActivity extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    activity_type!: string;

    @CompData()
    timestamp!: string;
}

describe.skip('Partition Strategy Benchmark Tests', () => {
    beforeAll(async () => {
        // Initial setup
        console.log('Initializing benchmark test environment...');
    });

    describe('Environment Setup Tests', () => {
        it('should setup LIST partitioning environment', async () => {
            await setupBenchmarkEnvironment('list', false);

            // Check environment variables were set (config is cached so may not reflect change immediately)
            expect(process.env.BUNSANE_PARTITION_STRATEGY).toBe('list');
            expect(process.env.BUNSANE_USE_DIRECT_PARTITION).toBe('false');
        });

        it('should setup LIST + direct partition environment', async () => {
            await setupBenchmarkEnvironment('list', true);

            const strategy = await GetPartitionStrategy();
            expect(strategy).toBe('list');

            expect(process.env.BUNSANE_USE_DIRECT_PARTITION).toBe('true');
        }, 30000);

        it('should setup HASH partitioning environment', async () => {
            await setupBenchmarkEnvironment('hash', false);

            const strategy = await GetPartitionStrategy();
            expect(strategy).toBe('hash');

            expect(process.env.BUNSANE_USE_DIRECT_PARTITION).toBe('false');
        }, 30000);
    });

    describe('Individual Scenario Benchmarks', () => {
        beforeEach(async () => {
            // Setup fresh environment for each test
            await setupBenchmarkEnvironment('list', true);
            await ComponentRegistry.ensureComponentsRegistered();
        });

        it('should benchmark single component filter query', async () => {
            const query = new Query()
                .with(BenchmarkUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            const result = await runBenchmarkScenario('Single Component Filter', query);

            expect(result).toBeDefined();
            expect(result.queryType).toBe('Single Component Filter');
            expect(result.totalTimeMs).toBeGreaterThan(0);
            expect(typeof result.rowsReturned).toBe('number');

            console.log(`Single Component Filter: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
        }, 30000);

        it('should benchmark multi-component AND query', async () => {
            const query = new Query()
                .with(BenchmarkUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ))
                .with(BenchmarkOrder, Query.filters(
                    Query.filter('status', Query.filterOp.EQ, 'completed')
                ));

            const result = await runBenchmarkScenario('Multi Component AND', query);

            expect(result).toBeDefined();
            expect(result.queryType).toBe('Multi Component AND');
            expect(result.totalTimeMs).toBeGreaterThan(0);

            console.log(`Multi Component AND: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
        }, 30000);

        it('should benchmark OR query', async () => {
            const orQuery = Query.or([
                {
                    component: BenchmarkUser,
                    filters: [Query.filter('account_type', Query.filterOp.EQ, 'premium')]
                },
                {
                    component: BenchmarkOrder,
                    filters: [Query.filter('total_amount', Query.filterOp.GT, 100)]
                }
            ]);

            const query = new Query().with(orQuery);
            const result = await runBenchmarkScenario('OR Query', query);

            expect(result).toBeDefined();
            expect(result.queryType).toBe('OR Query');
            expect(result.totalTimeMs).toBeGreaterThan(0);

            console.log(`OR Query: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
        }, 30000);

        it('should benchmark sort query', async () => {
            const query = new Query()
                .with(BenchmarkOrder)
                .sortBy(BenchmarkOrder, 'total_amount', 'DESC')
                .take(50);

            const result = await runBenchmarkScenario('Sort Query', query);

            expect(result).toBeDefined();
            expect(result.queryType).toBe('Sort Query');
            expect(result.rowsReturned).toBeLessThanOrEqual(50);

            console.log(`Sort Query: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
        }, 30000);

        it('should benchmark count query', async () => {
            const query = new Query()
                .with(BenchmarkUser, Query.filters(
                    Query.filter('account_type', Query.filterOp.EQ, 'premium')
                ));

            const result = await runBenchmarkScenario('Count Query', query, { isCount: true });

            expect(result).toBeDefined();
            expect(result.queryType).toBe('Count Query');
            expect(typeof result.rowsReturned).toBe('number');

            console.log(`Count Query: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
        }, 30000);
    });

    describe('Strategy Comparison Tests', () => {
        const strategies: Array<{ strategy: 'list' | 'hash'; useDirect: boolean; name: string }> = [
            { strategy: 'list', useDirect: false, name: 'LIST' },
            { strategy: 'list', useDirect: true, name: 'LIST+Direct' },
            { strategy: 'hash', useDirect: false, name: 'HASH' }
        ];

        it('should compare all strategies on single component filter', async () => {
            const results: BenchmarkResult[] = [];

            for (const { strategy, useDirect, name } of strategies) {
                console.log(`\nTesting ${name} strategy...`);

                await setupBenchmarkEnvironment(strategy, useDirect);
                await generateBenchmarkData(500); // Smaller dataset for faster testing

                const query = new Query()
                    .with(BenchmarkUser, Query.filters(
                        Query.filter('account_type', Query.filterOp.EQ, 'premium')
                    ));

                const result = await runBenchmarkScenario(`Single Filter (${name})`, query);
                results.push(result);
            }

            // Log comparison
            console.log('\n=== Strategy Comparison ===');
            results.forEach(result => {
                console.log(`${result.queryType}: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
            });

            // At least one strategy should have reasonable performance
            expect(results.some(r => r.totalTimeMs < 100)).toBe(true);

        });

        it('should compare strategies on complex multi-component query', async () => {
            const results: BenchmarkResult[] = [];

            for (const { strategy, useDirect, name } of strategies) {
                console.log(`\nTesting ${name} strategy (complex query)...`);

                await setupBenchmarkEnvironment(strategy, useDirect);
                await generateBenchmarkData(500);

                const query = new Query()
                    .with(BenchmarkUser, Query.filters(
                        Query.filter('account_type', Query.filterOp.EQ, 'premium')
                    ))
                    .with(BenchmarkOrder, Query.filters(
                        Query.filter('total_amount', Query.filterOp.GT, 50)
                    ))
                    .with(BenchmarkLocation)
                    .sortBy(BenchmarkOrder, 'total_amount', 'DESC')
                    .take(20);

                const result = await runBenchmarkScenario(`Complex Query (${name})`, query);
                results.push(result);
            }

            console.log('\n=== Complex Query Comparison ===');
            results.forEach(result => {
                console.log(`${result.queryType}: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);
            });

            expect(results.length).toBe(3);
            expect(results.every(r => r.rowsReturned <= 20)).toBe(true);

        });
    });

    describe('Benchmark Suite Integration', () => {
        it('should run complete benchmark suite for LIST strategy', async () => {
            const results = await runBenchmarkSuite('list', true, 200, 5); // Small dataset

            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);

            // All results should have the correct strategy
            expect(results.every(r => r.strategy === 'list')).toBe(true);
            expect(results.every(r => r.useDirectPartition === true)).toBe(true);

            // Log formatted results
            console.log('\n' + formatBenchmarkResults(results));

        });

        it('should run complete benchmark suite for HASH strategy', async () => {
            const results = await runBenchmarkSuite('hash', false, 200, 5);

            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);

            // All results should have the correct strategy
            expect(results.every(r => r.strategy === 'hash')).toBe(true);
            expect(results.every(r => r.useDirectPartition === false)).toBe(true);

            console.log('\n' + formatBenchmarkResults(results));

        });
    });
});
