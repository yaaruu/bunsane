import {SQL} from "bun";
import { logger } from "../core/Logger";
import { setPoolMax } from "./instrumentedDb";

// Query timeout in milliseconds (default 30s, configurable via env)
// This is used by Query.exec(), Entity.save(), etc.
export const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT ?? '30000', 10);

/**
 * Budget for schema DDL — `CREATE INDEX [CONCURRENTLY]`, `ALTER TABLE`,
 * partition attach, projection table creation.
 *
 * Separate from `QUERY_TIMEOUT_MS` because DDL is long-running BY DESIGN: a
 * concurrent index build on a large table routinely outlives 30 s. Giving it the
 * query budget would abort the build — and per docs/POOLING.md B8a the abort
 * does not reach Postgres, so the index would keep building while the framework
 * logged a failure and possibly retried, producing duplicate work against a
 * table already under an index build.
 *
 * 10 minutes is a bound, not a target: it exists so a wedged DDL statement
 * eventually releases its admission permit rather than pinning one forever.
 */
export const DDL_TIMEOUT_MS = parseInt(process.env.DB_DDL_TIMEOUT ?? '600000', 10);

// Module-level state for the database connection
let _db: SQL | null = null;

/**
 * Bun SQL pool timeouts are expressed in SECONDS, not milliseconds
 * (`bun-types/sql.d.ts` — "Maximum time in seconds", `connectionTimeout` default
 * `30`; verified empirically on Bun 1.4.0: `new SQL({ idleTimeout: 2 })` emitted
 * `onclose ERR_POSTGRES_IDLE_TIMEOUT` at t=2016 ms).
 *
 * The framework previously passed `idleTimeout: 30000` and
 * `maxLifetime: 600000`, intending 30 s / 10 min but actually configuring
 * ~8 h 20 m / ~6.9 days. No container reaches either, so **no connection was
 * ever recycled on age or idleness**: an idle pool never shrank (pinning `max`
 * server-side connections behind a pooler after any burst) and a connection in
 * a degraded state — protocol desync, for instance — had no age-based escape.
 *
 * A value beyond what that setting could plausibly mean in seconds is a ms/s
 * mix-up, not an intent, so reject it instead of silently running with the
 * policy disabled. The ceiling is PER SETTING: a single global cap would not
 * catch the bug that shipped, since `idleTimeout: 30000` (8 h 20 m) is under any
 * cap loose enough to allow a one-day `maxLifetime`. A deployment that genuinely
 * wants "effectively never" sets 0, which Bun documents as unlimited.
 */
export const POOL_SECONDS_MAX = {
    /** Waiting minutes for a pool slot is already pathological. */
    DB_CONNECTION_TIMEOUT: 300,
    /** Idle connections exist to be reaped; an hour is already very patient. */
    DB_POOL_IDLE_TIMEOUT: 3_600,
    /** A day is the longest defensible lifetime for a pooled connection. */
    DB_POOL_MAX_LIFETIME: 86_400,
} as const;

export function parsePoolSeconds(
    envName: string,
    raw: string | undefined,
    defaultSeconds: number,
    maxSeconds: number = POOL_SECONDS_MAX[envName as keyof typeof POOL_SECONDS_MAX] ?? 86_400,
): number {
    if (raw === undefined || raw === '') return defaultSeconds;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(
            `${envName} must be a non-negative integer number of SECONDS (got ${JSON.stringify(raw)}).`,
        );
    }
    if (value > maxSeconds) {
        throw new Error(
            `${envName}=${value} exceeds ${maxSeconds} seconds. Bun SQL pool timeouts are in ` +
            `SECONDS, not milliseconds — a value this large is a ms/s mix-up (it was exactly this ` +
            `bug that left connections un-recycled for the life of the process). ` +
            `Set seconds, or 0 for "no limit" if that is genuinely intended.`,
        );
    }
    return value;
}

