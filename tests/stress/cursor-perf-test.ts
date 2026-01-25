/**
 * Quick cursor pagination performance test
 * Run with: bun tests/stress/cursor-perf-test.ts
 */

// Load env first
import { file } from 'bun';
const envTestPath = new URL('../../.env.test', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const envFile = file(envTestPath);
if (await envFile.exists()) {
    const envContent = await envFile.text();
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key) {
                const value = valueParts.join('=');
                process.env[key.trim()] = value.trim();
            }
        }
    }
}
process.env.LOG_LEVEL = 'warn';

import { Query } from '../../query/Query';
import db from '../../database';
import { PrepareDatabase, HasValidBaseTable } from '../../database/DatabaseHelper';
import ApplicationLifecycle, { ApplicationPhase } from '../../core/ApplicationLifecycle';
import EntityManager from '../../core/EntityManager';
import { CacheManager } from '../../core/cache';
import { StressUser } from './fixtures/StressTestComponents';
import { ensureComponentsRegistered } from '../utils';

async function init() {
    // Verify database
    await db`SELECT 1`;

    // Ensure tables
    if (!(await HasValidBaseTable())) {
        await PrepareDatabase();
    }

    // Set app ready
    ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
    (EntityManager as any).dbReady = true;

    // Init cache
    CacheManager.getInstance().initialize({
        enabled: true,
        provider: 'memory',
        strategy: 'write-through',
        defaultTTL: 3600000,
        entity: { enabled: true, ttl: 3600000 },
        component: { enabled: true, ttl: 1800000 },
        query: { enabled: false, ttl: 300000, maxSize: 10000 }
    });

    // Ensure StressUser component is registered
    await ensureComponentsRegistered(StressUser);
}

async function main() {
    console.log('Initializing...');
    await init();

    // Get total count
    const count = await new Query().with(StressUser).count();
    console.log(`Total StressUser records: ${count}`);

    if (count < 100) {
        console.log('\nNot enough records for test.');
        console.log('Run: STRESS_RECORD_COUNT=100000 bun test tests/stress --test-name-pattern "indexed"');
        console.log('Then run this script again.');
        process.exit(0);
    }

    const iterations = 10;

    // Test 1: First page with offset 0
    console.log('\n=== Offset-based pagination ===');
    let times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await new Query().with(StressUser).take(100).offset(0).exec();
        times.push(performance.now() - start);
    }
    console.log(`Offset 0:       p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);

    // Test 2: Offset at 50%
    const midOffset = Math.floor(count / 2);
    times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await new Query().with(StressUser).take(100).offset(midOffset).exec();
        times.push(performance.now() - start);
    }
    console.log(`Offset ${midOffset.toLocaleString().padStart(7)}:  p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);

    // Test 3: Offset at 90%
    const deepOffset = Math.floor(count * 0.9);
    times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await new Query().with(StressUser).take(100).offset(deepOffset).exec();
        times.push(performance.now() - start);
    }
    console.log(`Offset ${deepOffset.toLocaleString().padStart(7)}:  p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);

    // Get cursor IDs
    const midResults = await new Query().with(StressUser).take(1).offset(midOffset).exec();
    const midId = midResults[0]?.id;
    const deepResults = await new Query().with(StressUser).take(1).offset(deepOffset).exec();
    const deepId = deepResults[0]?.id;

    if (!midId || !deepId) {
        console.log('Could not get cursor IDs');
        process.exit(1);
    }

    // Cursor tests
    console.log('\n=== Cursor-based pagination ===');

    // First page cursor (page 2)
    const firstPage = await new Query().with(StressUser).take(100).exec();
    const page1LastId = firstPage[firstPage.length - 1]?.id;

    if (page1LastId) {
        times = [];
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            await new Query().with(StressUser).cursor(page1LastId).take(100).exec();
            times.push(performance.now() - start);
        }
        console.log(`Cursor page 2:  p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);
    }

    // Cursor from middle
    times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await new Query().with(StressUser).cursor(midId).take(100).exec();
        times.push(performance.now() - start);
    }
    console.log(`Cursor @ 50%:   p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);

    // Cursor from 90%
    times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await new Query().with(StressUser).cursor(deepId).take(100).exec();
        times.push(performance.now() - start);
    }
    console.log(`Cursor @ 90%:   p50=${percentile(times, 50).toFixed(2)}ms, p95=${percentile(times, 95).toFixed(2)}ms`);

    console.log('\n=== Summary ===');
    console.log('Offset: O(offset) - gets slower as position increases');
    console.log('Cursor: O(1) - consistent speed at any position');

    process.exit(0);
}

function percentile(arr: number[], p: number): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
