import {SQL} from "bun";
import { logger } from "../core/Logger";

// Query timeout in milliseconds (default 30s, configurable via env)
// This is used by Query.exec(), Entity.save(), etc.
export const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT ?? '30000', 10);

// Module-level state for the database connection
let _db: SQL | null = null;

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
    //   - DB_QUERY_TIMEOUT (default 30 s) is JS-side, but it DOES cancel the
    //     in-flight query (runWithSignal → Bun SQL `query.cancel()`) on both the
    //     read and write paths, so the backend is released rather than abandoned.
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

    // DB_CONNECTION_TIMEOUT (default 30 s): the pool waits this long for a free
    // slot before rejecting the caller. At 30 s, pool exhaustion queues HTTP
    // requests for up to 30 s each, holding sockets and consuming memory.
    // User-facing services should consider 5 s for fast-fail so clients get
    // an error quickly rather than a slow timeout. Long-running background
    // workers (schedulers, outbox, migrations) can keep higher values.
    const connTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT ?? '30', 10);

    // DB_DISABLE_PREPARE (opt-in): turn off Bun SQL's automatic server-side
    // prepared statements (driver default `prepare: true`). REQUIRED behind
    // PgBouncer in transaction pooling mode — each transaction may land on a
    // different backend, so a prepared statement created on one connection is
    // absent on the next, yielding `prepared statement "..." does not exist`
    // errors that can poison the pooled client and wedge the write path. Costs
    // a little per-query planning; negligible next to the failure it prevents.
    const disablePrepare = process.env.DB_DISABLE_PREPARE === 'true';
    if (disablePrepare) {
        logger.info('Prepared statements disabled (DB_DISABLE_PREPARE=true) — required for PgBouncer transaction pooling');
    }

    return new SQL({
        url,
        max,
        idleTimeout: 30000,
        maxLifetime: 600000,
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

// For backward compatibility, initialize eagerly on import
// This ensures existing code using `import db from './database'` continues to work
// Note: For benchmarks that need delayed initialization, use getDb() or resetDatabase()
const db = getDb();

export default db;
