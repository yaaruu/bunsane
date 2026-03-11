/**
 * Timeout Investigation Stress Tests
 *
 * These tests aim to reproduce and identify query timeout issues
 * reported by users during insert and query operations.
 *
 * Configuration via environment variables:
 * - STRESS_LARGE_COUNT: Number of records to seed (default: 5000)
 * - STRESS_CONCURRENT: Number of concurrent operations (default: 10)
 * - DB_QUERY_TIMEOUT: Query timeout in milliseconds (default: 30000)
 */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { DataSeeder } from '../DataSeeder';
import { BenchmarkRunner } from '../BenchmarkRunner';
import { Query, FilterOp } from '../../../query/Query';
import { Entity } from '../../../core/Entity';
import { StressUser, StressProfile } from '../fixtures/StressTestComponents';
import { ensureComponentsRegistered } from '../../utils';
import db, { QUERY_TIMEOUT_MS } from '../../../database';
import { sql } from 'bun';
import { uuidv7 } from '../../../utils/uuid';

// Test configuration - scaled down for reliability, increase via env vars for stress testing
const LARGE_RECORD_COUNT = parseInt(process.env.STRESS_LARGE_COUNT || '5000', 10);
const CONCURRENT_OPERATIONS = parseInt(process.env.STRESS_CONCURRENT || '10', 10);
const BATCH_SIZE = Math.min(1000, Math.floor(LARGE_RECORD_COUNT / 5));

describe('Timeout Investigation - Insert Operations', () => {
    const seeder = new DataSeeder();
    let entityIds: string[] = [];

    beforeAll(async () => {
        await ensureComponentsRegistered(StressUser, StressProfile);
        await new Promise(resolve => setTimeout(resolve, 2000));
    });

    afterAll(async () => {
        if (entityIds.length > 0) {
            await seeder.cleanup(entityIds, BATCH_SIZE);
        }
    });

    test('bulk insert via Entity.save() - potential timeout scenario', async () => {
        const startTime = performance.now();
        const errors: string[] = [];
        const batchCount = 100;

        console.log(`  Creating ${batchCount} entities via Entity.save()...`);

        const savePromises: Promise<boolean>[] = [];
        for (let i = 0; i < batchCount; i++) {
            const entity = Entity.Create();
            entity.add(StressUser, {
                name: `Bulk User ${i}`,
                email: `bulk${i}@test.com`,
                age: 25 + (i % 50),
                status: 'active',
                score: Math.random() * 1000,
                createdAt: new Date()
            });
            entityIds.push(entity.id);
            savePromises.push(
                entity.save().catch(err => {
                    errors.push(`Entity ${i}: ${err.message}`);
                    return false;
                })
            );
        }

        const results = await Promise.all(savePromises);
        const successCount = results.filter(r => r === true).length;
        const elapsed = performance.now() - startTime;

        console.log(`    Completed: ${successCount}/${batchCount} in ${elapsed.toFixed(0)}ms`);
        if (errors.length > 0) {
            console.log(`    Errors (first 5):`, errors.slice(0, 5));
        }

        expect(errors.length).toBe(0);
        expect(successCount).toBe(batchCount);
    });

    test('concurrent Entity.save() - connection pool exhaustion', async () => {
        const concurrency = CONCURRENT_OPERATIONS;
        const startTime = performance.now();
        const errors: string[] = [];
        const timings: number[] = [];

        console.log(`  Running ${concurrency} concurrent Entity.save() operations...`);

        const savePromises: Promise<void>[] = [];
        for (let i = 0; i < concurrency; i++) {
            const opStart = performance.now();
            const entity = Entity.Create();
            entity.add(StressUser, {
                name: `Concurrent User ${i}`,
                email: `concurrent${i}@test.com`,
                age: 30,
                status: 'pending',
                score: i * 10,
                createdAt: new Date()
            });
            entityIds.push(entity.id);

            savePromises.push(
                entity.save()
                    .then(() => {
                        timings.push(performance.now() - opStart);
                    })
                    .catch(err => {
                        errors.push(`Op ${i}: ${err.message}`);
                    })
            );
        }

        await Promise.all(savePromises);
        const elapsed = performance.now() - startTime;

        const sortedTimings = [...timings].sort((a, b) => a - b);
        const p50 = sortedTimings[Math.floor(timings.length / 2)] || 0;
        const p95 = sortedTimings[Math.floor(timings.length * 0.95)] || 0;
        const max = sortedTimings[timings.length - 1] || 0;

        console.log(`    Total time: ${elapsed.toFixed(0)}ms`);
        console.log(`    Latencies: p50=${p50.toFixed(0)}ms, p95=${p95.toFixed(0)}ms, max=${max.toFixed(0)}ms`);
        console.log(`    Errors: ${errors.length}`);

        if (errors.length > 0) {
            console.log(`    Error samples:`, errors.slice(0, 3));
        }

        expect(errors.length).toBe(0);
    });

    test('large batch seeding - stress database connections', async () => {
        const recordCount = Math.min(LARGE_RECORD_COUNT, 10000);
        console.log(`  Seeding ${recordCount} records via bulk insert...`);

        const startTime = performance.now();
        let hasError = false;
        let errorMsg = '';

        try {
            const result = await seeder.seed(
                StressUser,
                (i) => ({
                    name: `Stress Test User ${i}`,
                    email: `stress${i}@test.com`,
                    age: 20 + (i % 60),
                    status: ['active', 'inactive', 'pending'][i % 3],
                    score: Math.random() * 1000,
                    createdAt: new Date()
                }),
                {
                    totalEntities: recordCount,
                    batchSize: BATCH_SIZE,
                    onProgress: (current, total, elapsed) => {
                        if (current % 5000 === 0) {
                            console.log(`    Progress: ${current}/${total} (${(elapsed / 1000).toFixed(1)}s)`);
                        }
                    }
                }
            );

            entityIds = [...entityIds, ...result.entityIds];
            console.log(`    Completed in ${(result.totalTime / 1000).toFixed(1)}s (${result.recordsPerSecond.toFixed(0)} records/sec)`);
        } catch (err: any) {
            hasError = true;
            errorMsg = err.message;
            console.log(`    ERROR: ${errorMsg}`);
        }

        expect(hasError).toBe(false);
    });
});

