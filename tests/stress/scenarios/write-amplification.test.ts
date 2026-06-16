/**
 * Write-Amplification A/B Stress Test
 *
 * Measures the read AND write impact of the whole-`data` GIN index
 * (`idx_components_data_gin`) and the batched-upsert save path. Runs the same
 * read + write workload twice — once with the GIN present, once without — and
 * prints a side-by-side comparison so the trade-off is empirical, not assumed.
 *
 * Hypothesis under test:
 *   - Dropping the whole-data GIN INCREASES write throughput (less index
 *     maintenance + HOT-update eligibility) ...
 *   - ... with NO read regression, because the Query layer serves filters/sorts
 *     from per-field indexes, never from the whole-data GIN.
 *
 * Run:
 *   bun run test:pglite -- tests/stress/scenarios/write-amplification.test.ts
 *   STRESS_ENTITY_COUNT=50000 STRESS_WRITE_OPS=2000 bun run test:stress
 *
 * NOTE: This test toggles `idx_components_data_gin` directly via DDL to A/B it
 * within a single run. It does not depend on BUNSANE_COMPONENTS_DATA_GIN; that
 * env only controls whether the index is created at startup.
 */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import db from '../../../database';
import { DataSeeder } from '../DataSeeder';
import { BenchmarkRunner, type BenchmarkResult } from '../BenchmarkRunner';
import { Query, FilterOp } from '../../../query/Query';
import { Entity } from '../../../core/Entity';
import { StressUser, StressProfile } from '../fixtures/StressTestComponents';
import { ensureComponentsRegistered } from '../../utils';

const ENTITY_COUNT = parseInt(process.env.STRESS_ENTITY_COUNT || '2000', 10);
const WRITE_OPS = Math.min(parseInt(process.env.STRESS_WRITE_OPS || '500', 10), ENTITY_COUNT);
const BATCH_SIZE = Math.min(500, Math.floor(ENTITY_COUNT / 10) || 100);
const READ_ITERS = parseInt(process.env.STRESS_READ_ITERS || '10', 10);

const STATUSES = ['active', 'inactive', 'pending', 'suspended'];

function genUser(i: number): Record<string, any> {
    return {
        name: `User ${i}`,
        email: `user${i}@example.com`,
        age: 18 + (i % 60),
        status: STATUSES[i % STATUSES.length],
        score: Math.floor(Math.random() * 10000),
        createdAt: new Date(Date.now() - (i % 365) * 86400000),
    };
}

function genProfile(i: number): Record<string, any> {
    return {
        bio: `Bio for user ${i} - lorem ipsum dolor sit amet.`,
        avatarUrl: `https://cdn.example.com/avatars/${i}.png`,
        verified: i % 3 === 0,
    };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

interface WriteResult {
    opsPerSec: number;
    p50: number;
    p95: number;
    count: number;
    errors: number;
}

/** Update StressProfile.bio (an UNINDEXED field) on the first WRITE_OPS
 *  entities via Entity.save — isolates the whole-data GIN's write cost, since
 *  no per-field index covers `bio`. Exercises the batched-upsert save path. */
async function measureWrites(entityIds: string[]): Promise<WriteResult> {
    const latencies: number[] = [];
    let errors = 0;
    const targets = entityIds.slice(0, WRITE_OPS);
    const start = performance.now();
    for (let i = 0; i < targets.length; i++) {
        const id = targets[i]!;
        const t0 = performance.now();
        try {
            const e = await Entity.FindById(id);
            if (!e) { errors++; continue; }
            await e.set(StressProfile, { bio: `rev-${i}-${Math.random().toString(36).slice(2)}` });
            await e.save();
            latencies.push(performance.now() - t0);
        } catch {
            errors++;
        }
    }
    const total = performance.now() - start;
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
        opsPerSec: (latencies.length / total) * 1000,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        count: latencies.length,
        errors,
    };
}

async function setGinIndex(enabled: boolean): Promise<void> {
    try {
        if (enabled) {
            await db.unsafe('CREATE INDEX IF NOT EXISTS idx_components_data_gin ON components USING GIN (data)');
        } else {
            await db.unsafe('DROP INDEX IF EXISTS idx_components_data_gin');
        }
    } catch (err) {
        console.warn(`  [warn] GIN toggle (enabled=${enabled}) failed: ${err}`);
    }
}

