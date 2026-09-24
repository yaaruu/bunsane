import db from "../../database";
import { CacheManager } from "../cache/CacheManager";
import { deepHealthCheck, readinessCheck, type HealthResponse, type HealthResult } from "../health";

type Cached = { at: number; key: string; value: HealthResult };

let livenessCache: Cached | null = null;
let readinessCache: Cached | null = null;
let livenessInflight: Promise<HealthResult> | null = null;
let readinessInflight: Promise<HealthResult> | null = null;
let tokens = 0;
let lastRefill = 0;
let configuredMax = -1;

function maxRps(): number {
    const n = parseInt(process.env.BUNSANE_HEALTH_MAX_RPS ?? "20", 10);
    return Number.isFinite(n) && n >= 0 ? n : 20;
}

function cacheMs(): number {
    const n = parseInt(process.env.BUNSANE_HEALTH_CACHE_MS ?? "5000", 10);
    return Number.isFinite(n) && n >= 0 ? n : 5000;
}

/** 0 disables the limiter (every probe is admitted). */
export function takeHealthPermit(now = Date.now()): boolean {
    const max = maxRps();
    if (max === 0) return true;
    if (configuredMax !== max) {
        configuredMax = max;
        tokens = max;
        lastRefill = now;
    }
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
        tokens = Math.min(max, tokens + (elapsed / 1000) * max);
        lastRefill = now;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
}

export function resetHealthGateForTests(): void {
    livenessCache = null;
    readinessCache = null;
    livenessInflight = null;
    readinessInflight = null;
    tokens = 0;
    lastRefill = 0;
    configuredMax = -1;
}

function probeMode(): "read" | "write" {
    return process.env.BUNSANE_HEALTH_PROBE === "read" ? "read" : "write";
}

async function runLivenessProbe(): Promise<HealthResult> {
    if (probeMode() === "read") {
        return deepHealthCheck({
            pingDb: async () => {
                await db`SELECT 1`;
                return true;
            },
            pingCache: () => CacheManager.getInstance().ping(),
        });
    }
    return deepHealthCheck();
}

async function cachedProbe(
    cache: Cached | null,
    setCache: (value: Cached | null) => void,
    inflight: Promise<HealthResult> | null,
    setInflight: (value: Promise<HealthResult> | null) => void,
    key: string,
    run: () => Promise<HealthResult>,
): Promise<HealthResult> {
    const ttl = cacheMs();
    const now = Date.now();
    if (ttl > 0 && cache && cache.key === key && now - cache.at < ttl) {
        return cache.value;
    }
    if (inflight) return inflight;
    const pending = run().then((value) => {
        if (ttl > 0) setCache({ at: Date.now(), key, value });
        return value;
    }).finally(() => {
        setInflight(null);
    });
    setInflight(pending);
    return pending;
}

function soften(result: HealthResponse): Record<string, unknown> {
    const checks: Record<string, { status: string }> = {};
    for (const [name, check] of Object.entries(result.checks)) {
        if (check && typeof check === "object" && "status" in check) {
            checks[name] = { status: String(check.status) };
        }
    }
    return {
        status: result.status,
        timestamp: result.timestamp,
        checks,
    };
}

function healthResponse(result: HealthResult): Response {
    return new Response(JSON.stringify(soften(result.result)), {
        status: result.httpStatus,
        headers: { "Content-Type": "application/json" },
    });
}

function shed(): Response {
    return new Response(
        JSON.stringify({ error: "Too many requests", code: "HEALTH_RATE_LIMITED" }),
        {
            status: 429,
            headers: {
                "Content-Type": "application/json",
                "Retry-After": "1",
            },
        },
    );
}

export async function handleHealth(_app: unknown): Promise<Response> {
    if (!takeHealthPermit()) return shed();
    const result = await cachedProbe(
        livenessCache,
        (value) => { livenessCache = value; },
        livenessInflight,
        (value) => { livenessInflight = value; },
        probeMode(),
        runLivenessProbe,
    );
    return healthResponse(result);
}

export async function handleReady(app: { isReady: boolean; isShuttingDown: boolean }): Promise<Response> {
    if (!takeHealthPermit()) return shed();
    const key = `${app.isReady}:${app.isShuttingDown}`;
    const result = await cachedProbe(
        readinessCache,
        (value) => { readinessCache = value; },
        readinessInflight,
        (value) => { readinessInflight = value; },
        key,
        () => readinessCheck(app.isReady, app.isShuttingDown),
    );
    return healthResponse(result);
}

export async function handleRemoteHealth(app: { remote: { health(): Promise<{ healthy: boolean }> } | null }): Promise<Response> {
    if (!app.remote) {
        return new Response(
            JSON.stringify({ healthy: false, error: "Remote subsystem not enabled" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
        );
    }
    const health = await app.remote.health();
    return new Response(JSON.stringify(health), {
        status: health.healthy ? 200 : 503,
        headers: { "Content-Type": "application/json" },
    });
}
