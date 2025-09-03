import {SQL} from "bun";
import { logger } from "core/Logger";

const db = new SQL({
    url: `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:5432/${process.env.POSTGRES_DB}`,
    // Connection pool settings
    max: 10, // Maximum connections in pool
    idleTimeout: 0, // Close idle connections after 30s
    maxLifetime: 0, // Connection lifetime in seconds (0 = forever)
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