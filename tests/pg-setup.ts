/**
 * Real-PostgreSQL test wrapper.
 *
 * PGlite (tests/pglite-setup.ts) is great for zero-infra runs, but it can't
 * exercise behaviours that only exist on a real Postgres server — e.g. the
 * `?|` / `?&` JSONB operators, server-side `CREATE INDEX CONCURRENTLY`, real
 * LIST partitioning, and Bun SQL's parameter binding against a real backend.
 * Bugs in those paths sail past the default PGlite run (see the ?|/?&
 * "malformed array literal" regression).
 *
 * This wrapper provisions an EPHEMERAL scratch database on a real Postgres
 * server, runs `bun test` against it with prepared statements ENABLED (a
 * direct connection — NOT PgBouncer), then drops the scratch DB on exit.
 *
 * Usage:
 *   bun tests/pg-setup.ts [test-dirs...]
 *   bun tests/pg-setup.ts tests/integration/query
 *   bun run test:pg            # unit + integration + graphql
 *   bun run test:pg:integration
 *
 * Configuration (env vars; falls back to keys in .env.test):
 *   PG_TEST_URL    Full connection URL for the (non-superuser) test role on a
 *                  DIRECT Postgres port. The database name in it is ignored —
 *                  a scratch DB is created and substituted. If unset, derived
 *                  from .env.test DB_CONNECTION_URL with the port swapped to
 *                  PG_DIRECT_PORT (so a PgBouncer URL becomes a direct one).
 *   PG_DIRECT_PORT Port of the direct Postgres listener (bypasses PgBouncer).
 *                  Used only when deriving PG_TEST_URL from DB_CONNECTION_URL.
 *                  Usually you should NOT need to set this: when
 *                  BUNSANE_PG_DOCKER_CONTAINER is set, the port is discovered
 *                  from `docker port <container> 5432` on every run. Docker
 *                  reassigns that host port whenever the container is recreated,
 *                  so a value pinned in .env.test goes stale and the run fails
 *                  with ERR_POSTGRES_CONNECTION_REFUSED — which reads like "no
 *                  real Postgres available" and silently costs real coverage.
 *                  Precedence: PG_DIRECT_PORT as a process env var (explicit,
 *                  for this run) > docker discovery > .env.test PG_DIRECT_PORT.
 *   PG_ADMIN_URL   Superuser connection URL (needs CREATEDB) to the `postgres`
 *                  maintenance DB. Used to CREATE/DROP the scratch DB.
 *   BUNSANE_PG_DOCKER_CONTAINER
 *                  If PG_ADMIN_URL is unset, derive superuser creds by reading
 *                  POSTGRES_USER / POSTGRES_PASSWORD from this Docker container
 *                  (e.g. `infra-postgres`), connecting at the test URL host/port.
 */

import { SQL } from 'bun';
import { spawn, execFileSync } from 'child_process';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

// ---- config loading --------------------------------------------------------

/** Parse .env.test into a plain map (does NOT mutate process.env). */
function loadEnvTest(): Record<string, string> {
    const out: Record<string, string> = {};
    const p = join(process.cwd(), '.env.test');
    if (!existsSync(p)) return out;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (k) out[k] = v;
    }
    return out;
}

const envTest = loadEnvTest();
/** env var > .env.test key. */
const cfg = (k: string): string | undefined => process.env[k] ?? envTest[k];

function fail(msg: string): never {
    console.error(`[pg-setup] ${msg}`);
    process.exit(1);
}

// ---- resolve the test-role (direct) connection URL -------------------------

/**
 * Ask Docker which host port currently maps to the container's 5432.
 *
 * Returns undefined (never fails) when Docker or the container is unavailable —
 * the caller falls back to the configured port. Output looks like:
 *   0.0.0.0:54420
 *   [::]:54420
 */
