import {SQL} from "bun";
import { logger } from "core/Logger";

let connectionUrl = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB}`;
if(process.env.DB_CONNECTION_URL) {
    connectionUrl = process.env.DB_CONNECTION_URL;
}
logger.info(`Database connection URL: ${connectionUrl}`);
const db = new SQL({
    url: connectionUrl,
    // Connection pool settings - FIXED
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10), // Increased max connections
    idleTimeout: 30000, // Close idle connections after 30s (was 0)
    maxLifetime: 600000, // Connection lifetime 10 minutes (was 0 = forever)
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
            logger.info("Database connection closed.");
        }   
    },
});


export default db;