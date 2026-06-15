import db from "../database";
import { runWithSignal } from "../database/cancellable";
import { CacheManager } from "./cache/CacheManager";

export interface CheckResult {
    status: string;
    latency_ms: number;
}

export interface HealthResponse {
    status: "ok" | "degraded" | "unavailable";
    timestamp: string;
    uptime: number;
    checks: {
        database: CheckResult;
        cache: CheckResult;
        /**
         * Present only when the DB write probe is enabled (default on).
         * Exercises the real `db.transaction()` write path so a wedged write
         * pool — a stuck pooled client or exhausted pool that leaves reads
         * (`SELECT 1`) healthy — fails the liveness check and the orchestrator
         * restarts the container instead of it serving 504s indefinitely.
         */
        database_write?: CheckResult;
    };
}

export interface HealthResult {
    result: HealthResponse;
    httpStatus: number;
}

export interface HealthDeps {
    pingDb: () => Promise<boolean>;
    pingCache: () => Promise<boolean>;
    /**
     * Write-path probe. Optional: when omitted (e.g. tests passing custom
     * deps) the write check is skipped and behavior matches the read-only
     * health check. `defaultDeps` supplies the real probe.
     */
    pingDbWrite?: () => Promise<boolean>;
}

// Independent, short timeout for the write probe so a wedged write path is
// caught fast (and the container restarted) rather than blocking on the 30s
// request/save timeout. Configurable via DB_HEALTH_WRITE_TIMEOUT.
const WRITE_PROBE_TIMEOUT_MS = parseInt(process.env.DB_HEALTH_WRITE_TIMEOUT ?? "5000", 10);

function writeProbeDisabled(): boolean {
    return process.env.HEALTH_DB_WRITE_PROBE === "false";
}

/**
 * Exercises a genuine write through the same `db.transaction()` acquisition
 * path `Entity.save` uses. A wedged write pool (stuck pooled client, pool
 * exhausted by leaked transactions) hangs here while `SELECT 1` stays healthy
 * on any idle read connection — exactly the false-healthy scenario that kept a
 * timed-out container "healthy" and unrestarted.
 *
 * The whole transaction is raced against an independent timeout so even a hang
 * during connection *acquisition* (which runWithSignal alone cannot interrupt,
 * since it only wraps in-flight queries) is caught. The temp table is dropped
 * at COMMIT, so the probe has no persistent side effect.
 */
async function probeDbWrite(): Promise<boolean> {
    const timeoutMs = WRITE_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        handle = setTimeout(() => {
            const err = new Error(`DB write health probe timeout after ${timeoutMs}ms`);
            controller.abort(err);
            reject(err);
        }, timeoutMs);
        (handle as any).unref?.();
    });

    const txn = db.transaction(async (trx) => {
        await runWithSignal(
            trx`CREATE TEMP TABLE IF NOT EXISTS _bunsane_health_write (probed_at timestamptz NOT NULL) ON COMMIT DROP`,
            controller.signal,
        );
        await runWithSignal(
            trx`INSERT INTO _bunsane_health_write (probed_at) VALUES (now())`,
            controller.signal,
        );
    });

    try {
        await Promise.race([txn, timeoutPromise]);
        return true;
    } finally {
        if (handle) clearTimeout(handle);
        // Abort any in-flight query so the transaction rolls back and the
        // pooled connection is released even when the timeout won the race.
        if (!controller.signal.aborted) controller.abort();
        // Swallow a late transaction settle after a lost race so it cannot
        // surface as an unhandled rejection.
        Promise.resolve(txn).catch(() => { /* ignore post-timeout settle */ });
    }
}

const defaultDeps: HealthDeps = {
    pingDb: async () => {
        await db`SELECT 1`;
        return true;
    },
    pingCache: () => CacheManager.getInstance().ping(),
    pingDbWrite: probeDbWrite,
};

async function checkDatabase(pingDb: () => Promise<boolean>): Promise<CheckResult> {
    const start = performance.now();
    try {
        await pingDb();
        return { status: "up", latency_ms: Math.round(performance.now() - start) };
    } catch {
        return { status: "down", latency_ms: Math.round(performance.now() - start) };
    }
}

async function checkCache(pingCache: () => Promise<boolean>): Promise<CheckResult> {
    const start = performance.now();
    try {
        const ok = await pingCache();
        return { status: ok ? "up" : "down", latency_ms: Math.round(performance.now() - start) };
    } catch {
        return { status: "down", latency_ms: Math.round(performance.now() - start) };
    }
}

export async function deepHealthCheck(deps: HealthDeps = defaultDeps): Promise<HealthResult> {
    const runWrite = !!deps.pingDbWrite && !writeProbeDisabled();

    const [database, cache, databaseWrite] = await Promise.all([
        checkDatabase(deps.pingDb),
        checkCache(deps.pingCache),
        runWrite ? checkDatabase(deps.pingDbWrite!) : Promise.resolve(undefined),
    ]);

    const dbUp = database.status === "up";
    const writeUp = !databaseWrite || databaseWrite.status === "up";
    const cacheUp = cache.status === "up";

    let status: HealthResponse["status"];
    let httpStatus: number;

    if (dbUp && writeUp && cacheUp) {
        status = "ok";
        httpStatus = 200;
    } else if (dbUp && writeUp && !cacheUp) {
        status = "degraded";
        httpStatus = 200;
    } else {
        // DB read OR write down → unavailable. A wedged write path (reads fine,
        // writes hang) lands here so liveness fails and the container restarts.
        status = "unavailable";
        httpStatus = 503;
    }

    return {
        result: {
            status,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks: {
                database,
                cache,
                ...(databaseWrite ? { database_write: databaseWrite } : {}),
            },
        },
        httpStatus,
    };
}

export async function readinessCheck(
    isReady: boolean,
    isShuttingDown: boolean,
    deps: HealthDeps = defaultDeps,
): Promise<HealthResult> {
    if (!isReady || isShuttingDown) {
        const includeWrite = !!deps.pingDbWrite && !writeProbeDisabled();
        return {
            result: {
                status: "unavailable",
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                checks: {
                    database: { status: "unknown", latency_ms: 0 },
                    cache: { status: "unknown", latency_ms: 0 },
                    ...(includeWrite
                        ? { database_write: { status: "unknown", latency_ms: 0 } }
                        : {}),
                },
            },
            httpStatus: 503,
        };
    }

    return deepHealthCheck(deps);
}
