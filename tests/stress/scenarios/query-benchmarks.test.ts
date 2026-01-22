/**
 * Stress Tests - Query Performance Benchmarks
 *
 * Tests query performance with configurable data volumes
 * Default: 10,000 records (smoke test)
 * Set STRESS_RECORD_COUNT env var for larger tests
 */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { DataSeeder } from '../DataSeeder';
import { BenchmarkRunner } from '../BenchmarkRunner';
import { StressTestReporter } from '../StressTestReporter';
import { Query, FilterOp } from '../../../query/Query';
import { StressUser, StressProfile } from '../fixtures/StressTestComponents';
import { ensureComponentsRegistered } from '../../utils';

// Configurable via environment variable
const RECORD_COUNT = parseInt(process.env.STRESS_RECORD_COUNT || '10000', 10);
const BATCH_SIZE = Math.min(5000, Math.floor(RECORD_COUNT / 10) || 1000);

describe('Stress Tests - Query Performance', () => {
    const seeder = new DataSeeder();
    const benchmark = new BenchmarkRunner();
    const reporter = new StressTestReporter();
    let entityIds: string[] = [];
    let setupTime = 0;

    beforeAll(async () => {
        const startSetup = performance.now();

        // Ensure components are registered
        await ensureComponentsRegistered(StressUser, StressProfile);

        // Wait for index creation to settle (prevents deadlocks from concurrent index creation)
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log(`\n  Seeding ${RECORD_COUNT.toLocaleString()} records...`);

        const result = await seeder.seed(
            StressUser,
            (i) => ({
                name: `User ${i}`,
                email: `user${i}@stress.test`,
                age: 18 + (i % 62),
                status: ['active', 'inactive', 'pending', 'banned'][i % 4],
                score: Math.random() * 1000,
                createdAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000)
            }),
            {
                totalEntities: RECORD_COUNT,
                batchSize: BATCH_SIZE,
                onProgress: (current, total, elapsed) => {
                    if (current % (BATCH_SIZE * 2) === 0 || current === total) {
                        const pct = ((current / total) * 100).toFixed(1);
                        const rate = ((current / elapsed) * 1000).toFixed(0);
                        console.log(`    Progress: ${pct}% (${rate} records/sec)`);
                    }
                }
            }
        );

        entityIds = result.entityIds;
        console.log(`  Seeded in ${(result.totalTime / 1000).toFixed(1)}s (${result.recordsPerSecond.toFixed(0)} records/sec)`);

        // Add profile components to 50% of entities
        if (RECORD_COUNT >= 1000) {
            console.log('  Adding profile components to 50% of entities...');
            await seeder.seedAdditionalComponent(
                entityIds.slice(0, Math.floor(entityIds.length / 2)),
                StressProfile,
                (i) => ({
                    bio: `This is bio ${i}`,
                    avatarUrl: `https://example.com/avatar/${i}.png`,
                    verified: i % 3 === 0
                }),
                BATCH_SIZE
            );
        }

        console.log('  Running VACUUM ANALYZE...');
        await seeder.optimize();

        setupTime = performance.now() - startSetup;
        console.log(`  Setup complete in ${(setupTime / 1000).toFixed(1)}s\n`);
    });

    afterAll(async () => {
        // Print report
        const recordCount = await seeder.getRecordCount();
        const report = reporter.generateReport(benchmark.getResults(), {
            recordCount,
            environment: `PostgreSQL, Bun ${Bun.version}`,
            duration: setupTime
        });
        console.log('\n' + report);

        // Cleanup seeded data
        console.log('\n  Cleaning up test data...');
        await seeder.cleanup(entityIds, BATCH_SIZE);
        console.log('  Cleanup complete.');
    });

    test('indexed equality filter (status = active)', async () => {
        const result = await benchmark.runWithOutput(
            'Filter: status = active',
            () => new Query()
                .with(StressUser, { filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }] })
                .take(100)
                .exec(),
            { targetP95: 50, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('indexed range filter (age 25-35)', async () => {
        const result = await benchmark.runWithOutput(
            'Filter: age 25-35',
            () => new Query()
                .with(StressUser, {
                    filters: [
                        { field: 'age', operator: FilterOp.GTE, value: 25 },
                        { field: 'age', operator: FilterOp.LTE, value: 35 }
                    ]
                })
                .take(100)
                .exec(),
            { targetP95: 75, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('count query', async () => {
        const result = await benchmark.runWithOutput(
            'COUNT all',
            async () => [await new Query().with(StressUser).count()],
            { targetP95: 100, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('pagination - shallow offset (1000)', async () => {
        const result = await benchmark.runWithOutput(
            'Offset 1000',
            () => new Query()
                .with(StressUser)
                .sortBy(StressUser, 'name', 'ASC')
                .take(100)
                .offset(1000)
                .exec(),
            { targetP95: 75, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('pagination - deep offset (50% of records)', async () => {
        const deepOffset = Math.floor(RECORD_COUNT / 2);
        const result = await benchmark.runWithOutput(
            `Offset ${deepOffset.toLocaleString()}`,
            () => new Query()
                .with(StressUser)
                .sortBy(StressUser, 'name', 'ASC')
                .take(100)
                .offset(deepOffset)
                .exec(),
            { targetP95: 500, iterations: 10 }
        );
        // Deep pagination is expected to be slower, use a more lenient target
        expect(result.timings.p95).toBeLessThan(2000);
    });

    test('cursor pagination - first page', async () => {
        const result = await benchmark.runWithOutput(
            'Cursor: first page',
            () => new Query()
                .with(StressUser)
                .take(100)
                .exec(),
            { targetP95: 50, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('cursor pagination - from middle (using cursor)', async () => {
        // First, get an entity ID from the middle of the dataset
        const midpointResults = await new Query()
            .with(StressUser)
            .take(1)
            .offset(Math.floor(RECORD_COUNT / 2))
            .exec();

        const cursorId = midpointResults[0]?.id;
        if (!cursorId) {
            console.log('  Skipping cursor test - no midpoint entity found');
            return;
        }

        const result = await benchmark.runWithOutput(
            'Cursor: from middle (O(1))',
            () => new Query()
                .with(StressUser)
                .cursor(cursorId)
                .take(100)
                .exec(),
            { targetP95: 50, iterations: 15 }
        );
        // Cursor pagination should be fast regardless of position
        expect(result.passed).toBe(true);
    });

    test('cursor pagination - near end (using cursor)', async () => {
        // Get an entity ID from near the end (90%)
        const nearEndResults = await new Query()
            .with(StressUser)
            .take(1)
            .offset(Math.floor(RECORD_COUNT * 0.9))
            .exec();

        const cursorId = nearEndResults[0]?.id;
        if (!cursorId) {
            console.log('  Skipping cursor test - no near-end entity found');
            return;
        }

        const result = await benchmark.runWithOutput(
            'Cursor: near end (O(1))',
            () => new Query()
                .with(StressUser)
                .cursor(cursorId)
                .take(100)
                .exec(),
            { targetP95: 50, iterations: 15 }
        );
        // Cursor pagination should be fast regardless of position
        expect(result.passed).toBe(true);
    });

    test('multi-component join (User + Profile)', async () => {
        const result = await benchmark.runWithOutput(
            'Join: User + Profile',
            () => new Query()
                .with(StressUser)
                .with(StressProfile)
                .take(100)
                .exec(),
            { targetP95: 150, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('combined filters and sort', async () => {
        const result = await benchmark.runWithOutput(
            'Filter + Sort + Limit',
            () => new Query()
                .with(StressUser, {
                    filters: [
                        { field: 'status', operator: FilterOp.EQ, value: 'active' },
                        { field: 'age', operator: FilterOp.GTE, value: 21 }
                    ]
                })
                .sortBy(StressUser, 'score', 'DESC')
                .take(50)
                .exec(),
            { targetP95: 100, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('simple query without filters', async () => {
        const result = await benchmark.runWithOutput(
            'Simple: take 100',
            () => new Query()
                .with(StressUser)
                .take(100)
                .exec(),
            { targetP95: 50, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });

    test('query with populate', async () => {
        const result = await benchmark.runWithOutput(
            'Populated: take 50',
            () => new Query()
                .with(StressUser)
                .populate()
                .take(50)
                .exec(),
            { targetP95: 100, iterations: 15 }
        );
        expect(result.passed).toBe(true);
    });
});
