import { logger as MainLogger } from "../Logger";
import { SchedulerManager } from "../SchedulerManager";
import { preparedStatementCache } from "../../database/PreparedStatementCache";
import { getDbStats } from "../../database/instrumentedDb";
import type { CacheManager } from "../cache/CacheManager";

const logger = MainLogger.child({ scope: "App" });

export async function collectMetrics(app: any) {
    let cacheStats: Awaited<ReturnType<CacheManager["getStats"]>> | null = null;
    try {
        const { CacheManager } = await import('../cache/CacheManager');
        cacheStats = await CacheManager.getInstance().getStats();
    } catch (err) {
        logger.warn({ err }, 'metrics: cache stats unavailable');
    }

    return {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        process: process.memoryUsage(),
        cache: cacheStats,
        scheduler: SchedulerManager.getInstance().getMetrics(),
        preparedStatements: preparedStatementCache.getStats(),
        db: getDbStats(),
        remote: app.remote ? app.remote.getMetrics() : null,
    };
}
