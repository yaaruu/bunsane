import type { SQL } from "bun";
import { logger as MainLogger } from "../core/Logger";
import { runWithSignal } from "./cancellable";

const logger = MainLogger.child({ scope: "db" });

const SLOW_MS = parseInt(process.env.BUNSANE_DB_SLOW_MS ?? '500', 10);

export type DataLoaderKind = 'entity' | 'component' | 'relation';

interface DbStatsInternal {
    totalCount: number;
    totalMs: number;
    maxMs: number;
    slowCount: number;
    abortedCount: number;
    inFlight: number;
    inFlightMax: number;
    dataLoaderCalls: { entity: number; component: number; relation: number };
}

const stats: DbStatsInternal = {
    totalCount: 0,
    totalMs: 0,
    maxMs: 0,
    slowCount: 0,
    abortedCount: 0,
    inFlight: 0,
    inFlightMax: 0,
    dataLoaderCalls: { entity: 0, component: 0, relation: 0 },
};

/**
 * Per-request counter incremented when current request context is reachable
 * via the (request as any).__bunsaneStats pointer. We accept that as a
 * parameter from the call site so this module stays free of GraphQL imports.
 */
export interface PerRequestCounters {
    dbQueryCount: number;
}

/**
 * Execute `db.unsafe(sql, params)` with optional AbortSignal cancellation
 * and roundtrip telemetry. On abort the in-flight query is cancelled via
 * `Query.cancel()`. Total ms is recorded into module-level stats; calls
 * over `BUNSANE_DB_SLOW_MS` increment slowCount and emit a warn log.
 */
export async function timedUnsafe<T = any>(
    db: SQL,
    sql: string,
    params: any[],
    signal?: AbortSignal,
    perRequest?: PerRequestCounters,
): Promise<T> {
    const t0 = performance.now();
    stats.inFlight++;
    if (stats.inFlight > stats.inFlightMax) stats.inFlightMax = stats.inFlight;
    if (perRequest) perRequest.dbQueryCount++;
    let aborted = false;
    try {
        const q = (db as any).unsafe(sql, params);
        return await runWithSignal<T>(q, signal);
    } catch (err) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) {
            aborted = true;
            stats.abortedCount++;
        }
        throw err;
    } finally {
        const dt = performance.now() - t0;
        stats.inFlight--;
        stats.totalCount++;
        stats.totalMs += dt;
        if (dt > stats.maxMs) stats.maxMs = dt;
        if (SLOW_MS > 0 && dt > SLOW_MS && !aborted) {
            stats.slowCount++;
            logger.warn(
                {
                    durationMs: Math.round(dt),
                    thresholdMs: SLOW_MS,
                    sqlSnippet: sql.length > 200 ? sql.slice(0, 200) + '…' : sql,
                    msg: 'Slow DB call',
                },
                'Slow DB call',
            );
        }
    }
}

/**
 * Increment the per-kind DataLoader counter. Called from inside DataLoader
 * batch functions so /metrics + access log can attribute load patterns.
 *
 * `perRequest` is loosely typed because RequestContext's `RequestStats`
 * (defined in core/RequestContext.ts) extends `PerRequestCounters` with
 * extra fields like `dataLoaderCalls`. We accept either shape here without
 * importing the higher-level type (which would create a cycle).
 */
export function incrementDataLoaderCall(
    kind: DataLoaderKind,
    perRequest?: PerRequestCounters | { dataLoaderCalls?: { entity: number; component: number; relation: number } },
): void {
    stats.dataLoaderCalls[kind]++;
    const dlc = (perRequest as any)?.dataLoaderCalls;
    if (dlc) dlc[kind]++;
}

/**
 * Snapshot of accumulated DB stats for the /metrics endpoint.
 */
export function getDbStats() {
    const avgMs = stats.totalCount > 0 ? stats.totalMs / stats.totalCount : 0;
    return {
        totalCount: stats.totalCount,
        totalMs: Math.round(stats.totalMs),
        maxMs: Math.round(stats.maxMs),
        avgMs: Number(avgMs.toFixed(2)),
        slowCount: stats.slowCount,
        abortedCount: stats.abortedCount,
        inFlight: stats.inFlight,
        inFlightMax: stats.inFlightMax,
        slowThresholdMs: SLOW_MS,
        dataLoaderCalls: { ...stats.dataLoaderCalls },
    };
}

/**
 * Reset counters. Intended for tests only.
 */
export function resetDbStats(): void {
    stats.totalCount = 0;
    stats.totalMs = 0;
    stats.maxMs = 0;
    stats.slowCount = 0;
    stats.abortedCount = 0;
    stats.inFlight = 0;
    stats.inFlightMax = 0;
    stats.dataLoaderCalls.entity = 0;
    stats.dataLoaderCalls.component = 0;
    stats.dataLoaderCalls.relation = 0;
}
