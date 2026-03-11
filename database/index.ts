import {SQL} from "bun";
import { logger } from "../core/Logger";

let connectionUrl = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB}`;
if(process.env.DB_CONNECTION_URL) {
    connectionUrl = process.env.DB_CONNECTION_URL;
}

// Add statement_timeout only when explicitly configured (opt-in)
// Note: PgBouncer rejects statement_timeout as a startup parameter — use PostgreSQL config or connect_query instead
if (process.env.USE_PGLITE !== 'true' && process.env.DB_STATEMENT_TIMEOUT) {
    try {
        const urlObj = new URL(connectionUrl);
        urlObj.searchParams.set('options', `-c statement_timeout=${process.env.DB_STATEMENT_TIMEOUT}`);
        connectionUrl = urlObj.toString();
    } catch {
        // Non-standard URL format, skip statement_timeout
    }
}

// Log connection URL with credentials redacted
const redactedUrl = connectionUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
logger.info(`Database connection URL: ${redactedUrl}`);

// OPTIMIZED: Reduced from 20 to 10 to prevent overwhelming PGBouncer
// With 5 app instances: 5 × 10 = 50 connections (well under PGBouncer's limit)
const maxConnections = parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '10', 10);
logger.info(`Connection pool size: ${maxConnections} connections`);

// Connection timeout in seconds (default 30s, configurable via env)
const connectionTimeoutSec = parseInt(process.env.DB_CONNECTION_TIMEOUT ?? '30', 10);

// Query timeout in milliseconds (default 30s, configurable via env)
// This is used by Query.exec(), Entity.save(), etc.
export const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT ?? '30000', 10);
logger.info(`Query timeout: ${QUERY_TIMEOUT_MS}ms`);

const db = new SQL({
    url: connectionUrl,
    // Connection pool settings - OPTIMIZED for PGBouncer
    max: maxConnections,
    idleTimeout: 30000, // Close idle connections after 30s
    maxLifetime: 600000, // Connection lifetime 10 minutes
    connectionTimeout: connectionTimeoutSec, // Timeout when establishing new connections (seconds)
    onclose: (err) => {
        if (err) {
            const errCode = (err as unknown as { code: string }).code;
            if(errCode === "ERR_POSTGRES_IDLE_TIMEOUT") {
                logger.trace("Closing connection. Idle");
            } else if (errCode === "ERR_POSTGRES_CONNECTION_CLOSED") {
                // Connection closed - can happen during high load or network issues
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
        // Log when new connections are created
        logger.trace("New database connection established");
    }
});


export default db;