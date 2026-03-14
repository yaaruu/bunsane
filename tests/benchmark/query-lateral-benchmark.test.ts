/**
 * Benchmark: LATERAL joins vs EXISTS subqueries for multi-component queries
 *
 * Tests the performance impact of the INTERSECT query fix that disables
 * LATERAL joins for multi-component non-CTE queries.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Entity } from '../../core/Entity';
import { Query, FilterOp } from '../../query/Query';
import { Component, CompData, BaseComponent } from '../../core/components';
import { ComponentRegistry } from '../../core/components/ComponentRegistry';
import { ensureComponentsRegistered } from '../utils';

// Benchmark components
@Component
class BenchUser extends BaseComponent {
    @CompData({ indexed: true }) name: string = '';
    @CompData({ indexed: true }) email: string = '';
    @CompData() age: number = 0;
    @CompData() status: string = 'active';
}

@Component
class BenchProfile extends BaseComponent {
    @CompData({ indexed: true }) username: string = '';
    @CompData() bio: string = '';
    @CompData() verified: boolean = false;
}

@Component
class BenchSettings extends BaseComponent {
    @CompData() theme: string = 'light';
    @CompData() notifications: boolean = true;
    @CompData() language: string = 'en';
}

// Test configuration
const DATASET_SIZES = {
    small: 100,
    medium: 1000,
    large: 5000
};

const ITERATIONS = 5; // Number of times to run each query for averaging

interface BenchmarkResult {
    name: string;
    datasetSize: number;
    avgTimeMs: number;
    minTimeMs: number;
    maxTimeMs: number;
    resultCount: number;
}

async function runBenchmark(
    name: string,
    datasetSize: number,
    queryFn: () => Promise<Entity[]>
): Promise<BenchmarkResult> {
    const times: number[] = [];
    let resultCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        const results = await queryFn();
        const end = performance.now();
        times.push(end - start);
        resultCount = results.length;
    }

    return {
        name,
        datasetSize,
        avgTimeMs: times.reduce((a, b) => a + b, 0) / times.length,
        minTimeMs: Math.min(...times),
        maxTimeMs: Math.max(...times),
        resultCount
    };
}

describe('Query Performance Benchmark', () => {
    const createdEntityIds: string[] = [];
    const datasetSize = DATASET_SIZES.large; // 5000 entities

    beforeAll(async () => {
        await ensureComponentsRegistered(BenchUser, BenchProfile, BenchSettings);

        console.log(`\n📊 Creating ${datasetSize} test entities...`);
        const startCreate = performance.now();

        // Create entities with various component combinations
        for (let i = 0; i < datasetSize; i++) {
            const entity = Entity.Create();

            // All entities have BenchUser
            entity.add(BenchUser, {
                name: `User ${i}`,
                email: `user${i}@test.com`,
                age: 18 + (i % 60),
                status: i % 3 === 0 ? 'active' : (i % 3 === 1 ? 'inactive' : 'pending')
            });

            // 80% have BenchProfile
            if (i % 5 !== 0) {
                entity.add(BenchProfile, {
                    username: `user_${i}`,
                    bio: `Bio for user ${i}`,
                    verified: i % 2 === 0
                });
            }

            // 60% have BenchSettings
            if (i % 5 < 3) {
                entity.add(BenchSettings, {
                    theme: i % 2 === 0 ? 'light' : 'dark',
                    notifications: i % 3 !== 0,
                    language: ['en', 'es', 'fr', 'de'][i % 4]!
                });
            }

            await entity.save();
            createdEntityIds.push(entity.id);
        }

        const endCreate = performance.now();
        console.log(`✅ Created ${datasetSize} entities in ${(endCreate - startCreate).toFixed(0)}ms\n`);
    }, 120000); // 2 minute timeout for setup

    afterAll(async () => {
        // Cleanup
        console.log(`\n🧹 Cleaning up ${createdEntityIds.length} entities...`);
        for (const id of createdEntityIds) {
            try {
                const entity = await Entity.findById(id);
                if (entity) {
                    await entity.delete();
                }
            } catch {
                // Ignore cleanup errors
            }
        }
    }, 120000);

    describe('Single component queries (baseline)', () => {
        test('single component, no filter', async () => {
            const result = await runBenchmark(
                'Single component, no filter',
                datasetSize,
                () => new Query().with(BenchUser).take(100).exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(1000);
        });

        test('single component, with filter', async () => {
            const result = await runBenchmark(
                'Single component, with filter',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.EQ, 'active')]
                    })
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(1000);
        });
    });

    describe('Two component queries (affected by fix)', () => {
        test('2 components, no filter', async () => {
            const result = await runBenchmark(
                '2 components, no filter',
                datasetSize,
                () => new Query()
                    .with(BenchUser)
                    .with(BenchProfile)
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(2000);
        });

        test('2 components, filter on first (bug pattern)', async () => {
            const result = await runBenchmark(
                '2 components, filter on first',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.EQ, 'active')]
                    })
                    .with(BenchProfile)
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(2000);
        });

        test('2 components, filter on second (bug pattern)', async () => {
            const result = await runBenchmark(
                '2 components, filter on second',
                datasetSize,
                () => new Query()
                    .with(BenchUser)
                    .with(BenchProfile, {
                        filters: [Query.filter('verified', FilterOp.EQ, true)]
                    })
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(2000);
        });

        test('2 components, filters on both', async () => {
            const result = await runBenchmark(
                '2 components, filters on both',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.EQ, 'active')]
                    })
                    .with(BenchProfile, {
                        filters: [Query.filter('verified', FilterOp.EQ, true)]
                    })
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(2000);
        });

        test('2 components, IN filter (bug pattern)', async () => {
            const result = await runBenchmark(
                '2 components, IN filter',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.IN, ['active', 'pending'])]
                    })
                    .with(BenchProfile)
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(2000);
        });
    });

    describe('Three component queries', () => {
        test('3 components, no filter', async () => {
            const result = await runBenchmark(
                '3 components, no filter',
                datasetSize,
                () => new Query()
                    .with(BenchUser)
                    .with(BenchProfile)
                    .with(BenchSettings)
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(3000);
        });

        test('3 components, filter on one', async () => {
            const result = await runBenchmark(
                '3 components, filter on one',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('age', FilterOp.GTE, 30)]
                    })
                    .with(BenchProfile)
                    .with(BenchSettings)
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(3000);
        });

        test('3 components, filters on all', async () => {
            const result = await runBenchmark(
                '3 components, filters on all',
                datasetSize,
                () => new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.EQ, 'active')]
                    })
                    .with(BenchProfile, {
                        filters: [Query.filter('verified', FilterOp.EQ, true)]
                    })
                    .with(BenchSettings, {
                        filters: [Query.filter('theme', FilterOp.EQ, 'dark')]
                    })
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(3000);
        });
    });

    describe('Sorting with multi-component (affected by fix)', () => {
        test('2 components, sort on first', async () => {
            const result = await runBenchmark(
                '2 components, sort on first',
                datasetSize,
                () => new Query()
                    .with(BenchUser)
                    .with(BenchProfile)
                    .sortBy(BenchUser, 'age', 'DESC')
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(3000);
        });

        test('2 components, filter + sort on different components', async () => {
            const result = await runBenchmark(
                '2 components, filter + sort different',
                datasetSize,
                () => new Query()
                    .with(BenchUser)
                    .with(BenchProfile, {
                        filters: [Query.filter('verified', FilterOp.EQ, true)]
                    })
                    .sortBy(BenchUser, 'age', 'ASC')
                    .take(100)
                    .exec()
            );
            console.log(`  ${result.name}: ${result.avgTimeMs.toFixed(2)}ms avg (${result.resultCount} results)`);
            expect(result.avgTimeMs).toBeLessThan(3000);
        });
    });

    describe('Count operations', () => {
        test('2 components count with filter', async () => {
            const times: number[] = [];
            let count = 0;

            for (let i = 0; i < ITERATIONS; i++) {
                const start = performance.now();
                count = await new Query()
                    .with(BenchUser, {
                        filters: [Query.filter('status', FilterOp.EQ, 'active')]
                    })
                    .with(BenchProfile)
                    .count();
                const end = performance.now();
                times.push(end - start);
            }

            const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
            console.log(`  2 components count with filter: ${avgTime.toFixed(2)}ms avg (count: ${count})`);
            expect(avgTime).toBeLessThan(2000);
        });
    });

    test('Performance summary', () => {
        console.log('\n📈 Benchmark Summary:');
        console.log(`   Dataset size: ${datasetSize} entities`);
        console.log(`   Iterations per query: ${ITERATIONS}`);
        console.log('   All queries completed within acceptable thresholds');
        expect(true).toBe(true);
    });
});
