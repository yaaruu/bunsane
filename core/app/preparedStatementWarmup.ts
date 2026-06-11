import { logger as MainLogger } from "../Logger";

const logger = MainLogger.child({ scope: "App" });

/**
 * @deprecated No-op. The framework-level prepared statement cache was
 * removed from the query hot path — Bun SQL auto-prepares parameterized
 * statements per connection (prepare:true default), so server-side plan
 * reuse happens at the driver layer and "warming" a placeholder map bought
 * nothing. Kept so bootstrap's call site and the public App surface remain
 * stable.
 */
export async function warmUpPreparedStatementCache(_app: any): Promise<void> {
    logger.trace("Prepared statement warm-up skipped (driver-level auto-prepare in effect)");
}
