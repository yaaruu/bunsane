import ApplicationLifecycle, {
    ApplicationPhase,
    type PhaseChangeEvent,
} from "../ApplicationLifecycle";
import { logger as MainLogger } from "../Logger";
import ServiceRegistry from "../../service/ServiceRegistry";
import { SchedulerManager } from "../SchedulerManager";
import { registerScheduledTasks } from "../../scheduler";
import {
    RemoteManager,
    registerRemoteHandlers,
    setRemoteManager,
    type RemoteManagerConfig,
} from "../remote";
import { setupGraphQL } from "./graphqlSetup";
import { collectRestEndpoints } from "./restRegistry";

const logger = MainLogger.child({ scope: "App" });

export function createPhaseListener(app: any): (event: PhaseChangeEvent) => Promise<void> {
    return async (event: PhaseChangeEvent) => {
        const phase = event.detail;
        logger.info(`Application phase changed to: ${phase}`);
        for (const plugin of app.plugins) {
            if (plugin.onPhaseChange) {
                await plugin.onPhaseChange(phase, app);
            }
        }
        switch (phase) {
            case ApplicationPhase.DATABASE_READY:
                await runDatabaseReadyPhase(app);
                break;
            case ApplicationPhase.SYSTEM_READY:
                await runSystemReadyPhase(app);
                break;
            case ApplicationPhase.APPLICATION_READY:
                await runApplicationReadyPhase(app);
                break;
        }
    };
}

export async function runDatabaseReadyPhase(app: any): Promise<void> {
    try {
        await app.warmUpPreparedStatementCache();
    } catch (error) {
        logger.warn("Failed to warm up prepared statement cache:", error as any);
    }
}

export async function runSystemReadyPhase(app: any): Promise<void> {
    try {
        const { CacheManager } = await import('../cache/CacheManager');
        const cacheManager = CacheManager.getInstance();
        const config = cacheManager.getConfig();

        if (config.enabled) {
            const isHealthy = await cacheManager.getProvider().ping();
            if (isHealthy) {
                logger.info({ scope: 'cache', component: 'App', msg: 'Cache health check passed' });
            } else {
                logger.warn({ scope: 'cache', component: 'App', msg: 'Cache health check failed' });
            }
        }
    } catch (error) {
        logger.warn({ scope: 'cache', component: 'App', msg: 'Cache health check error', error });
    }

    try {
        setupGraphQL(app);

        const services = ServiceRegistry.getServices();

        const scheduler = SchedulerManager.getInstance();
        scheduler.config.enableLogging = app.config.scheduler.logging;

        for (const service of services) {
            try {
                registerScheduledTasks(service);
            } catch (error) {
                logger.warn(`Failed to register scheduled tasks for service ${service.constructor.name}`);
                logger.warn(error);
            }
        }
        logger.info(`Registered scheduled tasks for ${services.length} services`);

        if (app.remoteConfig) {
            try {
                const rmConfig: RemoteManagerConfig = {
                    appName: app.remoteConfig.appName || app.name,
                    ...app.remoteConfig,
                };
                app.remote = new RemoteManager(rmConfig);
                setRemoteManager(app.remote);
                await app.remote.start();

                for (const service of services) {
                    try {
                        registerRemoteHandlers(service);
                    } catch (error) {
                        logger.warn(`Failed to register remote handlers for service ${service.constructor.name}`);
                        logger.warn(error);
                    }
                }
                logger.info(`RemoteManager initialized for app "${rmConfig.appName}"`);
            } catch (error) {
                logger.error("Failed to start RemoteManager:");
                logger.error(error);
            }
        }

        collectRestEndpoints(app, services);

        ApplicationLifecycle.setPhase(ApplicationPhase.APPLICATION_READY);
    } catch (error) {
        // SYSTEM_READY failures must not be swallowed silently. Without this,
        // the app stays forever in SYSTEM_READY (isReady=false,
        // /health/ready → 503 forever) and k8s rollout hangs with no
        // observable cause. Surface so readiness probe reports it (C09).
        app.isReady = false;
        logger.fatal({ scope: 'app', component: 'App', err: error }, 'Fatal error during SYSTEM_READY phase — marking app unready');
        if (process.env.NODE_ENV === 'test') {
            throw error;
        }
        setTimeout(() => process.exit(1), 100).unref?.();
    }
}

export async function runApplicationReadyPhase(app: any): Promise<void> {
    if (process.env.NODE_ENV !== "test") {
        app.start();
    }
}
