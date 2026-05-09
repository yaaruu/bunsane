import { logger as MainLogger } from "../Logger";

const logger = MainLogger.child({ scope: "App" });

export function registerProcessHandlers(app: any): void {
    if (app.processHandlersRegistered) return;

    app.sigTermHandler = () => {
        logger.info({ scope: 'app', component: 'App', msg: 'Received SIGTERM' });
        app.shutdown().finally(() => process.exit(0));
    };
    app.sigIntHandler = () => {
        logger.info({ scope: 'app', component: 'App', msg: 'Received SIGINT' });
        app.shutdown().finally(() => process.exit(0));
    };
    process.once('SIGTERM', app.sigTermHandler);
    process.once('SIGINT', app.sigIntHandler);

    app.unhandledRejectionHandler = (reason: unknown, _promise: Promise<unknown>) => {
        logger.error({ scope: 'app', component: 'App', reason, msg: 'Unhandled promise rejection' });
    };
    app.uncaughtExceptionHandler = (error: Error) => {
        logger.fatal({ scope: 'app', component: 'App', err: error, msg: 'Uncaught exception — shutting down' });
        app.shutdown().finally(() => process.exit(1));
    };
    process.on('unhandledRejection', app.unhandledRejectionHandler);
    process.on('uncaughtException', app.uncaughtExceptionHandler);

    app.processHandlersRegistered = true;
}

export function unregisterProcessHandlers(app: any): void {
    if (!app.processHandlersRegistered) return;
    if (app.sigTermHandler) process.removeListener('SIGTERM', app.sigTermHandler);
    if (app.sigIntHandler) process.removeListener('SIGINT', app.sigIntHandler);
    if (app.unhandledRejectionHandler) process.removeListener('unhandledRejection', app.unhandledRejectionHandler);
    if (app.uncaughtExceptionHandler) process.removeListener('uncaughtException', app.uncaughtExceptionHandler);
    app.sigTermHandler = null;
    app.sigIntHandler = null;
    app.unhandledRejectionHandler = null;
    app.uncaughtExceptionHandler = null;
    app.processHandlersRegistered = false;
}
