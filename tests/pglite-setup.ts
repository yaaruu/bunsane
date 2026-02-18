/**
 * PGlite wrapper script for zero-infrastructure testing.
 *
 * Starts an in-memory PostgreSQL via PGlite Socket, then spawns
 * `bun test` with the correct env vars already set at the process level.
 * This avoids all preload ordering issues.
 *
 * Usage:
 *   bun tests/pglite-setup.ts [test-dirs...]
 *   bun tests/pglite-setup.ts tests/unit/
 *   bun tests/pglite-setup.ts tests/unit tests/integration tests/graphql
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'child_process';

const PORT = 54321;

console.log('[pglite] Starting in-memory PostgreSQL...');
const pg = new PGlite();
await pg.waitReady;

const server = new PGLiteSocketServer({ db: pg, port: PORT });
await server.start();
console.log(`[pglite] Socket server running on port ${PORT}`);

// Test dirs from CLI args, default to unit + integration + graphql
const testDirs = process.argv.slice(2);
if (testDirs.length === 0) {
    testDirs.push('tests/unit', 'tests/integration', 'tests/graphql');
}

const proc = spawn('bun', ['test', ...testDirs], {
    env: {
        ...process.env,
        USE_PGLITE: 'true',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: String(PORT),
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'postgres',
        POSTGRES_MAX_CONNECTIONS: '1',
    },
    stdio: 'inherit',
    cwd: process.cwd(),
});

proc.on('exit', async (code) => {
    console.log('[pglite] Stopping server...');
    try { await server.stop(); } catch {}
    try { await pg.close(); } catch {}
    process.exit(code ?? 1);
});

proc.on('error', async (err) => {
    console.error('[pglite] Failed to spawn bun test:', err);
    try { await server.stop(); } catch {}
    try { await pg.close(); } catch {}
    process.exit(1);
});