describe('Write Amplification A/B (whole-data GIN on vs off)', () => {
    const seeder = new DataSeeder();
    const benchmark = new BenchmarkRunner();
    let entityIds: string[] = [];

    const readWorkload = {
        'filter status (btree)': () => new Query()
            .with(StressUser, { filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }] })
            .take(100).exec(),
        'filter score range (numeric)': () => new Query()
            .with(StressUser, { filters: [{ field: 'score', operator: FilterOp.GTE, value: 5000 }] })
            .take(100).exec(),
        'sort by score desc': () => new Query()
            .with(StressUser).sortBy(StressUser, 'score', 'DESC').take(100).exec(),
    };

    async function runReads(phase: string): Promise<Record<string, BenchmarkResult>> {
        const out: Record<string, BenchmarkResult> = {};
        for (const [name, fn] of Object.entries(readWorkload)) {
            out[name] = await benchmark.run(`${phase} :: ${name}`, fn, {
                iterations: READ_ITERS, warmupIterations: 2, collectMemory: false,
            });
        }
        return out;
    }

    beforeAll(async () => {
        console.log(`\n  Registering components...`);
        await ensureComponentsRegistered(StressUser, StressProfile);
        await new Promise(r => setTimeout(r, 1500));

        console.log(`  Seeding ${ENTITY_COUNT.toLocaleString()} entities (StressUser + StressProfile)...`);
        const res = await seeder.seed(StressUser, genUser, { totalEntities: ENTITY_COUNT, batchSize: BATCH_SIZE });
        entityIds = res.entityIds;
        await seeder.seedAdditionalComponent(entityIds, StressProfile, (i) => genProfile(i), BATCH_SIZE);
        await seeder.optimize();
        console.log(`  Seeded at ${res.recordsPerSecond.toFixed(0)} entities/sec\n`);
    }, 180000);

    afterAll(async () => {
        // Restore default (index absent — matches BUNSANE_COMPONENTS_DATA_GIN default off).
        await setGinIndex(false);
        console.log('\n  Cleaning up...');
        await seeder.cleanup(entityIds, BATCH_SIZE);
        console.log('  Done.');
    }, 120000);

    test('A/B: GIN present vs absent — reads must not regress, writes should improve', async () => {
        // Phase A: GIN PRESENT
        await setGinIndex(true);
        await seeder.optimize();
        const readsOn = await runReads('GIN=on');
        const writesOn = await measureWrites(entityIds);

        // Phase B: GIN ABSENT
        await setGinIndex(false);
        await seeder.optimize();
        const readsOff = await runReads('GIN=off');
        const writesOff = await measureWrites(entityIds);

        // ---- Report ----
        console.log('\n  ================ WRITE THROUGHPUT ================');
        console.log(`  GIN=on : ${writesOn.opsPerSec.toFixed(0)} ops/s  p50=${writesOn.p50.toFixed(2)}ms  p95=${writesOn.p95.toFixed(2)}ms  (n=${writesOn.count}, err=${writesOn.errors})`);
        console.log(`  GIN=off: ${writesOff.opsPerSec.toFixed(0)} ops/s  p50=${writesOff.p50.toFixed(2)}ms  p95=${writesOff.p95.toFixed(2)}ms  (n=${writesOff.count}, err=${writesOff.errors})`);
        const writeGain = ((writesOff.opsPerSec - writesOn.opsPerSec) / (writesOn.opsPerSec || 1)) * 100;
        console.log(`  -> write throughput change (off vs on): ${writeGain >= 0 ? '+' : ''}${writeGain.toFixed(1)}%`);

        console.log('\n  ================ READ LATENCY (p95 ms) ================');
        for (const name of Object.keys(readWorkload)) {
            const on = readsOn[name]!.timings.p95;
            const off = readsOff[name]!.timings.p95;
            const delta = ((off - on) / (on || 1)) * 100;
            console.log(`  ${name.padEnd(32)} on=${on.toFixed(2)}  off=${off.toFixed(2)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
        }
        console.log('  ======================================================\n');

        // Sanity: workload actually ran in both phases.
        expect(writesOn.count).toBeGreaterThan(0);
        expect(writesOff.count).toBeGreaterThan(0);
        for (const name of Object.keys(readWorkload)) {
            expect(readsOn[name]!.rowsReturned).toBeGreaterThan(0);
            expect(readsOff[name]!.rowsReturned).toBeGreaterThan(0);
        }
        // No catastrophic read regression from dropping the GIN. Generous
        // tolerance (5x) absorbs timing noise on small datasets; the printed
        // table is the real signal. Per-field indexes serve these reads, so we
        // expect parity — this guards against an accidental dependency on the
        // whole-data GIN sneaking into the query planner path.
        for (const name of Object.keys(readWorkload)) {
            const on = readsOn[name]!.timings.p95 || 1;
            const off = readsOff[name]!.timings.p95;
            expect(off).toBeLessThanOrEqual(on * 5 + 50);
        }
    }, 300000);
});
