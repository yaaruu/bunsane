import type { SQL } from "bun";
import { logger as MainLogger } from "../core/Logger";
import { runWithSignal } from "./cancellable";
import { isPoolAcquisitionError } from "./poolErrors";

const logger = MainLogger.child({ scope: "db" });

const SLOW_MS = parseInt(process.env.BUNSANE_DB_SLOW_MS ?? '500', 10);

export type DataLoaderKind = 'entity' | 'component' | 'relation';

interface DbStatsInternal {
    totalCount: number;
    totalMs: number;
    maxMs: number;
    slowCount: number;
    abortedCount: number;
    poolAcquireFailures: number;
    inFlight: number;
    inFlightMax: number;
    poolMax: number;
    saturatedSince: number;
    dataLoaderCalls: { entity: number; component: number; relation: number };
}

const stats: DbStatsInternal = {
    totalCount: 0,
    totalMs: 0,
    maxMs: 0,
    slowCount: 0,
    abortedCount: 0,
    poolAcquireFailures: 0,
    inFlight: 0,
    inFlightMax: 0,
    poolMax: 0,
    saturatedSince: 0,
    dataLoaderCalls: { entity: 0, component: 0, relation: 0 },
};

/**
 * Record the pool's configured size so saturation is expressed against a
 * denominator instead of an unlabelled number. Called from `createDatabase()`.
 *
 * Clears the saturation clock, because a new pool has no history. Note that
 * `resetDatabase()` also goes through `createDatabase()` (benchmarks use it), so
 * saturation is NOT monotonic across a pool rebuild — it restarts from zero.
 */
export function setPoolMax(max: number): void {
    stats.poolMax = Number.isFinite(max) && max > 0 ? max : 0;
    stats.saturatedSince = 0;
}

/**
 * How long the pool has been continuously saturated, in ms (0 = not saturated).
 *
 * `inFlight` counts calls that go through this module, which today is a SUBSET
 * of the framework's DB traffic (the tagged-template paths in
 * `core/entity/*`, `core/BatchLoader.ts` and most of `database/`,
 * `database/projection/*` and `endpoints/*` bypass it). So this is a LOWER
 * BOUND on real occupancy: it under-reports saturation, never over-reports it.
 * The single execution seam that makes it exact is the next milestone; until
 * then, treat a positive value as certain and a zero as unproven.
 */
export function poolSaturatedForMs(now: number = Date.now()): number {
    return stats.saturatedSince === 0 ? 0 : Math.max(0, now - stats.saturatedSince);
}

function trackSaturation(): void {
    if (stats.poolMax <= 0) return;
    if (stats.inFlight >= stats.poolMax) {
        if (stats.saturatedSince === 0) stats.saturatedSince = Date.now();
    } else {
        stats.saturatedSince = 0;
    }
}

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
/**
 * `params` is deliberately optional AND distinct from `[]`.
 *
 * Bun routes `unsafe(sql)` through the simple query protocol and
 * `unsafe(sql, [...])` — including an EMPTY array — through the extended one,
 * where the statement gets PREPARED. The two are not interchangeable:
 *
 *  - Bun derives a prepared statement's name from a truncated prefix of the
 *    SQL, so forcing extra statements onto the prepared path can collide two
 *    different queries that share their first ~40 characters:
 *    `prepared statement "PSELECT DISTINCT ec.entity_id as id FROM $8" already
 *    exists` (42P05). Observed by passing `[]` for statements that previously
 *    passed nothing.
 *  - The reverse also bites: on the simple path rows can arrive without named
 *    columns, which is why `ProjectionManager.syncActiveProjections` passes an
 *    explicit `[]` on purpose.
 *
 * So the caller's choice is forwarded verbatim rather than normalised. Note
 * that comparing RESULTS of the two forms shows no difference — the divergence
 * is in the protocol, not the rows.
 */
export async function timedUnsafe<T = any>(
    db: SQL,
    sql: string,
    params?: any[],
    signal?: AbortSignal,
    perRequest?: PerRequestCounters,
): Promise<T> {
    const t0 = performance.now();
    stats.inFlight++;
    if (stats.inFlight > stats.inFlightMax) stats.inFlightMax = stats.inFlight;
    trackSaturation();
    if (perRequest) perRequest.dbQueryCount++;
    let aborted = false;
    try {
        const q = params === undefined ? (db as any).unsafe(sql) : (db as any).unsafe(sql, params);
        return await runWithSignal<T>(q, signal);
    } catch (err) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) {
            aborted = true;
            stats.abortedCount++;
        }
        // Pool exhaustion, not a query failure: the statement never reached the
        // server. Counted separately so "we ran out of slots" is legible in
        // /metrics instead of hiding among generic errors.
        if (isPoolAcquisitionError(err)) stats.poolAcquireFailures++;
        throw err;
    } finally {
        const dt = performance.now() - t0;
        stats.inFlight--;
        trackSaturation();
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
        poolAcquireFailures: stats.poolAcquireFailures,
        inFlight: stats.inFlight,
        inFlightMax: stats.inFlightMax,
        poolMax: stats.poolMax,
        poolSaturatedForMs: poolSaturatedForMs(),
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
    stats.poolAcquireFailures = 0;
    stats.inFlight = 0;
    stats.inFlightMax = 0;
    stats.saturatedSince = 0;
    stats.dataLoaderCalls.entity = 0;
    stats.dataLoaderCalls.component = 0;
    stats.dataLoaderCalls.relation = 0;
}
