/**
 * Boot-time verification of connection-level assumptions the framework
 * otherwise takes on faith (ticket B1/B6).
 *
 * Two things were previously asserted in comments and never checked:
 *   1. `DB_STATEMENT_TIMEOUT` is passed as the `options` startup parameter.
 *      PgBouncer must list `options` in `IGNORE_STARTUP_PARAMETERS` or
 *      connections fail outright — so it silently drops the setting and the
 *      deployment runs with NO server-side statement timeout while the log
 *      says it was applied.
 *   2. Session-scoped `pg_advisory_lock` requires session affinity. Under
 *      `pool_mode = transaction` each statement can land on a different
 *      backend, so an unlock can miss the backend that holds the lock and
 *      strand it until that backend is recycled.
 *
 * Both are measurable, so measure instead of guessing: read back
 * `statement_timeout`, and compare `pg_backend_pid()` across separate
 * statements issued on one reserved pool slot.
 *
 * Since then a third assumption joined them, and it is the one that caused the
 * outage: **that a timeout reclaims the connection.** It does not. The framework
 * aborts the caller, `runWithSignal` asks the driver to cancel, and on Bun
 * 1.4.0-canary.1 nothing reaches the server — the statement runs to its natural
 * end holding its pool slot. That was inferred from pooling mode for a while,
 * which was wrong twice over: it is a driver property, and pooling mode does not
 * predict it. So this probe now measures it directly, on the code path the
 * framework actually uses.
 */
import type { SQL } from 'bun';
import db from './index';
import { runWithSignal, abortMode } from './cancellable';
import { logger as MainLogger } from '../core/Logger';

const logger = MainLogger.child({ scope: 'db.probe' });

export interface ConnectionProbeResult {
    /** true = separate statements landed on different backends → transaction pooling, proven. */
    transactionPooling: boolean;
    /**
     * Why `transactionPooling` is what it is.
     *
     * `false` is NOT the negation of `true` here: identical PIDs are consistent
     * with session pooling AND with a transaction-pooled but idle pool, so the
     * only two honest states are "proven" and "unproven". See `PoolingOutcome`.
     */
    poolingOutcome: PoolingOutcome;
    /** Backend PIDs observed on one reserved connection. */
    backendPids: number[];
    /** Effective server-side statement_timeout, as reported by SHOW. */
    statementTimeout?: string;
    /** `standard_conforming_strings` as reported by SHOW ('on'/'off'). */
    standardConformingStrings?: string;
    /**
     * The server has `standard_conforming_strings = off` (SEC-03). JSONB-key
     * escaping in `SqlIdentifier.escapeJsonLiteral` doubles `'` only, which is
     * complete under the default `on` but leaves a backslash-based break-out
     * open when it is `off`. Deprecated since PG 9.1, so this is a loud-warn,
     * not a fail — but it must not be silent.
     */
    standardConformingStringsOff: boolean;
    /** DB_STATEMENT_TIMEOUT was requested but the server does not have it. */
    statementTimeoutIgnored: boolean;
    /**
     * Did aborting a statement actually stop it server-side?
     *
     * `null` means UNPROVEN — probe skipped, failed, or preempted — and must
     * never be read as "fine". Only `true` is evidence that a timeout reclaims
     * the connection.
     */
    cancelEffective: boolean | null;
    /** Why `cancelEffective` is what it is. See `CancelOutcome`. */
    cancelOutcome: CancelOutcome;
    /** How long the statement actually ran after the abort, in ms. */
    cancelObservedMs?: number;
    /** The `BUNSANE_ABORT_MODE` in force when the probe ran. */
    abortMode?: string;
}

/**
 * Pooling mode is only ever PROVEN, never disproven, by this probe.
 *
 * Distinct backend PIDs across separate statements on one client connection can
 * only happen under transaction pooling — that direction is sound. Identical
 * PIDs prove nothing: PgBouncer hands connections back LIFO, so on an idle pool
 * a transaction-pooled deployment returns the same backend every time and looks
 * exactly like session pooling. Observed twice — once at 0.5.10 boot on
 * production, once as a first-run flake after a vendor swap — both times read as
 * "pooler not detected" when the pooler was right there.
 *
 * So a quiet boot is `unproven`, not `false`. A mitigation nobody applied
 * because the probe said it was unnecessary is the failure this distinction
 * exists to prevent.
 */
