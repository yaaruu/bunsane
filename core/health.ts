import db from "../database";
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
    };
}

export interface HealthResult {
    result: HealthResponse;
    httpStatus: number;
}

export interface HealthDeps {
    pingDb: () => Promise<boolean>;
    pingCache: () => Promise<boolean>;
}

const defaultDeps: HealthDeps = {
    pingDb: async () => {
        await db`SELECT 1`;
        return true;
    },
    pingCache: () => CacheManager.getInstance().ping(),
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
    const [database, cache] = await Promise.all([
        checkDatabase(deps.pingDb),
        checkCache(deps.pingCache),
    ]);

    const dbUp = database.status === "up";
    const cacheUp = cache.status === "up";

    let status: HealthResponse["status"];
    let httpStatus: number;

    if (dbUp && cacheUp) {
        status = "ok";
        httpStatus = 200;
    } else if (dbUp && !cacheUp) {
        status = "degraded";
        httpStatus = 200;
    } else {
        status = "unavailable";
        httpStatus = 503;
    }

    return {
        result: {
            status,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks: { database, cache },
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
        return {
            result: {
                status: "unavailable",
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                checks: {
                    database: { status: "unknown", latency_ms: 0 },
                    cache: { status: "unknown", latency_ms: 0 },
                },
            },
            httpStatus: 503,
        };
    }

    return deepHealthCheck(deps);
}
