import ApplicationLifecycle from "../ApplicationLifecycle";
import { logger as MainLogger } from "../Logger";
import { SchedulerManager } from "../SchedulerManager";
import db from "../../database";
import { setRemoteManager } from "../remote";

const logger = MainLogger.child({ scope: "App" });

export async function runShutdown(app: any): Promise<void> {
    if (app.isShuttingDown) return;
    app.isShuttingDown = true;
    app.isReady = false;

    const shutdownStart = Date.now();
    logger.info({ scope: 'app', component: 'App', msg: 'Shutting down application', gracePeriodMs: app.shutdownGracePeriod });

    const budgetRemaining = () => Math.max(500, app.shutdownGracePeriod - (Date.now() - shutdownStart));

    if (app.server) {
        try {
            logger.info({ scope: 'app', component: 'App', msg: 'Draining HTTP connections' });
            app.server.stop(false);
            await waitForHttpDrain(app, budgetRemaining());
            try { app.server.stop(true); } catch {}
            logger.info({ scope: 'app', component: 'App', msg: 'HTTP server stopped' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'HTTP server stop error', err: error });
        }
    }

    try {
        await SchedulerManager.getInstance().stop(Math.min(budgetRemaining(), 15_000));
        logger.info({ scope: 'app', component: 'App', msg: 'Scheduler stopped' });
    } catch (error) {
        logger.warn({ scope: 'app', component: 'App', msg: 'Scheduler stop error', err: error });
    }

    if (app.remote) {
        try {
            await app.remote.shutdown();
            setRemoteManager(null);
            app.remote = null;
            logger.info({ scope: 'app', component: 'App', msg: 'RemoteManager shutdown' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'RemoteManager shutdown error', err: error });
        }
    }

    try {
        const { Entity } = await import('../Entity');
        await Entity.drainPendingCacheOps(Math.min(budgetRemaining(), 5_000));
        await Entity.drainPendingSideEffects(Math.min(budgetRemaining(), 5_000));
    } catch (error) {
        logger.warn({ scope: 'cache', component: 'App', msg: 'Entity cache op drain error', err: error });
    }

    try {
        const { CacheManager } = await import('../cache/CacheManager');
        await CacheManager.getInstance().shutdown();
        logger.info({ scope: 'cache', component: 'App', msg: 'Cache shutdown completed' });
    } catch (error) {
        logger.warn({ scope: 'cache', component: 'App', msg: 'Cache shutdown error', err: error });
    }

    try {
        db.close();
        logger.info({ scope: 'app', component: 'App', msg: 'Database pool closed' });
    } catch (error) {
        logger.warn({ scope: 'app', component: 'App', msg: 'Database pool close error', err: error });
    }

    try {
        if (app.phaseListener) {
            ApplicationLifecycle.removePhaseListener(app.phaseListener);
            app.phaseListener = null;
        }
        SchedulerManager.getInstance().disposeLifecycleIntegration();
    } catch { /* ignore */ }

    app.unregisterProcessHandlers();

    logger.info({ scope: 'app', component: 'App', msg: 'Application shutdown completed', durationMs: Date.now() - shutdownStart });
}

export async function waitForHttpDrain(app: any, timeoutMs: number): Promise<void> {
    if (!app.server) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pending = (app.server as any).pendingRequests ?? 0;
        if (pending === 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    const leftover = (app.server as any).pendingRequests ?? -1;
    if (leftover > 0) {
        logger.warn({ scope: 'app', component: 'App', msg: 'HTTP drain timeout, pending requests remaining', pendingRequests: leftover });
    }
}
