/**
 * Loads pre-generated PGlite benchmark databases for running benchmarks.
 *
 * Starts a PGLiteSocketServer connected to the persistent database,
 * allowing the BunSane framework to connect via standard PostgreSQL protocol.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASES_DIR = join(__dirname, '..', 'databases');

export type BenchmarkTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface BenchmarkLoaderOptions {
    tier: BenchmarkTier;
    port?: number;
}

export interface LoadedBenchmark {
    pg: PGlite;
    server: PGLiteSocketServer;
    port: number;
    tier: BenchmarkTier;
    stop: () => Promise<void>;
}

const TIER_ENTITY_COUNTS: Record<BenchmarkTier, number> = {
    xs: 10_000,
    sm: 50_000,
    md: 100_000,
    lg: 500_000,
    xl: 1_000_000
};

/**
 * Load a pre-generated benchmark database and start the socket server.
 *
 * @throws Error if database doesn't exist (prompts to generate)
 */
export async function loadBenchmarkDatabase(options: BenchmarkLoaderOptions): Promise<LoadedBenchmark> {
    const { tier, port = 54321 } = options;
    const dbPath = join(DATABASES_DIR, tier);

    if (!existsSync(dbPath)) {
        throw new Error(
            `Benchmark database for tier '${tier}' not found at ${dbPath}\n\n` +
            `Generate it first with:\n` +
            `  bun tests/benchmark/scripts/generate-db.ts ${tier}\n\n` +
            `Or generate all tiers:\n` +
            `  bun tests/benchmark/scripts/generate-db.ts --all`
        );
    }

    console.log(`[benchmark] Loading ${tier.toUpperCase()} tier database from ${dbPath}...`);

    // Open persistent database (read-only would be ideal but PGlite doesn't support it)
    const pg = new PGlite(dbPath);
    await pg.waitReady;

    // Verify database has data
    const countResult = await pg.query<{ count: string }>('SELECT COUNT(*) as count FROM entities');
    const entityCount = parseInt(countResult.rows[0]?.count || '0');

    if (entityCount === 0) {
        await pg.close();
        throw new Error(
            `Benchmark database for tier '${tier}' exists but is empty.\n` +
            `Regenerate with:\n` +
            `  bun tests/benchmark/scripts/generate-db.ts ${tier} --force`
        );
    }

    console.log(`[benchmark] Loaded ${entityCount.toLocaleString()} entities`);

    // Start socket server
    const server = new PGLiteSocketServer({ db: pg, port });
    await server.start();
    console.log(`[benchmark] Socket server running on port ${port}`);

    const stop = async () => {
        console.log('[benchmark] Stopping server...');
        try { await server.stop(); } catch {}
        try { await pg.close(); } catch {}
    };

    return { pg, server, port, tier, stop };
}

/**
 * Get expected entity count for a tier
 */
export function getTierEntityCount(tier: BenchmarkTier): number {
    return TIER_ENTITY_COUNTS[tier];
}

/**
 * Get tier from environment variable BENCHMARK_TIER
 */
export function getTierFromEnv(): BenchmarkTier {
    const tier = process.env.BENCHMARK_TIER || 'xs';
    if (!['xs', 'sm', 'md', 'lg', 'xl'].includes(tier)) {
        console.warn(`Invalid BENCHMARK_TIER '${tier}', defaulting to 'xs'`);
        return 'xs';
    }
    return tier as BenchmarkTier;
}

/**
 * Get database path for a tier
 */
export function getDatabasePath(tier: BenchmarkTier): string {
    return join(DATABASES_DIR, tier);
}

/**
 * Check if a tier's database exists
 */
export function databaseExists(tier: BenchmarkTier): boolean {
    return existsSync(getDatabasePath(tier));
}

/**
 * Get all available (generated) tiers
 */
export function getAvailableTiers(): BenchmarkTier[] {
    const tiers: BenchmarkTier[] = ['xs', 'sm', 'md', 'lg', 'xl'];
    return tiers.filter(tier => databaseExists(tier));
}