describe('Timeout Investigation - Query Operations', () => {
    const seeder = new DataSeeder();
    const benchmark = new BenchmarkRunner();
    let entityIds: string[] = [];
    let isSetup = false;

    beforeAll(async () => {
        await ensureComponentsRegistered(StressUser, StressProfile);
        await new Promise(resolve => setTimeout(resolve, 2000));

        const recordCount = Math.min(LARGE_RECORD_COUNT, 20000);
        console.log(`\n  Setting up ${recordCount} records for query tests...`);

        const result = await seeder.seed(
            StressUser,
            (i) => ({
                name: `Query Test User ${i}`,
                email: `query${i}@test.com`,
                age: 18 + (i % 62),
                status: ['active', 'inactive', 'pending', 'banned'][i % 4],
                score: Math.random() * 10000,
                createdAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000)
            }),
            {
                totalEntities: recordCount,
                batchSize: BATCH_SIZE
            }
        );

        entityIds = result.entityIds;
        await seeder.optimize();
        isSetup = true;
        console.log(`  Setup complete: ${entityIds.length} records\n`);
    });

    afterAll(async () => {
        if (entityIds.length > 0) {
            console.log('\n  Cleaning up query test data...');
            await seeder.cleanup(entityIds, BATCH_SIZE);
        }
    });

    test('concurrent query operations - potential timeout', async () => {
        if (!isSetup) return;

        const concurrency = CONCURRENT_OPERATIONS;
        const errors: string[] = [];
        const timings: number[] = [];

        console.log(`  Running ${concurrency} concurrent queries...`);
        const startTime = performance.now();

        const queryPromises = Array(concurrency).fill(null).map(async (_, i) => {
            const opStart = performance.now();
            try {
                await new Query()
                    .with(StressUser, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: ['active', 'inactive', 'pending', 'banned'][i % 4] }]
                    })
                    .take(100)
                    .exec();
                timings.push(performance.now() - opStart);
            } catch (err: any) {
                errors.push(`Query ${i}: ${err.message}`);
            }
        });

        await Promise.all(queryPromises);
        const elapsed = performance.now() - startTime;

        const sortedTimings = [...timings].sort((a, b) => a - b);
        const p50 = sortedTimings[Math.floor(timings.length / 2)] || 0;
        const p95 = sortedTimings[Math.floor(timings.length * 0.95)] || 0;
        const max = sortedTimings[timings.length - 1] || 0;

        console.log(`    Total time: ${elapsed.toFixed(0)}ms`);
        console.log(`    Latencies: p50=${p50.toFixed(0)}ms, p95=${p95.toFixed(0)}ms, max=${max.toFixed(0)}ms`);
        console.log(`    Errors: ${errors.length}`);

        if (errors.length > 0) {
            console.log(`    Error samples:`, errors.slice(0, 3));
        }

        // Check for timeout-related errors
        const timeoutErrors = errors.filter(e => e.toLowerCase().includes('timeout'));
        if (timeoutErrors.length > 0) {
            console.log(`    TIMEOUT ERRORS DETECTED: ${timeoutErrors.length}`);
        }

        expect(errors.length).toBe(0);
    });

    test('mixed read/write concurrent operations', async () => {
        if (!isSetup) return;

        const opsPerType = Math.floor(CONCURRENT_OPERATIONS / 2);
        const errors: { type: string; message: string }[] = [];
        const readTimings: number[] = [];
        const writeTimings: number[] = [];
        const newEntityIds: string[] = [];

        console.log(`  Running mixed operations: ${opsPerType} reads + ${opsPerType} writes...`);
        const startTime = performance.now();

        // Create read operations
        const readOps = Array(opsPerType).fill(null).map(async (_, i) => {
            const opStart = performance.now();
            try {
                await new Query()
                    .with(StressUser, {
                        filters: [{ field: 'age', operator: FilterOp.GTE, value: 20 + (i % 40) }]
                    })
                    .sortBy(StressUser, 'score', 'DESC')
                    .take(50)
                    .exec();
                readTimings.push(performance.now() - opStart);
            } catch (err: any) {
                errors.push({ type: 'read', message: err.message });
            }
        });

        // Create write operations
        const writeOps = Array(opsPerType).fill(null).map(async (_, i) => {
            const opStart = performance.now();
            try {
                const entity = Entity.Create();
                entity.add(StressUser, {
                    name: `Mixed Op User ${i}`,
                    email: `mixed${i}@test.com`,
                    age: 25,
                    status: 'active',
                    score: i * 100,
                    createdAt: new Date()
                });
                newEntityIds.push(entity.id);
                await entity.save();
                writeTimings.push(performance.now() - opStart);
            } catch (err: any) {
                errors.push({ type: 'write', message: err.message });
            }
        });

        await Promise.all([...readOps, ...writeOps]);
        const elapsed = performance.now() - startTime;

        // Add new entity IDs to cleanup list
        entityIds = [...entityIds, ...newEntityIds];

        const readP95 = [...readTimings].sort((a, b) => a - b)[Math.floor(readTimings.length * 0.95)] || 0;
        const writeP95 = [...writeTimings].sort((a, b) => a - b)[Math.floor(writeTimings.length * 0.95)] || 0;

        console.log(`    Total time: ${elapsed.toFixed(0)}ms`);
        console.log(`    Read p95: ${readP95.toFixed(0)}ms, Write p95: ${writeP95.toFixed(0)}ms`);
        console.log(`    Errors: ${errors.filter(e => e.type === 'read').length} reads, ${errors.filter(e => e.type === 'write').length} writes`);

        if (errors.length > 0) {
            console.log(`    Error samples:`, errors.slice(0, 3));
        }

        expect(errors.length).toBe(0);
    });

    test('long-running query with complex filters', async () => {
        if (!isSetup) return;

        console.log(`  Running complex query across ${entityIds.length} records...`);
        const startTime = performance.now();
        let hasError = false;
        let errorMsg = '';
        let resultCount = 0;

        try {
            const results = await new Query()
                .with(StressUser, {
                    filters: [
                        { field: 'age', operator: FilterOp.GTE, value: 25 },
                        { field: 'age', operator: FilterOp.LTE, value: 45 },
                        { field: 'status', operator: FilterOp.IN, value: ['active', 'pending'] }
                    ]
                })
                .sortBy(StressUser, 'score', 'DESC')
                .populate()
                .take(500)
                .exec();

            resultCount = results.length;
        } catch (err: any) {
            hasError = true;
            errorMsg = err.message;
        }

        const elapsed = performance.now() - startTime;
        console.log(`    Completed in ${elapsed.toFixed(0)}ms, returned ${resultCount} results`);

        if (hasError) {
            console.log(`    ERROR: ${errorMsg}`);
            // Check if it's a timeout error
            if (errorMsg.toLowerCase().includes('timeout')) {
                console.log(`    TIMEOUT DETECTED - Query exceeded 30 second limit`);
            }
        }

        expect(hasError).toBe(false);
    });

    test('count query on large dataset', async () => {
        if (!isSetup) return;

        console.log(`  Running COUNT query on ${entityIds.length} records...`);
        const startTime = performance.now();
        let hasError = false;
        let errorMsg = '';
        let count = 0;

        try {
            count = await new Query()
                .with(StressUser, {
                    filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                })
                .count();
        } catch (err: any) {
            hasError = true;
            errorMsg = err.message;
        }

        const elapsed = performance.now() - startTime;
        console.log(`    Completed in ${elapsed.toFixed(0)}ms, count=${count}`);

        if (hasError) {
            console.log(`    ERROR: ${errorMsg}`);
        }

        expect(hasError).toBe(false);
    });

    test('sustained concurrent load - connection pool stress', async () => {
        if (!isSetup) return;

        const durationMs = 5000;
        const concurrency = 10;
        const errors: string[] = [];
        const timings: number[] = [];
        let queryCount = 0;

        console.log(`  Running sustained load for ${durationMs}ms with ${concurrency} concurrent workers...`);
        const startTime = performance.now();

        const worker = async () => {
            while (performance.now() - startTime < durationMs) {
                const opStart = performance.now();
                try {
                    await new Query()
                        .with(StressUser)
                        .take(10)
                        .exec();
                    timings.push(performance.now() - opStart);
                    queryCount++;
                } catch (err: any) {
                    errors.push(err.message);
                }
            }
        };

        await Promise.all(Array(concurrency).fill(null).map(() => worker()));
        const elapsed = performance.now() - startTime;

        const sortedTimings = [...timings].sort((a, b) => a - b);
        const p50 = sortedTimings[Math.floor(timings.length / 2)] || 0;
        const p95 = sortedTimings[Math.floor(timings.length * 0.95)] || 0;
        const p99 = sortedTimings[Math.floor(timings.length * 0.99)] || 0;
        const max = sortedTimings[timings.length - 1] || 0;

        const qps = (queryCount / elapsed) * 1000;

        console.log(`    Completed ${queryCount} queries in ${elapsed.toFixed(0)}ms (${qps.toFixed(0)} QPS)`);
        console.log(`    Latencies: p50=${p50.toFixed(0)}ms, p95=${p95.toFixed(0)}ms, p99=${p99.toFixed(0)}ms, max=${max.toFixed(0)}ms`);
        console.log(`    Errors: ${errors.length}`);

        const timeoutErrors = errors.filter(e => e.toLowerCase().includes('timeout'));
        if (timeoutErrors.length > 0) {
            console.log(`    TIMEOUT ERRORS: ${timeoutErrors.length}`);
            console.log(`    Samples:`, timeoutErrors.slice(0, 3));
        }

        // Fail if more than 5% error rate
        const errorRate = errors.length / queryCount;
        expect(errorRate).toBeLessThan(0.05);
    });
});

