/**
 * Complex Query Performance Analysis Tests
 * Analyzes query plans for performance issues
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { Entity } from '../../../core/Entity';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';
import { CacheManager } from '../../../core/cache';
import EntityManager from '../../../core/EntityManager';
import db from '../../../database';

interface QueryPlanAnalysis {
    plan: string;
    hasSeqScan: boolean;
    hasIndexScan: boolean;
    hasNestedLoop: boolean;
    hasHashJoin: boolean;
    planningTimeMs: number;
    executionTimeMs: number;
    totalRows: number;
    warnings: string[];
}

function analyzeQueryPlan(plan: string): QueryPlanAnalysis {
    const warnings: string[] = [];

    const hasSeqScan = /Seq Scan/i.test(plan);
    const hasIndexScan = /Index Scan|Index Only Scan|Bitmap Index Scan/i.test(plan);
    const hasNestedLoop = /Nested Loop/i.test(plan);
    const hasHashJoin = /Hash Join/i.test(plan);

    // Extract timing
    const planningMatch = plan.match(/Planning Time:\s*([\d.]+)\s*ms/i);
    const executionMatch = plan.match(/Execution Time:\s*([\d.]+)\s*ms/i);
    const planningTimeMs = planningMatch ? parseFloat(planningMatch[1]!) : 0;
    const executionTimeMs = executionMatch ? parseFloat(executionMatch[1]!) : 0;

    // Extract row counts
    const rowsMatch = plan.match(/rows=(\d+)/g);
    const totalRows = rowsMatch
        ? rowsMatch.reduce((sum, m) => sum + parseInt(m.replace('rows=', '')), 0)
        : 0;

    // Check for potential issues
    if (hasSeqScan && !hasIndexScan) {
        warnings.push('Sequential scan (expected for small tables)');
    }

    if (hasNestedLoop && totalRows > 1000) {
        warnings.push('Nested loop with many rows');
    }

    return {
        plan,
        hasSeqScan,
        hasIndexScan,
        hasNestedLoop,
        hasHashJoin,
        planningTimeMs,
        executionTimeMs,
        totalRows,
        warnings
    };
}

describe('Complex Query Performance Analysis', () => {
    // Configurable via PERF_ENTITY_COUNT env var (default: 50, max recommended: 50000)
    const ENTITY_COUNT = parseInt(process.env.PERF_ENTITY_COUNT || '50', 10);
    const BATCH_SIZE = 100; // Insert in batches for better performance
    const createdEntityIds: string[] = [];

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);

        // Initialize cache
        (EntityManager as any).dbReady = true;
        const cacheManager = CacheManager.getInstance();
        await cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            query: { enabled: false, ttl: 300000, maxSize: 10000 }
        });

        // Create test dataset (not using tracker so data persists)
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Creating ${ENTITY_COUNT.toLocaleString()} test entities for performance analysis...`);
        console.log(`(Set PERF_ENTITY_COUNT env var to change: 10000, 50000, etc.)`);
        console.log(`${'='.repeat(60)}\n`);

        const startTime = performance.now();
        let lastProgressTime = startTime;

        for (let i = 0; i < ENTITY_COUNT; i++) {
            const entity = Entity.Create();
            createdEntityIds.push(entity.id);

            entity.add(TestUser, {
                name: `PerfUser${i}`,
                email: `perf${i}@example.com`,
                age: 20 + (i % 50)
            });

            if (i % 2 === 0) {
                entity.add(TestProduct, {
                    sku: `PERF-SKU-${i}`,
                    name: `Performance Product ${i}`,
                    price: 10 + (i % 1000) * 5, // Vary prices
                    inStock: i % 3 !== 0
                });
            }

            if (i % 3 === 0) {
                entity.add(TestOrder, {
                    orderId: `ORD-${i}`,
                    total: 100 + (i % 500) * 10,
                    status: i % 2 === 0 ? 'completed' : 'pending'
                });
            }

            await entity.save();

            // Progress indicator for large datasets
            if (ENTITY_COUNT >= 1000 && (i + 1) % 1000 === 0) {
                const now = performance.now();
                const elapsed = (now - startTime) / 1000;
                const rate = (i + 1) / elapsed;
                const remaining = (ENTITY_COUNT - i - 1) / rate;
                console.log(`  Progress: ${i + 1}/${ENTITY_COUNT} (${((i + 1) / ENTITY_COUNT * 100).toFixed(1)}%) - ${rate.toFixed(0)} entities/sec - ETA: ${remaining.toFixed(1)}s`);
            }
        }

        const totalTime = (performance.now() - startTime) / 1000;
        console.log(`\nTest data created in ${totalTime.toFixed(2)}s (${(ENTITY_COUNT / totalTime).toFixed(0)} entities/sec)\n`);

        // Run ANALYZE to update PostgreSQL statistics for better query planning
        if (ENTITY_COUNT >= 1000) {
            console.log('Running ANALYZE to update statistics...');
            await db.unsafe(`ANALYZE entities`);
            await db.unsafe(`ANALYZE components`);
            await db.unsafe(`ANALYZE entity_components`);
            console.log('Statistics updated.\n');
        }
    }, 600000); // 10 minute timeout for large datasets

    afterAll(async () => {
        // Bulk cleanup for performance
        console.log(`\nCleaning up ${createdEntityIds.length.toLocaleString()} test entities...`);
        const startTime = performance.now();

        // Delete in batches
        for (let i = 0; i < createdEntityIds.length; i += BATCH_SIZE) {
            const batch = createdEntityIds.slice(i, i + BATCH_SIZE);
            const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(',');
            try {
                await db.unsafe(`DELETE FROM components WHERE entity_id IN (${placeholders})`, batch);
                await db.unsafe(`DELETE FROM entities WHERE id IN (${placeholders})`, batch);
            } catch { }
        }

        const duration = (performance.now() - startTime) / 1000;
        console.log(`Cleanup completed in ${duration.toFixed(2)}s\n`);
    }, 600000);

    describe('Single Component Queries', () => {
        test('simple query without filters', async () => {
            const plan = await new Query()
                .with(TestUser)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Simple Query (no filters) ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Seq Scan: ${analysis.hasSeqScan}, Index Scan: ${analysis.hasIndexScan}`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }
            console.log('---\n' + plan.substring(0, 500) + '...\n');

            expect(analysis.executionTimeMs).toBeLessThan(1000); // Should be fast
        });

        test('query with equality filter', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'PerfUser25')]
                })
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Equality Filter Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Seq Scan: ${analysis.hasSeqScan}, Index Scan: ${analysis.hasIndexScan}`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });

        test('query with range filter', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [
                        Query.filter('age', FilterOp.GTE, 30),
                        Query.filter('age', FilterOp.LTE, 40)
                    ]
                })
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Range Filter Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Seq Scan: ${analysis.hasSeqScan}, Index Scan: ${analysis.hasIndexScan}`);

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });

        test('query with LIKE filter', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, 'perf%@example.com')]
                })
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== LIKE Filter Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            // LIKE queries often use seq scan which is expected

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });
    });

    describe('Multi-Component Queries', () => {
        test('two component intersection', async () => {
            const plan = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Two Component Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Join type - Nested Loop: ${analysis.hasNestedLoop}, Hash Join: ${analysis.hasHashJoin}`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }

            expect(analysis.executionTimeMs).toBeLessThan(1000);
        });

        test('three component intersection', async () => {
            const plan = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .with(TestOrder)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Three Component Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Join type - Nested Loop: ${analysis.hasNestedLoop}, Hash Join: ${analysis.hasHashJoin}`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }

            expect(analysis.executionTimeMs).toBeLessThan(1000);
        });

        test('multi-component with filters on each', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GT, 25)]
                })
                .with(TestProduct, {
                    filters: [Query.filter('inStock', FilterOp.EQ, true)]
                })
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Multi-Component with Filters ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }

            expect(analysis.executionTimeMs).toBeLessThan(1000);
        });
    });

    describe('Sorting and Pagination', () => {
        test('sorted query', async () => {
            const plan = await new Query()
                .with(TestUser)
                .sortBy(TestUser, 'age', 'DESC')
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Sorted Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Has Sort operator: ${/Sort/i.test(plan)}`);

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });

        test('paginated query (OFFSET)', async () => {
            const plan = await new Query()
                .with(TestUser)
                .take(10)
                .offset(20)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Paginated Query (OFFSET) ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Has Limit: ${/Limit/i.test(plan)}`);

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });

        test('cursor-based pagination', async () => {
            // First get an entity ID to use as cursor
            const entities = await new Query()
                .with(TestUser)
                .take(15)
                .exec();

            if (entities.length >= 15) {
                const cursorId = entities[14]!.id;

                const plan = await new Query()
                    .with(TestUser)
                    .cursor(cursorId)
                    .take(10)
                    .explainAnalyze();

                const analysis = analyzeQueryPlan(plan);

                console.log('\n=== Cursor-Based Pagination ===');
                console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);

                expect(analysis.executionTimeMs).toBeLessThan(500);
            }
        });

        test('sorted and paginated', async () => {
            const plan = await new Query()
                .with(TestUser)
                .sortBy(TestUser, 'name', 'ASC')
                .take(10)
                .offset(5)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Sorted + Paginated Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);

            expect(analysis.executionTimeMs).toBeLessThan(500);
        });
    });

    describe('Aggregate Queries', () => {
        test('count query', async () => {
            const startTime = performance.now();
            const count = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.LIKE, 'PerfUser%')]
                })
                .count();
            const duration = performance.now() - startTime;

            console.log('\n=== Count Query ===');
            console.log(`Count result: ${count}, Duration: ${duration.toFixed(2)}ms`);

            expect(count).toBeGreaterThan(0);
            expect(duration).toBeLessThan(500);
        });

        test('sum query', async () => {
            const startTime = performance.now();
            const sum = await new Query()
                .with(TestProduct, {
                    filters: [Query.filter('name', FilterOp.LIKE, 'Performance Product%')]
                })
                .sum(TestProduct, 'price');
            const duration = performance.now() - startTime;

            console.log('\n=== Sum Query ===');
            console.log(`Sum result: ${sum}, Duration: ${duration.toFixed(2)}ms`);

            expect(sum).toBeGreaterThan(0);
            expect(duration).toBeLessThan(500);
        });

        test('average query', async () => {
            const startTime = performance.now();
            const avg = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.LIKE, 'PerfUser%')]
                })
                .average(TestUser, 'age');
            const duration = performance.now() - startTime;

            console.log('\n=== Average Query ===');
            console.log(`Average result: ${avg.toFixed(2)}, Duration: ${duration.toFixed(2)}ms`);

            expect(avg).toBeGreaterThan(0);
            expect(duration).toBeLessThan(500);
        });
    });

    describe('Complex Combined Queries', () => {
        test('full complexity query', async () => {
            const plan = await new Query()
                .with(TestUser, {
                    filters: [
                        Query.filter('age', FilterOp.GTE, 25),
                        Query.filter('age', FilterOp.LTE, 45)
                    ]
                })
                .with(TestProduct, {
                    filters: [Query.filter('inStock', FilterOp.EQ, true)]
                })
                .sortBy(TestUser, 'age', 'DESC')
                .take(20)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Full Complexity Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Seq Scan: ${analysis.hasSeqScan}, Index Scan: ${analysis.hasIndexScan}`);
            console.log(`Nested Loop: ${analysis.hasNestedLoop}, Hash Join: ${analysis.hasHashJoin}`);
            if (analysis.warnings.length > 0) {
                console.log('Warnings:', analysis.warnings);
            }
            console.log('\nFull Plan:\n' + plan);

            expect(analysis.executionTimeMs).toBeLessThan(1000);
        });

        test('without() exclusion query', async () => {
            const plan = await new Query()
                .with(TestUser)
                .without(TestProduct)
                .explainAnalyze();

            const analysis = analyzeQueryPlan(plan);

            console.log('\n=== Exclusion (without) Query ===');
            console.log(`Planning: ${analysis.planningTimeMs}ms, Execution: ${analysis.executionTimeMs}ms`);
            console.log(`Has NOT EXISTS or anti-join pattern: ${/NOT EXISTS|Anti/i.test(plan) || /NOT IN/i.test(plan)}`);

            expect(analysis.executionTimeMs).toBeLessThan(1000);
        });
    });

    describe('Performance Summary', () => {
        test('generate performance report', async () => {
            const results: Array<{ name: string; planningMs: number; executionMs: number; warnings: string[]; scanType: string }> = [];

            const getScanType = (a: QueryPlanAnalysis) => {
                if (a.hasIndexScan && !a.hasSeqScan) return 'Index';
                if (a.hasSeqScan && !a.hasIndexScan) return 'Seq';
                if (a.hasIndexScan && a.hasSeqScan) return 'Mixed';
                return 'N/A';
            };

            // Simple query
            let plan = await new Query().with(TestUser).explainAnalyze();
            let analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Simple (1 component)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Filtered
            plan = await new Query().with(TestUser, { filters: [Query.filter('age', FilterOp.GT, 30)] }).explainAnalyze();
            analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Filtered (JSONB)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Multi-component
            plan = await new Query().with(TestUser).with(TestProduct).explainAnalyze();
            analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Multi-component (2)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Count
            const countStart = performance.now();
            const count = await new Query().with(TestUser).count();
            const countMs = performance.now() - countStart;
            results.push({ name: `Count (result: ${count})`, planningMs: 0, executionMs: countMs, warnings: [], scanType: 'N/A' });

            // Sorted + paginated
            plan = await new Query().with(TestUser).sortBy(TestUser, 'age').take(10).explainAnalyze();
            analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Sorted + Paginated (10)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Offset pagination (worst case)
            plan = await new Query().with(TestUser).take(10).offset(Math.floor(ENTITY_COUNT * 0.9)).explainAnalyze();
            analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Offset pagination (90%)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Complex
            plan = await new Query()
                .with(TestUser, { filters: [Query.filter('age', FilterOp.GT, 25)] })
                .with(TestProduct, { filters: [Query.filter('inStock', FilterOp.EQ, true)] })
                .sortBy(TestUser, 'age', 'DESC')
                .take(10)
                .explainAnalyze();
            analysis = analyzeQueryPlan(plan);
            results.push({ name: 'Complex (multi+filter+sort)', planningMs: analysis.planningTimeMs, executionMs: analysis.executionTimeMs, warnings: analysis.warnings, scanType: getScanType(analysis) });

            // Sum aggregate
            const sumStart = performance.now();
            const sum = await new Query()
                .with(TestProduct, { filters: [Query.filter('name', FilterOp.LIKE, 'Performance%')] })
                .sum(TestProduct, 'price');
            const sumMs = performance.now() - sumStart;
            results.push({ name: `Sum (result: ${sum})`, planningMs: 0, executionMs: sumMs, warnings: [], scanType: 'N/A' });

            console.log('\n' + '='.repeat(80));
            console.log(`PERFORMANCE SUMMARY REPORT - ${ENTITY_COUNT.toLocaleString()} entities`);
            console.log('='.repeat(80));
            console.log('\n| Query Type                          | Planning | Execution | Scan  |');
            console.log('|-------------------------------------|----------|-----------|-------|');

            let totalExecution = 0;
            for (const r of results) {
                totalExecution += r.executionMs;
                const planStr = r.planningMs > 0 ? `${r.planningMs.toFixed(2)}ms` : '-';
                const execStr = r.executionMs >= 1 ? `${r.executionMs.toFixed(1)}ms` : `${(r.executionMs * 1000).toFixed(0)}µs`;
                console.log(`| ${r.name.padEnd(35)} | ${planStr.padStart(8)} | ${execStr.padStart(9)} | ${r.scanType.padStart(5)} |`);
            }

            console.log('|-------------------------------------|----------|-----------|-------|');
            const totalStr = totalExecution >= 1 ? `${totalExecution.toFixed(1)}ms` : `${(totalExecution * 1000).toFixed(0)}µs`;
            console.log(`| TOTAL                               |          | ${totalStr.padStart(9)} |       |`);
            console.log('\n' + '='.repeat(80) + '\n');

            // All queries should complete in reasonable time
            expect(totalExecution).toBeLessThan(5000);
        });
    });
});
