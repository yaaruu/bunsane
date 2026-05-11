import ApplicationLifecycle, {
    ApplicationPhase,
    type PhaseChangeEvent,
} from "./ApplicationLifecycle";
import {
    GenerateTableName,
    HasValidBaseTable,
    PrepareDatabase,
    UpdateComponentIndexes,
    EnsureDatabaseMigrations,
} from "../database/DatabaseHelper";
import { ComponentRegistry } from "./components";
import { logger as MainLogger } from "./Logger";
const logger = MainLogger.child({ scope: "App" });
import ServiceRegistry from "../service/ServiceRegistry";
import { type Plugin, createPubSub } from "graphql-yoga";
import * as path from "path";
import { OpenAPISpecGenerator, type SwaggerEndpointMetadata } from "../swagger";
import type BasePlugin from "../plugins";
import { preparedStatementCache } from "../database/PreparedStatementCache";
import db from "../database";
import { type Middleware, composeMiddleware } from "./Middleware";
import { validateEnv } from "./validateEnv";
import type { RemoteManager, RemoteManagerConfig } from "./remote";
import type { CacheConfig } from "../config/cache.config";
import { assertValidCorsConfig } from "./app/cors";
import {
    registerProcessHandlers as registerProcessHandlersFn,
    unregisterProcessHandlers as unregisterProcessHandlersFn,
} from "./app/processHandlers";
import { runShutdown } from "./app/shutdown";
import { warmUpPreparedStatementCache as warmUpPreparedStatementCacheFn } from "./app/preparedStatementWarmup";
import { collectMetrics as collectMetricsFn } from "./app/metricsCollector";
import { createPhaseListener } from "./app/bootstrap";
import { handleRequest as handleRequestFn } from "./app/requestRouter";

export type CorsConfig = {
    origin?: string | string[] | ((origin: string) => boolean);
    credentials?: boolean;
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    methods?: string[];
    maxAge?: number;
};

export type AppConfig = {
    scheduler: {
        logging: boolean;
    };
    cors?: CorsConfig;
};

export default class App {
    private name: string = "BunSane Application";
    private version: string = "1.0.0";
    private yoga: any;
    private yogaPlugins: Plugin[] = [];
    private contextFactory?: (context: any) => any;
    private restEndpoints: Array<{
        method: string;
        path: string;
        handler: Function;
        service: any;
    }> = [];
    private restEndpointMap: Map<
        string,
        { method: string; path: string; handler: Function; service: any }
    > = new Map();
    private staticAssets: Map<string, string> = new Map();
    private openAPISpecGenerator: OpenAPISpecGenerator | null = null;
    private enforceDocs: boolean = false;

    private appReadyCallbacks: Array<() => void> = [];

    private plugins: BasePlugin[] = [];
    private middlewares: Middleware[] = [];
    private composedHandler: ((req: Request) => Promise<Response>) | null = null;

    private studioEnabled: boolean = false;
    private remote: RemoteManager | null = null;
    private remoteConfig: Partial<RemoteManagerConfig> | null = null;
    private server: ReturnType<typeof Bun.serve> | null = null;
    private isShuttingDown = false;
    private isReady = false;
    private cacheConfig: Partial<CacheConfig> | null = null;
    private requestContextPluginEnabled = true;
    private phaseListener: ((event: PhaseChangeEvent) => void) | null = null;
    private signalHandlersRegistered = false;
    private processHandlersRegistered = false;
    private sigTermHandler: (() => void) | null = null;
    private sigIntHandler: (() => void) | null = null;
    private unhandledRejectionHandler: ((reason: unknown, promise: Promise<unknown>) => void) | null = null;
    private uncaughtExceptionHandler: ((error: Error) => void) | null = null;
    private graphqlMaxDepth: number = 10;
    private graphqlMaxComplexity: number = 1000;
    private shutdownGracePeriod = 10_000;
    private maxRequestBodySize = 50 * 1024 * 1024; // 50MB default

    pubSub = createPubSub();

    public config: AppConfig = {
        scheduler: {
            logging: false,
        },
    };

    constructor(appName?: string, appVersion?: string) {
        if (appName) this.name = appName;
        if (appVersion) this.version = appVersion;
        this.openAPISpecGenerator = new OpenAPISpecGenerator(
            this.name,
            this.version
        );

        // Automatically serve the studio if it exists
        const studioPath = path.join(
            import.meta.dirname,
            "..",
            "studio",
            "dist"
        );
        try {
            const studioDir = Bun.file(studioPath);
            if (studioDir) {
                this.addStaticAssets("/studio", studioPath);
                logger.info("Studio assets loaded from:" + studioPath);
            }
        } catch (error) {
            logger.warn(
                "Studio not found, skipping studio setup:",
                error as any
            );
        }

        return this;
    }