describe('Timeout Investigation - Database Diagnostics', () => {
    test('connection pool status', async () => {
        console.log('  Checking database connection pool...');
        console.log(`    Configured query timeout: ${QUERY_TIMEOUT_MS}ms`);

        try {
            // Run multiple quick queries to check pool behavior
            const startTime = performance.now();
            const queries = Array(5).fill(null).map(() =>
                db`SELECT 1 as test`
            );
            await Promise.all(queries);
            const elapsed = performance.now() - startTime;

            console.log(`    5 parallel queries completed in ${elapsed.toFixed(0)}ms`);
            expect(elapsed).toBeLessThan(5000);
        } catch (err: any) {
            console.log(`    Connection pool error: ${err.message}`);
            throw err;
        }
    });

    test('statement timeout configuration', async () => {
        console.log('  Checking statement timeout setting...');

        try {
            const result = await db`SHOW statement_timeout`;
            console.log(`    statement_timeout = ${result[0]?.statement_timeout || 'not set'}`);
        } catch (err: any) {
            console.log(`    Could not check statement_timeout: ${err.message}`);
        }
    });

    test('active connections count', async () => {
        console.log('  Checking active connections...');

        try {
            const result = await db.unsafe(`
                SELECT count(*) as active_connections
                FROM pg_stat_activity
                WHERE state = 'active'
            `);
            console.log(`    Active connections: ${result[0]?.active_connections || 0}`);
        } catch (err: any) {
            console.log(`    Could not check connections: ${err.message}`);
        }
    });

    test('framework timeout configuration', async () => {
        console.log('  Framework Timeout Settings:');
        console.log(`    DB_QUERY_TIMEOUT: ${QUERY_TIMEOUT_MS}ms (${QUERY_TIMEOUT_MS / 1000}s)`);
        console.log(`    Applies to: Query.exec(), Query.count(), Entity.save(), etc.`);
        console.log(`    Configure via: DB_QUERY_TIMEOUT environment variable`);
        expect(QUERY_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