export type PoolingOutcome =
    /** Probe did not run (PGlite) or failed. */
    | 'skipped'
    /** Distinct backend PIDs — transaction pooling, proven. */
    | 'proven'
    /** One backend served every statement. Consistent with session pooling OR an idle pool. */
    | 'unproven-idle-pool';

export type CancelOutcome =
    /** Probe did not run (PGlite, `BUNSANE_PROBE_CANCEL=off`, or an error). */
    | 'skipped'
    /** The statement stopped early — cancellation reached the server. */
    | 'stopped'
    /** The statement ran to its natural end. The slot stayed pinned. */
    | 'ran-to-completion'
    /** A server-side `statement_timeout` killed it first, so the probe proves nothing. */
    | 'preempted-by-statement-timeout'
    /** `statement_timeout` is too tight to fit a probe under it. */
    | 'server-timeout-too-tight';

let cached: ConnectionProbeResult | null = null;

/** Last probe result, or null if the probe has not run. */
export function getConnectionProbe(): ConnectionProbeResult | null {
    return cached;
}

export function resetConnectionProbe(): void {
    cached = null;
}

// PostgreSQL normalizes `SHOW statement_timeout` to the largest exact unit
// (3600000 → "1h"), so every unit it can emit must parse or a correctly
// applied timeout would be reported as ignored.
const UNIT_MS: Record<string, number> = {
    us: 1 / 1000,
    ms: 1,
    s: 1000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

const parseTimeoutMs = (shown: string | undefined): number | null => {
    if (!shown) return null;
    const match = /^(\d+)\s*(us|ms|s|min|h|d)?$/.exec(shown.trim());
    if (!match) return null;
    return parseInt(match[1]!, 10) * (UNIT_MS[match[2] ?? 'ms'] ?? 1);
};

/** Default probe statement duration. Short: this answers a driver question, once. */
const DEFAULT_PROBE_SLEEP_MS = 150;

/**
 * Does aborting a statement actually stop it?
 *
 * Runs a short `pg_sleep`, aborts it a quarter of the way in through
 * `runWithSignal` — the same path a query deadline takes, so the answer is about
 * THIS deployment rather than about Bun in the abstract, and
 * `BUNSANE_ABORT_MODE=off` is correctly reported as ineffective — and then
 * watches the underlying query to see when it really ended.
 *
 * Watching the underlying query is the whole trick. `runWithSignal` rejects the
 * caller immediately by design, so caller-visible latency is fast whether or not
 * the server heard anything; the only honest signal is when the STATEMENT
 * settles. If that is near the sleep's natural end, the slot was pinned the
 * entire time.
 *
 * `serverTimeoutMs` is passed in so the probe can tell its own cancellation
 * apart from a server-side `statement_timeout` doing the killing for it — which
 * would otherwise read as a success and certify exactly the property that is
 * broken. Both raise SQLSTATE 57014; the message text is the discriminator.
 *
 * Exported so `runDoctor()` can re-run it with a longer, more conclusive sleep
 * than boot should pay for.
 */
export async function probeCancelEffectiveness(
    conn: any,
    serverTimeoutMs: number | null,
    sleepMsOverride?: number,
): Promise<{ effective: boolean | null; outcome: CancelOutcome; observedMs?: number }> {
    const fromEnv = parseInt(process.env.BUNSANE_PROBE_CANCEL_SLEEP_MS ?? '', 10);
    const requested = sleepMsOverride
        ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PROBE_SLEEP_MS);

    let sleepMs = requested;
    if (serverTimeoutMs !== null && serverTimeoutMs > 0) {
        // Stay under the server's own bound, or it kills the probe instead of
        // the probe measuring the cancel.
        if (serverTimeoutMs < 80) return { effective: null, outcome: 'server-timeout-too-tight' };
        sleepMs = Math.max(40, Math.min(sleepMs, Math.floor(serverTimeoutMs / 2)));
    }
    const cancelAtMs = Math.max(15, Math.floor(sleepMs / 4));

    const q = conn.unsafe(`SELECT pg_sleep(${(sleepMs / 1000).toFixed(3)})`);
    // Own the rejection BEFORE anything can reject it. An unowned rejection from
    // an aborted query has already silently killed a whole `bun test` run in
    // this repo (see `gatedConn` in tests/unit/database/gateway.test.ts); at boot
    // it would be worse.
    Promise.resolve(q).catch(() => { /* observed below */ });

    const t0 = performance.now();
    let observedMs = 0;
    let settleErr: unknown;
    const watcher = Promise.resolve(q).then(
        () => { observedMs = performance.now() - t0; },
        (err) => { observedMs = performance.now() - t0; settleErr = err; },
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('cancel-effectiveness probe')), cancelAtMs);
    try {
        await runWithSignal(q, controller.signal).catch(() => { /* expected: the caller is released */ });
        await watcher;
    } finally {
        clearTimeout(timer);
    }

    const message = (settleErr as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string' && message.includes('canceling statement due to statement timeout')) {
        return { effective: null, outcome: 'preempted-by-statement-timeout', observedMs };
    }

    // Generous threshold: anything that stopped before 60% of its natural
    // duration was stopped by something, and the only candidate is the cancel.
    const stopped = observedMs < sleepMs * 0.6;
    return {
        effective: stopped,
        outcome: stopped ? 'stopped' : 'ran-to-completion',
        observedMs,
    };
}