    public setCors(cors: CorsConfig) {
        assertValidCorsConfig(cors);
        this.config.cors = cors;
    }

    async init() {
        // Register process-level error handlers FIRST so failures during init
        // (DB prep, component registration, schema build) are observable. If
        // registration happens later (e.g. in start()) any boot-sequence
        // unhandled rejection is silently discarded by the runtime.
        this.registerProcessHandlers();

        validateEnv();
        logger.trace(`Initializing App`);
        ComponentRegistry.init();
        ServiceRegistry.init();
        
        // Initialize CacheManager with merged config. MUST await â€” initialize()
        // is async and sets up pub/sub for cross-instance invalidation. Previously
        // only getInstance() was called, silently skipping pub/sub setup and
        // ignoring any app-supplied config (C04).
        try {
            const { CacheManager } = await import('./cache/CacheManager');
            const cacheManager = CacheManager.getInstance();
            await cacheManager.initialize(this.cacheConfig ?? {});
            const config = cacheManager.getConfig();
            logger.info({ scope: 'cache', component: 'App', msg: 'CacheManager initialized', provider: config.provider, enabled: config.enabled, strategy: config.strategy });
        } catch (error) {
            logger.warn({ scope: 'cache', component: 'App', msg: 'Failed to initialize CacheManager', err: error });
        }
        
        // Plugin initialization
        for (const plugin of this.plugins) {
            if (plugin.init) {
                await plugin.init(this);
            }
        }

        // Remove any previous listener so repeated init() calls (tests) don't
        // stack handlers on the lifecycle singleton.
        if (this.phaseListener) {
            ApplicationLifecycle.removePhaseListener(this.phaseListener);
        }
        this.phaseListener = createPhaseListener(this);
        ApplicationLifecycle.addPhaseListener(this.phaseListener);

        if (
            ApplicationLifecycle.getCurrentPhase() ===
            ApplicationPhase.DATABASE_INITIALIZING
        ) {
            if (!(await HasValidBaseTable())) {
                await PrepareDatabase();
            } else {
                // Check for missing columns and run migrations
                await EnsureDatabaseMigrations();
            }
            logger.trace(`Database prepared...`);
            ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
            await ComponentRegistry.registerAllComponents();
            ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_REGISTERING);
        }
    }

    /**
     * Resolve once the application has reached APPLICATION_READY. Previously
     * polled every 100ms with no exit condition â€” a boot failure would keep
     * the interval timer alive forever (H-MEM-1). Now attaches a one-shot
     * phase listener and self-cleans on first match. Bounded by `timeoutMs`
     * so callers cannot hang indefinitely; default matches waitForPhase.
     */
    waitForAppReady(timeoutMs = 60_000): Promise<void> {
        if (ApplicationLifecycle.getCurrentPhase() >= ApplicationPhase.APPLICATION_READY) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ApplicationLifecycle.removePhaseListener(onPhase);
                reject(new Error(`waitForAppReady timed out after ${timeoutMs}ms; current phase=${ApplicationLifecycle.getCurrentPhase()}`));
            }, timeoutMs);
            timer.unref?.();
            const onPhase = (event: PhaseChangeEvent) => {
                if (event.detail === ApplicationPhase.APPLICATION_READY) {
                    clearTimeout(timer);
                    ApplicationLifecycle.removePhaseListener(onPhase);
                    resolve();
                }
            };
            ApplicationLifecycle.addPhaseListener(onPhase);
        });
    }

    public addOpenAPISchema(name: string, schema: any) {
        this.openAPISpecGenerator!.addSchema(name, schema);
    }
    public addOpenAPIServer(url: string, description?: string) {
        this.openAPISpecGenerator!.addServer(url, description);
    }

    public addYogaPlugin(plugin: Plugin) {
        this.yogaPlugins.push(plugin);
    }

    public setGraphQLContextFactory(factory: (context: any) => any) {
        this.contextFactory = factory;
    }

    public addPlugin(plugin: BasePlugin) {
        this.plugins.push(plugin);
    }

    /**
     * Register an HTTP middleware. Middlewares execute in registration order,
     * wrapping around the core request handler (onion model).
     */
    public use(middleware: Middleware) {
        this.middlewares.push(middleware);
    }

    public addStaticAssets(route: string, folder: string) {
        // Resolve the folder path relative to the current working directory
        const resolvedFolder = path.resolve(folder);
        this.staticAssets.set(route, resolvedFolder);
    }

    private async handleRequest(req: Request): Promise<Response> {
        return handleRequestFn(this, req);
    }

    public setName(name: string) {
        this.name = name;
    }

    public getName(): string {
        return this.name;
    }

    public setVersion(version: string) {
        this.version = version;
    }

    /**
     * Enable remote cross-app communication over Redis Streams.
     * Must be called before `init()` (initialization happens in SYSTEM_READY).
     * `appName` defaults to the app name.
     */
    public enableRemote(config: Partial<RemoteManagerConfig> = {}) {
        this.remoteConfig = config;
    }

    public getRemote(): RemoteManager | null {
        return this.remote;
    }

    public subscribeAppReady(callback: () => void) {
        this.appReadyCallbacks.push(callback);
    }

    public enforceSwaggerDocs(value: boolean) {
        this.enforceDocs = value;
    }

    public enableStudio() {
        this.studioEnabled = true;
        logger.info("Studio API enabled");
    }

    /**
     * Set the maximum allowed GraphQL query depth. 0 disables the limit.
     */
    public setGraphQLMaxDepth(depth: number) {
        this.graphqlMaxDepth = depth;
    }

    /**
     * Set the maximum GraphQL query complexity. 0 disables.
     * Complexity = sum of per-field costs, multiplied by `first`/`limit`/`take`
     * arguments when present on each field.
     */
    public setGraphQLMaxComplexity(complexity: number) {
        this.graphqlMaxComplexity = complexity;
    }

    /**
     * Supply a cache configuration that will be merged with `defaultCacheConfig`
     * and passed to `CacheManager.initialize()` during `init()`. Must be called
     * before `init()`.
     */
    public setCacheConfig(config: Partial<CacheConfig>) {
        this.cacheConfig = config;
    }

    /**
     * Disable the auto-applied RequestContext plugin. Only do this if your
     * app does not use `@BelongsTo` / `@HasMany` relations OR you are
     * supplying your own DataLoader plugin. Without it, nested relation
     * resolvers issue one DB query per row (N+1).
     */
    public disableRequestContextPlugin() {
        this.requestContextPluginEnabled = false;
    }

    /**
     * Set the grace period for draining connections during shutdown (ms).
     */
    public setShutdownGracePeriod(ms: number) {
        this.shutdownGracePeriod = ms;
    }

    /**
     * Set the maximum request body size in bytes (default: 50MB).
     * Rejects oversized requests at the HTTP layer before buffering.
     */
    public setMaxRequestBodySize(bytes: number) {
        this.maxRequestBodySize = bytes;
    }

    private async warmUpPreparedStatementCache(): Promise<void> {
        return warmUpPreparedStatementCacheFn(this);
    }

    private async collectMetrics() {
        return collectMetricsFn(this);
    }

    async start() {
        logger.info("Application Started");
        const port = parseInt(process.env.APP_PORT || "3000");

        // Read env overrides
        const envGracePeriod = process.env.SHUTDOWN_GRACE_PERIOD_MS;
        if (envGracePeriod) {
            this.shutdownGracePeriod = parseInt(envGracePeriod, 10);
        }
        const envBodySize = process.env.MAX_REQUEST_BODY_SIZE;
        if (envBodySize) {
            this.maxRequestBodySize = parseInt(envBodySize, 10);
        }

        // Compose middleware chain around the core request handler
        this.composedHandler = composeMiddleware(
            this.middlewares,
            this.handleRequest.bind(this),
        );

        this.server = Bun.serve({
            idleTimeout: 0, // Disable idle timeout because we have subscriptions
            port: port,
            maxRequestBodySize: this.maxRequestBodySize,
            fetch: this.composedHandler,
        });

        // Update the OpenAPI spec with the actual server URL
        this.openAPISpecGenerator!.addServer(
            `http://localhost:${port}`,
            "Development server"
        );

        logger.info(
            `Server is running on ${new URL(
                this.yoga?.graphqlEndpoint || "/graphql",
                `http://${this.server.hostname}:${this.server.port}`
            )}`
        );

        // Signal handlers now registered in init() via registerProcessHandlers()
        // so they cover the boot sequence (before start() runs).

        this.isReady = true;
        this.appReadyCallbacks.forEach((cb) => cb());
    }

    /**
     * Register process-level signal and error handlers. Called at the top of
     * `init()` so that failures during boot (DB prep, component registration,
     * schema build) are logged and don't silently crash the runtime.
     *
     * Uses `process.once` for signals so a double SIGTERM can't fire two
     * concurrent shutdown paths racing each other to `process.exit`. Also
     * idempotent â€” safe to call multiple times (e.g. in tests).
     */
    private registerProcessHandlers(): void {
        registerProcessHandlersFn(this);
    }

    private unregisterProcessHandlers(): void {
        unregisterProcessHandlersFn(this);
    }

    /**
     * Gracefully shutdown the application.
     *
     * Ordered drain: HTTP â†’ scheduler â†’ remote â†’ cache â†’ database. Each step
     * awaits completion before the next begins so in-flight work always sees
     * its dependencies still available. Total budget bounded by
     * `shutdownGracePeriod`; per-step budgets fall back to reasonable defaults.
     */
    async shutdown(): Promise<void> {
        return runShutdown(this);
    }
}
