#!/usr/bin/env bun
/**
 * Benchmark runner script.
 *
 * Loads a pre-generated PGlite database and runs benchmarks against it.
 * Sets up the correct environment variables before spawning the test process.
 *
 * Usage:
 *   bun tests/benchmark/scripts/run-benchmarks.ts [tier]
 *   bun tests/benchmark/scripts/run-benchmarks.ts xs
 *   bun tests/benchmark/scripts/run-benchmarks.ts md
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASES_DIR = join(__dirname, '..', 'databases');
const PORT = 54322;

type Tier = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const tier = (process.argv[2] || 'xs') as Tier;
const dbPath = join(DATABASES_DIR, tier);

if (!existsSync(dbPath)) {
    console.error(`Benchmark database for tier '${tier}' not found at ${dbPath}`);
    console.error('\nGenerate it first with:');
    console.error(`  bun tests/benchmark/scripts/generate-db.ts ${tier}`);
    process.exit(1);
}

console.log(`[benchmark] Loading ${tier.toUpperCase()} tier database from ${dbPath}...`);

const pg = new PGlite(dbPath);
await pg.waitReady;

// Verify database has data
const countResult = await pg.query<{ count: string }>('SELECT COUNT(*) as count FROM entities');
const entityCount = parseInt(countResult.rows[0]?.count || '0');

if (entityCount === 0) {
    await pg.close();
    console.error(`Benchmark database for tier '${tier}' is empty.`);
    console.error('Regenerate with:');
    console.error(`  bun tests/benchmark/scripts/generate-db.ts ${tier} --force`);
    process.exit(1);
}

console.log(`[benchmark] Loaded ${entityCount.toLocaleString()} entities`);

const server = new PGLiteSocketServer({ db: pg, port: PORT });
await server.start();
console.log(`[benchmark] Socket server running on port ${PORT}`);

// Spawn the test process with correct env vars set before import
// Use --config to specify benchmark-specific bunfig without the standard preload
const proc = spawn('bun', ['test', '--config', 'tests/benchmark/bunfig.toml', 'tests/benchmark/scenarios/', '--timeout', '300000'], {
    env: {
        ...process.env,
        SKIP_TEST_DB_SETUP: 'true',
        USE_PGLITE: 'true',
        BENCHMARK_TIER: tier,
        // Clear DB_CONNECTION_URL so individual POSTGRES_* vars take precedence
        DB_CONNECTION_URL: '',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: String(PORT),
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'postgres',
        POSTGRES_MAX_CONNECTIONS: '10',
        LOG_LEVEL: 'info',
        // Disable direct partition access since PGlite uses a single components table
        BUNSANE_USE_DIRECT_PARTITION: 'false',
        // Disable LATERAL joins - they don't work correctly with INTERSECT queries
        BUNSANE_USE_LATERAL_JOINS: 'false',
    },
    stdio: 'inherit',
    cwd: join(__dirname, '..', '..', '..'),
});

proc.on('exit', async (code) => {
    console.log('[benchmark] Stopping server...');
    try { await server.stop(); } catch {}
    try { await pg.close(); } catch {}
    process.exit(code ?? 1);
});

proc.on('error', async (err) => {
    console.error('[benchmark] Failed to spawn bun test:', err);
    try { await server.stop(); } catch {}
    try { await pg.close(); } catch {}
    process.exit(1);
});