/**
 * Report the cancel finding, escalating only on the conjunction that matters.
 *
 * An ineffective cancel is survivable if the server has its own bound: the
 * statement is killed, the slot comes back. `statement_timeout = 0` is
 * survivable if aborts work. **Both at once is the outage** — nothing can stop a
 * statement, so every slow query holds its connection to the end, and slots are
 * lost one at a time until the pool is gone with the database sitting idle.
 * That pair, and only that pair, is an error.
 */
function reportCancelEffectiveness(result: ConnectionProbeResult): void {
    if (result.cancelEffective !== false) {
        if (result.cancelOutcome !== 'skipped' && result.cancelEffective === null) {
            logger.warn(
                { outcome: result.cancelOutcome, observedMs: result.cancelObservedMs },
                'Cancel effectiveness unproven — treat query timeouts as caller-side only until it is.',
            );
        }
        return;
    }

    const effectiveMs = parseTimeoutMs(result.statementTimeout);
    const noServerBound = effectiveMs === null || effectiveMs === 0;
    const detail = {
        observedMs: Math.round(result.cancelObservedMs ?? 0),
        abortMode: result.abortMode,
        statementTimeout: result.statementTimeout,
    };

    if (noServerBound) {
        logger.error(
            detail,
            'NOTHING CAN STOP A SLOW QUERY IN THIS DEPLOYMENT. Aborting a statement does not reach the ' +
            'server (it ran to its natural end after being cancelled), and no server-side ' +
            'statement_timeout is in force. Every slow query holds its pool connection to completion, so ' +
            'the pool is lost one slot at a time while the database looks idle. Fix: ' +
            'ALTER ROLE <user> SET statement_timeout = \'<ms>\'. See docs/POOLING.md (B8a).',
        );
        return;
    }

    logger.warn(
        detail,
        'Aborting a statement does not stop it server-side — query timeouts bound the caller only, not ' +
        'the pool slot. The server-side statement_timeout is what actually reclaims connections here.',
    );
}

/**
 * Probe the live connection. Never throws — a probe failure must not block
 * boot; it logs and reports `transactionPooling: false` with
 * `poolingOutcome: 'skipped'`. Read `poolingOutcome`, not the boolean: only
 * `'proven'` is evidence, and the boolean cannot express the difference between
 * "session-pooled" and "could not tell".
 */
