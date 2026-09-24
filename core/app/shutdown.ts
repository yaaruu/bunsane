import ApplicationLifecycle from "../ApplicationLifecycle";
import { logger as MainLogger } from "../Logger";
import { SchedulerManager } from "../SchedulerManager";
import { closeDatabase } from "../../database";
import { setRemoteManager } from "../remote";

const logger = MainLogger.child({ scope: "App" });

export async function runShutdown(app: any): Promise<void> {
    if (app.isShuttingDown) return;
    app.isShuttingDown = true;
    app.isReady = false;
    app.shutdownFailed = false;

    const shutdownStart = Date.now();
    logger.info({ scope: 'app', component: 'App', msg: 'Shutting down application', gracePeriodMs: app.shutdownGracePeriod });

    const budgetRemaining = () => Math.max(500, app.shutdownGracePeriod - (Date.now() - shutdownStart));
    const fail = (msg: string, error?: unknown) => {
        app.shutdownFailed = true;
        logger.warn({ scope: 'app', component: 'App', msg, err: error });
    };

    if (typeof app.reconcileStop === 'function') {
        try {
            app.reconcileStop();
        } catch (error) {
            fail('QSP reconcile sweep stop error', error);
        }
        app.reconcileStop = null;
    }

    if (app.server) {
        try {
            logger.info({ scope: 'app', component: 'App', msg: 'Draining HTTP connections' });
            app.server.stop(false);
            const drained = await waitForHttpDrain(app, budgetRemaining());
            if (!drained) app.shutdownFailed = true;
            try { app.server.stop(true); } catch {}
            logger.info({ scope: 'app', component: 'App', msg: 'HTTP server stopped' });
        } catch (error) {
            fail('HTTP server stop error', error);
        } finally {
            // Drop the handle so a later start() binds again and use() is allowed.
            app.server = null;
        }
    }

    try {
        await SchedulerManager.getInstance().stop(Math.min(budgetRemaining(), 15_000));
        logger.info({ scope: 'app', component: 'App', msg: 'Scheduler stopped' });
    } catch (error) {
        fail('Scheduler stop error', error);
    }

    if (app.remote) {
        try {
            await app.remote.shutdown();
            setRemoteManager(null);
            app.remote = null;
            logger.info({ scope: 'app', component: 'App', msg: 'RemoteManager shutdown' });
        } catch (error) {
            fail('RemoteManager shutdown error', error);
        }
    }

    try {
        const { Entity } = await import('../Entity');
        await Entity.drainPendingCacheOps(Math.min(budgetRemaining(), 5_000));
        await Entity.drainPendingSideEffects(Math.min(budgetRemaining(), 5_000));
    } catch (error) {
        fail('Entity cache op drain error', error);
    }

    try {
        const { CacheManager } = await import('../cache/CacheManager');
        await CacheManager.getInstance().shutdown();
        logger.info({ scope: 'cache', component: 'App', msg: 'Cache shutdown completed' });
    } catch (error) {
        fail('Cache shutdown error', error);
    }

    try {
        await closeDatabase();
        logger.info({ scope: 'app', component: 'App', msg: 'Database pool closed' });
    } catch (error) {
        fail('Database pool close error', error);
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
    // Drain finished. Health must not keep reporting shutdown, and a later
    // shutdown() must be able to run after the app is started again.
    app.isShuttingDown = false;
}

export async function waitForHttpDrain(app: any, timeoutMs: number): Promise<boolean> {
    if (!app.server) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pending = (app.server as { pendingRequests?: number }).pendingRequests ?? 0;
        if (pending === 0) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    const leftover = (app.server as { pendingRequests?: number }).pendingRequests ?? -1;
    if (leftover > 0) {
        logger.warn({ scope: 'app', component: 'App', msg: 'HTTP drain timeout, pending requests remaining', pendingRequests: leftover });
        return false;
    }
    return true;
}