function createDatabase(): SQL {
    let url = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB}`;
    if(process.env.DB_CONNECTION_URL) {
        url = process.env.DB_CONNECTION_URL;
    }

    // DB_STATEMENT_TIMEOUT (opt-in, server-side query cancellation):
    //   - Passed as the `options` startup parameter. PgBouncer DROPS it: `options`
    //     must be in IGNORE_STARTUP_PARAMETERS or connections fail outright, so
    //     behind a pooler this setting is accepted and has no effect. There is no
    //     way to detect that from the URL, so it is VERIFIED at boot instead —
    //     probeConnection() (database/connectionProbe.ts) reads `SHOW
    //     statement_timeout` back and logs at error level if it did not stick.
    //     The supported path behind a pooler is
    //     `ALTER ROLE <user> SET statement_timeout = '<ms>'`.
    //   - DB_QUERY_TIMEOUT (default 30 s) is JS-side. It bounds how long the
    //     CALLER waits; it does NOT bound the statement. Behind a pooler the
    //     `query.cancel()` it issues does not free the slot — the statement runs
    //     to natural completion and holds its pooled connection for that whole
    //     time (measured, ticket B8a; see database/cancellable.ts). Do not treat
    //     it as a recovery mechanism for pool exhaustion.
    if (process.env.USE_PGLITE !== 'true' && process.env.DB_STATEMENT_TIMEOUT) {
        try {
            const urlObj = new URL(url);
            urlObj.searchParams.set('options', `-c statement_timeout=${process.env.DB_STATEMENT_TIMEOUT}`);
            url = urlObj.toString();
        } catch {
            // Non-standard URL format, skip statement_timeout
        }
    }

    const redactedUrl = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
    logger.info(`Database connection URL: ${redactedUrl}`);

    const max = parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10);
    logger.info(`Connection pool size: ${max} connections`);
    logger.info(`Query timeout: ${QUERY_TIMEOUT_MS}ms`);
    // Publish the denominator so pool occupancy is reportable as a ratio
    // (/metrics, readiness) instead of an unlabelled in-flight count.
    setPoolMax(max);

    // DB_CONNECTION_TIMEOUT (default 30 s): the pool waits this long for a free
    // slot before rejecting the caller with ERR_POSTGRES_CONNECTION_TIMEOUT
    // (classified by ./poolErrors and answered as a 503, not a 500).
    //
    // At 30 s — the same value as DB_QUERY_TIMEOUT — pool exhaustion stacks two
    // 30 s waits per request, which is how a slowdown becomes an outage:
    // requests queue for a slot, get one, then die on the query clock.
    // **Request-facing deployments should set 5.** The default stays 30 because
    // there is one pool shared with background work (scheduler, outbox,
    // projection backfill and reconcile) that legitimately waits longer, and no
    // per-lane timeout exists yet to tell them apart — lowering it globally
    // would start failing that work instead. Per-lane defaults land with the
    // execution seam.
    const connTimeout = parsePoolSeconds('DB_CONNECTION_TIMEOUT', process.env.DB_CONNECTION_TIMEOUT, 30);

    // Both in SECONDS (see parsePoolSeconds above). Recycling matters most behind a
    // pooler: it is the only mechanism that ever retires a connection the driver
    // still believes is usable.
    const idleTimeout = parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', process.env.DB_POOL_IDLE_TIMEOUT, 30);
    const maxLifetime = parsePoolSeconds('DB_POOL_MAX_LIFETIME', process.env.DB_POOL_MAX_LIFETIME, 600);
    logger.info(`Pool timeouts: idle=${idleTimeout}s lifetime=${maxLifetime}s connect=${connTimeout}s`);

    // DB_DISABLE_PREPARE (opt-in): turn off Bun SQL's automatic server-side
    // prepared statements (driver default `prepare: true`). REQUIRED behind
    // PgBouncer in transaction pooling mode — each transaction may land on a
    // different backend, so a prepared statement created on one connection is
    // absent on the next, yielding `prepared statement "..." does not exist`
    // errors that can poison the pooled client and wedge the write path. Costs
    // a little per-query planning; negligible next to the failure it prevents.
    //
    // NOT a guarantee: one production deployment reported `prepare: false` making
    // things worse behind PgBouncer 1.25.1 (`unnamed prepared statement does not
    // exist`, `bind message supplies 3 parameters, but prepared statement ""
    // requires 0`), where `prepare: true` produced `bind message has N result
    // formats but query has M columns` instead. Both modes can desync through
    // that pairing. See docs/CONFIGURATION.md § PgBouncer deployment.
    const disablePrepare = process.env.DB_DISABLE_PREPARE === 'true';
    if (disablePrepare) {
        logger.info('Prepared statements disabled (DB_DISABLE_PREPARE=true) — required for PgBouncer transaction pooling');
    }

    return new SQL({
        url,
        max,
        idleTimeout,
        maxLifetime,
        connectionTimeout: connTimeout,
        // Only override when disabling; otherwise leave Bun's default (true).
        ...(disablePrepare ? { prepare: false } : {}),
        onclose: (err) => {
            if (err) {
                const errCode = (err as unknown as { code: string }).code;
                if(errCode === "ERR_POSTGRES_IDLE_TIMEOUT") {
                    logger.trace("Closing connection. Idle");
                } else if (errCode === "ERR_POSTGRES_CONNECTION_CLOSED") {
                    logger.warn("Database connection closed unexpectedly");
                } else {
                    logger.error("Database connection closed with error:");
                    logger.error(err);
                }
            } else {
                logger.trace("Database connection closed gracefully.");
            }
        },
        onconnect: () => {
            logger.trace("New database connection established");
        }
    });
}