export async function probeConnection(sql: SQL = db): Promise<ConnectionProbeResult> {
    const result: ConnectionProbeResult = {
        transactionPooling: false,
        poolingOutcome: 'skipped',
        backendPids: [],
        statementTimeoutIgnored: false,
        standardConformingStringsOff: false,
        cancelEffective: null,
        cancelOutcome: 'skipped',
    };

    if (process.env.USE_PGLITE === 'true') {
        cached = result;
        return result;
    }

    try {
        const reserved = await (sql as any).reserve?.();
        const conn = reserved ?? sql;
        try {
            // Separate round trips on purpose: under transaction pooling each
            // is its own transaction and may be routed to a different backend.
            for (let i = 0; i < 3; i++) {
                const rows = await conn`SELECT pg_backend_pid() AS pid`;
                const pid = Number(rows[0]?.pid);
                if (Number.isFinite(pid)) result.backendPids.push(pid);
            }
            const shown = await conn`SHOW statement_timeout`;
            result.statementTimeout = shown[0]?.statement_timeout as string | undefined;

            // SEC-03: JSONB-key escaping assumes `standard_conforming_strings=on`
            // (the default since PG 9.1). Read it back so a deployment that turned
            // it off is told, rather than silently opening a backslash break-out.
            const scs = await conn`SHOW standard_conforming_strings`;
            result.standardConformingStrings =
                scs[0]?.standard_conforming_strings as string | undefined;
            result.standardConformingStringsOff =
                result.standardConformingStrings === 'off';

            // Read the timeout BEFORE probing the cancel: the probe has to size
            // its statement under the server's own bound, or the server does the
            // killing and the probe certifies a cancel that never happened.
            if (process.env.BUNSANE_PROBE_CANCEL !== 'off') {
                result.abortMode = abortMode();
                const cancel = await probeCancelEffectiveness(conn, parseTimeoutMs(result.statementTimeout));
                result.cancelEffective = cancel.effective;
                result.cancelOutcome = cancel.outcome;
                result.cancelObservedMs = cancel.observedMs;
            }
        } finally {
            reserved?.release?.();
        }
    } catch (err) {
        logger.warn({ err }, 'Connection probe failed — pooling mode and statement_timeout unverified');
        cached = result;
        return result;
    }

    result.transactionPooling = new Set(result.backendPids).size > 1;
    result.poolingOutcome = result.transactionPooling
        ? 'proven'
        : result.backendPids.length > 0 ? 'unproven-idle-pool' : 'skipped';

    const requested = process.env.DB_STATEMENT_TIMEOUT;
    if (requested) {
        const requestedMs = parseTimeoutMs(requested);
        const effectiveMs = parseTimeoutMs(result.statementTimeout);
        // Unparseable effective value → inconclusive, stay quiet. `0` means no
        // timeout at all, which is the actual PgBouncer outcome.
        result.statementTimeoutIgnored = effectiveMs === 0
            || (effectiveMs !== null && requestedMs !== null && effectiveMs !== requestedMs);
    }

    if (result.transactionPooling) {
        logger.warn(
            { backendPids: result.backendPids },
            'Transaction-pooled connection detected (statements landed on different backends). ' +
            'Session-scoped features are unsafe here: session advisory locks, LISTEN/NOTIFY, SET SESSION, ' +
            'server-side prepared statements (set DB_DISABLE_PREPARE=true). See docs/LOCKING.md.'
        );
    } else if (result.poolingOutcome === 'unproven-idle-pool') {
        // Deliberately not silent. A quiet probe is what let a pooled deployment
        // read as unpooled twice; saying nothing here means the absence of a
        // warning gets used as evidence there is no pooler.
        logger.info(
            { backendPid: result.backendPids[0] },
            'Pooling mode UNPROVEN: one backend served every probe statement. That is what session ' +
            'pooling looks like, and also what a transaction-pooled but idle pool looks like ' +
            '(PgBouncer returns connections LIFO). Do not read this as "no pooler" — if PgBouncer is ' +
            'in front of this deployment, keep DB_DISABLE_PREPARE=true and treat session-scoped ' +
            'features as unsafe. See docs/LOCKING.md.'
        );
    }

    reportCancelEffectiveness(result);

    if (result.statementTimeoutIgnored) {
        logger.error(
            { requested, effective: result.statementTimeout },
            'DB_STATEMENT_TIMEOUT was set but the server reports a different statement_timeout — the ' +
            '`options` startup parameter was dropped (PgBouncer ignores it). This deployment has NO ' +
            'server-side statement timeout. Set it on the role instead: ' +
            'ALTER ROLE <user> SET statement_timeout = \'<ms>\'.'
        );
    }

    if (result.standardConformingStringsOff) {
        logger.error(
            { standardConformingStrings: result.standardConformingStrings },
            'standard_conforming_strings is OFF. JSONB-key escaping (SqlIdentifier.escapeJsonLiteral) ' +
            'doubles single quotes only, which is complete under the default ON but leaves a ' +
            'backslash-based break-out open when OFF. Set it back ON: ' +
            "ALTER SYSTEM SET standard_conforming_strings = 'on'; (or per-role/per-db). See SEC-03."
        );
    }

    cached = result;
    return result;
}
