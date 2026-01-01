import {SQL} from "bun";
import { logger } from "core/Logger";

let connectionUrl = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB}`;
if(process.env.DB_CONNECTION_URL) {
    connectionUrl = process.env.DB_CONNECTION_URL;
}
logger.info(`Database connection URL: ${connectionUrl}`);

// OPTIMIZED: Reduced from 20 to 10 to prevent overwhelming PGBouncer
// With 5 app instances: 5 × 10 = 50 connections (well under PGBouncer's limit)
const maxConnections = parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '10', 10);
logger.info(`Connection pool size: ${maxConnections} connections`);

const db = new SQL({
    url: connectionUrl,
    // Connection pool settings - OPTIMIZED for PGBouncer
    max: maxConnections,
    idleTimeout: 30000, // Close idle connections after 30s
    maxLifetime: 600000, // Connection lifetime 10 minutes
    connectionTimeout: 30, // Timeout when establishing new connections
    onclose: (err) => {
        if (err) {
            if((err as unknown as { code: string }).code === "ERR_POSTGRES_IDLE_TIMEOUT") {
                logger.trace("Closing connection. Idle");
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