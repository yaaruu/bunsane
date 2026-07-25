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
 */
import type { SQL } from 'bun';
import db from './index';
import { logger as MainLogger } from '../core/Logger';

const logger = MainLogger.child({ scope: 'db.probe' });

export interface ConnectionProbeResult {
    /** true = separate statements landed on different backends → transaction pooling, proven. */
    transactionPooling: boolean;
    /** Backend PIDs observed on one reserved connection. */
    backendPids: number[];
    /** Effective server-side statement_timeout, as reported by SHOW. */
    statementTimeout?: string;
    /** DB_STATEMENT_TIMEOUT was requested but the server does not have it. */
    statementTimeoutIgnored: boolean;
}

let cached: ConnectionProbeResult | null = null;

/** Last probe result, or null if the probe has not run. */
export function getConnectionProbe(): ConnectionProbeResult | null {
    return cached;
}

export function resetConnectionProbe(): void {
    cached = null;
}

const parseTimeoutMs = (shown: string | undefined): number | null => {
    if (!shown) return null;
    const match = /^(\d+)\s*(ms|s|min)?$/.exec(shown.trim());
    if (!match) return null;
    const value = parseInt(match[1]!, 10);
    switch (match[2]) {
        case 's': return value * 1000;
        case 'min': return value * 60_000;
        default: return value;
    }
};

/**
 * Probe the live connection. Never throws — a probe failure must not block
 * boot; it logs and reports `transactionPooling: false` (which means
 * "unproven", NOT "proven safe").
 */
export async function probeConnection(sql: SQL = db): Promise<ConnectionProbeResult> {
    const result: ConnectionProbeResult = {
        transactionPooling: false,
        backendPids: [],
        statementTimeoutIgnored: false,
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
        } finally {
            reserved?.release?.();
        }
    } catch (err) {
        logger.warn({ err }, 'Connection probe failed — pooling mode and statement_timeout unverified');
        cached = result;
        return result;
    }

    result.transactionPooling = new Set(result.backendPids).size > 1;

    const requested = process.env.DB_STATEMENT_TIMEOUT;
    if (requested) {
        const requestedMs = parseTimeoutMs(requested);
        const effectiveMs = parseTimeoutMs(result.statementTimeout);
        result.statementTimeoutIgnored = effectiveMs === 0 || (requestedMs !== null && effectiveMs !== requestedMs);
    }

    if (result.transactionPooling) {
        logger.warn(
            { backendPids: result.backendPids },
            'Transaction-pooled connection detected (statements landed on different backends). ' +
            'Session-scoped features are unsafe here: session advisory locks, LISTEN/NOTIFY, SET SESSION, ' +
            'server-side prepared statements (set DB_DISABLE_PREPARE=true). See docs/LOCKING.md.'
        );
    }

    if (result.statementTimeoutIgnored) {
        logger.error(
            { requested, effective: result.statementTimeout },
            'DB_STATEMENT_TIMEOUT was set but the server reports a different statement_timeout — the ' +
            '`options` startup parameter was dropped (PgBouncer ignores it). This deployment has NO ' +
            'server-side statement timeout. Set it on the role instead: ' +
            'ALTER ROLE <user> SET statement_timeout = \'<ms>\'.'
        );
    }

    cached = result;
    return result;
}