function discoverDockerPort(container: string): string | undefined {
    let out: string;
    try {
        out = execFileSync('docker', ['port', container, '5432'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
    for (const line of out.split(/\r?\n/)) {
        const m = /:(\d+)\s*$/.exec(line.trim());
        if (m) return m[1];
    }
    return undefined;
}

/**
 * Pick the direct-Postgres port, preferring live Docker state over config.
 *
 * The pinned .env.test value is the least trustworthy source: Docker hands out
 * a new host port on every container recreate, so it is stale by default rather
 * than by accident.
 */
function resolveDirectPort(): { port: string | undefined; source: string } {
    const fromProcess = process.env.PG_DIRECT_PORT;
    if (fromProcess) return { port: fromProcess, source: 'PG_DIRECT_PORT env var' };

    const container = cfg('BUNSANE_PG_DOCKER_CONTAINER');
    const discovered = container ? discoverDockerPort(container) : undefined;
    const pinned = envTest['PG_DIRECT_PORT'];

    if (discovered) {
        if (pinned && pinned !== discovered) {
            console.warn(
                `[pg-setup] .env.test PG_DIRECT_PORT=${pinned} is stale — container ` +
                `'${container}' now publishes 5432 on ${discovered}. Using the live value. ` +
                `Update or delete the pinned key to silence this.`
            );
        }
        return { port: discovered, source: `docker port ${container} 5432` };
    }
    if (pinned) return { port: pinned, source: '.env.test PG_DIRECT_PORT' };
    return { port: undefined, source: 'none' };
}

function resolveTestUrl(): URL {
    const explicit = cfg('PG_TEST_URL');
    if (explicit) return new URL(explicit);

    const base = cfg('DB_CONNECTION_URL');
    if (!base) fail('No PG_TEST_URL and no DB_CONNECTION_URL in .env.test to derive from.');
    const u = new URL(base!);
    const { port, source } = resolveDirectPort();
    if (port) {
        u.port = port;
        console.log(`[pg-setup] Direct port ${port} (via ${source}).`);
    } else {
        console.warn(
            '[pg-setup] WARNING: no direct port resolved (no PG_DIRECT_PORT, and Docker ' +
            'discovery unavailable); using DB_CONNECTION_URL port as-is. ' +
            'If this points at PgBouncer (transaction pooling), prepared statements + JSONB ' +
            'object params will FAIL. Set PG_DIRECT_PORT to the direct Postgres port.'
        );
    }
    return u;
}

// ---- resolve the admin (superuser) connection URL --------------------------

function dockerEnv(container: string, key: string): string {
    try {
        return execFileSync('docker', ['exec', container, 'printenv', key], {
            encoding: 'utf8',
        }).trim();
    } catch (e: any) {
        fail(`docker exec ${container} printenv ${key} failed: ${e?.message ?? e}`);
    }
}

function resolveAdminUrl(testUrl: URL): URL {
    const explicit = cfg('PG_ADMIN_URL');
    if (explicit) return new URL(explicit);

    const container = cfg('BUNSANE_PG_DOCKER_CONTAINER');
    if (!container) {
        fail(
            'No PG_ADMIN_URL and no BUNSANE_PG_DOCKER_CONTAINER. ' +
            'Set PG_ADMIN_URL to a superuser connection (CREATEDB) on the maintenance DB, ' +
            'or BUNSANE_PG_DOCKER_CONTAINER to derive superuser creds from a Docker container.'
        );
    }
    const user = dockerEnv(container!, 'POSTGRES_USER');
    const pw = dockerEnv(container!, 'POSTGRES_PASSWORD');
    const admin = new URL(testUrl.toString());
    admin.username = encodeURIComponent(user);
    admin.password = encodeURIComponent(pw);
    admin.pathname = '/postgres';
    return admin;
}

// ---- main ------------------------------------------------------------------

const testUrl = resolveTestUrl();
const adminUrl = resolveAdminUrl(testUrl);
const testRole = decodeURIComponent(testUrl.username);
const scratchName = `bunsane_test_${process.pid}`;

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(scratchName)) {
    fail(`Refusing unsafe scratch DB name: ${scratchName}`);
}

const scratchUrl = new URL(testUrl.toString());
scratchUrl.pathname = `/${scratchName}`;

const redact = (u: URL) => `${u.protocol}//${u.username}:****@${u.host}${u.pathname}`;

async function withAdmin<T>(fn: (db: SQL) => Promise<T>): Promise<T> {
    const db = new SQL(adminUrl.toString(), { prepare: true, max: 1, connectionTimeout: 10 });
    try {
        return await fn(db);
    } finally {
        try { await db.end(); } catch { /* ignore */ }
    }
}

async function createScratch(): Promise<void> {
    await withAdmin(async (db) => {
        await db.unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
            [scratchName]
        );
        await db.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
        await db.unsafe(`CREATE DATABASE ${scratchName} OWNER ${testRole}`);
    });
    console.log(`[pg-setup] Created scratch DB ${redact(scratchUrl)}`);
}

async function dropScratch(): Promise<void> {
    try {
        await withAdmin(async (db) => {
            await db.unsafe(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
                [scratchName]
            );
            await db.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
        });
        console.log(`[pg-setup] Dropped scratch DB ${scratchName}`);
    } catch (e: any) {
        console.warn(`[pg-setup] Failed to drop scratch DB ${scratchName}: ${e?.message ?? e}`);
    }
}

console.log(`[pg-setup] Real Postgres test run — direct connection, prepared statements enabled.`);
console.log(`[pg-setup] Admin: ${redact(adminUrl)}`);

await createScratch();

const testDirs = process.argv.slice(2);
if (testDirs.length === 0) {
    testDirs.push('tests/unit', 'tests/integration', 'tests/graphql');
}

const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DB_CONNECTION_URL: scratchUrl.toString(),
    POSTGRES_HOST: scratchUrl.hostname,
    POSTGRES_PORT: scratchUrl.port || '5432',
    POSTGRES_USER: decodeURIComponent(scratchUrl.username),
    POSTGRES_PASSWORD: decodeURIComponent(scratchUrl.password),
    POSTGRES_DB: scratchName,
};
// Direct connection — prepared statements must stay ON (this is what we're
// validating). Never carry a PgBouncer-oriented DB_DISABLE_PREPARE in here.
delete childEnv.DB_DISABLE_PREPARE;
delete childEnv.USE_PGLITE;

const proc = spawn('bun', ['test', ...testDirs], {
    env: childEnv,
    stdio: 'inherit',
    cwd: process.cwd(),
});

async function shutdown(code: number): Promise<never> {
    await dropScratch();
    process.exit(code);
}

proc.on('exit', (code) => { void shutdown(code ?? 1); });
proc.on('error', async (err) => {
    console.error('[pg-setup] Failed to spawn bun test:', err);
    await shutdown(1);
});

// Drop the scratch DB even if this wrapper is interrupted.
process.on('SIGINT', () => { proc.kill('SIGINT'); });
process.on('SIGTERM', () => { proc.kill('SIGTERM'); });