/**
 * Get the database connection. Lazily initializes on first access.
 * This allows env vars to be set before the first database usage.
 */
export function getDb(): SQL {
    if (!_db) {
        _db = createDatabase();
    }
    return _db;
}

/**
 * Reinitialize the database connection with current env vars.
 * Used by benchmark tests that set env vars after module load.
 */
export function resetDatabase(): void {
    _db = createDatabase();
}

/**
 * Close the current pool and drop the singleton, so the next use lazily opens
 * a fresh pool instead of hitting a closed one (tests, scripts, re-init).
 */
export async function closeDatabase(): Promise<void> {
    const current = _db;
    _db = null;
    if (current) await current.close();
}

/**
 * Default client. Forwards tagged templates, calls (`db(rows)`), and property
 * access (`db.unsafe`, `db.begin`, `db.transaction`, `db.close`, …) to the
 * instance from {@link getDb}, so the pool is not created until something
 * actually uses it. Follows {@link resetDatabase} — the previous eager
 * `const db = getDb()` pinned importers to the pool that existed at import.
 *
 * `then` / `catch` / `finally` do not initialize the pool. Awaiting a
 * non-thenable checks `.then`; that must not open a connection.
 */
const methodCache = new WeakMap<object, Map<PropertyKey, { fn: Function; bound: Function }>>();

// Target must be callable so tagged-template / helper calls hit the apply trap.
const lazyTarget = function lazyDatabase(): void {
    // Unreachable: apply forwards to getDb().
};

const db = new Proxy(lazyTarget, {
    apply(_target, _thisArg, argArray) {
        const real = getDb() as unknown as (...args: unknown[]) => unknown;
        return real(...argArray);
    },
    get(_target, prop) {
        if ((prop === "then" || prop === "catch" || prop === "finally") && _db === null) {
            return undefined;
        }
        const real = getDb();
        const value = Reflect.get(real as object, prop, real);
        if (typeof value !== "function") return value;
        let cache = methodCache.get(real);
        const cached = cache?.get(prop);
        // Re-bind when the instance method was replaced (tests/instrumentation patch it).
        if (cached && cached.fn === value) return cached.bound;
        const bound = value.bind(real);
        if (!cache) {
            cache = new Map();
            methodCache.set(real, cache);
        }
        cache.set(prop, { fn: value, bound });
        return bound;
    },
    // Writes land on the live instance, as they did when `db` was the instance.
    set(_target, prop, value) {
        return Reflect.set(getDb() as object, prop, value);
    },
}) as unknown as SQL;

/** True after the pool has been created. Importing this module leaves it false. */
export function isDatabaseInitialized(): boolean {
    return _db !== null;
}

export default db;
