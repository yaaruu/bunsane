import ApplicationLifecycle, {
    ApplicationPhase,
    type PhaseChangeEvent,
} from "./ApplicationLifecycle";
import {
    GenerateTableName,
    HasValidBaseTable,
    PrepareDatabase,
    EnsureDatabaseMigrations,
    InitializeProjections,
} from "../database/DatabaseHelper";
import { InitializeReadModels } from "../database/readmodel";
import { ComponentRegistry } from "./components";
import { logger as MainLogger } from "./Logger";
import { existsSync, readFileSync } from "fs";
const logger = MainLogger.child({ scope: "App" });

// BunSane framework version, read from the package's own package.json at module
// load. Resolved relative to this module file so it works regardless of cwd or
// how the consumer installs the package.
let BUNSANE_VERSION = "unknown";
try {
    BUNSANE_VERSION = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ).version;
} catch {
    // version stays "unknown" if package.json can't be read
}
import ServiceRegistry from "../service/ServiceRegistry";
import { type Plugin, createPubSub } from "graphql-yoga";
import * as path from "path";
import { OpenAPISpecGenerator, type SwaggerEndpointMetadata } from "../swagger";
import type BasePlugin from "../plugins";
import db from "../database";
import { probeConnection } from "../database/connectionProbe";
import { armGateway } from "../database/gateway";
import { type Middleware, type MiddlewareContext, composeMiddleware } from "./Middleware";
import { securityHeaders, type SecurityHeadersOptions } from "./middleware/SecurityHeaders";
import { requestId } from "./middleware/RequestId";
import { addCorsHeaders, assertValidCorsConfig } from "./app/cors";
import { validateEnv } from "./validateEnv";
import type { RemoteManager, RemoteManagerConfig } from "./remote";
import type { CacheConfig } from "../config/cache.config";
import {
    registerProcessHandlers as registerProcessHandlersFn,
    unregisterProcessHandlers as unregisterProcessHandlersFn,
} from "./app/processHandlers";
import { runShutdown } from "./app/shutdown";
import { collectMetrics as collectMetricsFn } from "./app/metricsCollector";
import { createPhaseListener } from "./app/bootstrap";
import { handleRequest as handleRequestFn, type RequestHost } from "./app/requestRouter";
import { qspActive, startReconcileSweep } from "../database/projection";
import { scheduleBackgroundIndexReconcile } from "../database/indexReconciler";
import { defaultStudioDistDir, resolveStudioDist } from "./app/studioAssets";
import {
    assertGraphQLComplexity,
    assertGraphQLDepth,
    assertNonNegativeMs,
    CLOSED_INFO_ACCESS,
    DEFAULT_GRAPHQL_MAX_COMPLEXITY,
    DEFAULT_JSON_BODY_LIMIT,
    DEFAULT_MAX_REQUEST_BODY_SIZE,
    DEFAULT_REQUEST_TIMEOUT_MS,
    GRAPHQL_MIN_DEPTH,
    type InfoAccess,
} from "./app/limits";

export type CorsConfig = {
    origin?: string | string[] | ((origin: string) => boolean);
    credentials?: boolean;
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    methods?: string[];
    maxAge?: number;
};

export type AppConfig = {
    name?: string;
    version?: string;
    port?: number;
    scheduler?: {
        logging?: boolean;
    };
    cors?: CorsConfig;
    /** Wall-clock timeout in ms. 0 disables. Default 30000. Also REQUEST_TIMEOUT_MS. */
    requestTimeoutMs?: number;
    bodyLimits?: {
        /** Absolute Bun.serve cap. Default 50MB. Also MAX_REQUEST_BODY_SIZE. */
        max?: number;
        /** Non-multipart bodies. Default 1MB. Also JSON_BODY_LIMIT. */
        json?: number;
        /** Multipart bodies. Default = max. Also MULTIPART_BODY_LIMIT. */
        multipart?: number;
    };
    graphql?: {
        maxDepth?: number;
        maxComplexity?: number;
        introspection?: boolean;
        graphiql?: boolean;
    };
    studio?: {
        token?: string;
        /** Override the dist directory. Missing index.html skips asset registration. */
        assetsPath?: string;
    };
    metrics?: { token?: string; public?: boolean };
    docs?: { token?: string; public?: boolean };
    /** false opts out of the default security-headers middleware. */
    securityHeaders?: boolean | SecurityHeadersOptions;
    /** false opts out of the default request-id middleware. */
    requestId?: boolean;
    shutdownGracePeriodMs?: number;
    cache?: Partial<CacheConfig>;
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
    private composedHandler: ((req: Request, ctx?: MiddlewareContext) => Promise<Response>) | null = null;

    private studioEnabled: boolean = false;
    private studioAuthToken: string | null = null;
    private studioAssetsPath: string | null = null;
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
    private _graphqlMaxDepth: number = GRAPHQL_MIN_DEPTH;
    private _graphqlMaxComplexity: number = DEFAULT_GRAPHQL_MAX_COMPLEXITY;
    private depthExplicit = false;
    private complexityExplicit = false;
    /** Undefined means unset. GraphQL setup applies env, then development mode. */
    public graphqlIntrospection: boolean | undefined;
    public graphqlGraphiQL: boolean | undefined;
    private shutdownGracePeriod = 10_000;
    private graceExplicit = false;
    private maxRequestBodySize = DEFAULT_MAX_REQUEST_BODY_SIZE;
    private bodySizeExplicit = false;
    private jsonBodyLimit = DEFAULT_JSON_BODY_LIMIT;
    private jsonLimitExplicit = false;
    private multipartBodyLimit = DEFAULT_MAX_REQUEST_BODY_SIZE;
    private multipartLimitExplicit = false;
    private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    private timeoutExplicit = false;
    private port: number | undefined;
    private portExplicit = false;
    private studioIndexHtml: string | null = null;
    private studioMissingLogged = false;
    private metricsAccess: InfoAccess = { ...CLOSED_INFO_ACCESS };
    private docsAccess: InfoAccess = { ...CLOSED_INFO_ACCESS };
    private metricsExplicit = false;
    private docsExplicit = false;
    private securityHeadersEnabled = true;
    private securityHeadersOptions: SecurityHeadersOptions = {};
    private requestIdEnabled = true;
    private reconcileStop: (() => void) | null = null;
    /** Set when shutdown drain or a stop step fails. Signal handlers exit non-zero. */
    public shutdownFailed = false;

    pubSub = createPubSub();

    public config: AppConfig = {
        scheduler: {
            logging: false,
        },
    };

    /** Read by GraphQL setup. Floor is 15; 0 does not disable. */
    public get graphqlMaxDepth(): number {
        return this._graphqlMaxDepth;
    }

    /** Read by GraphQL setup. Floor is 1; 0 does not disable. */
    public get graphqlMaxComplexity(): number {
        return this._graphqlMaxComplexity;
    }

    constructor(appNameOrConfig?: string | AppConfig, appVersion?: string) {
        let studioToken: string | undefined;
        if (appNameOrConfig && typeof appNameOrConfig === "object") {
            studioToken = appNameOrConfig.studio?.token;
            this.applyConfig(appNameOrConfig);
        } else {
            if (appNameOrConfig) this.name = appNameOrConfig;
            if (appVersion) this.version = appVersion;
        }
        this.openAPISpecGenerator = new OpenAPISpecGenerator(this.name, this.version);
        this.detectStudioDist();
        if (studioToken) this.enableStudio({ token: studioToken });
    }

    private applyConfig(config: AppConfig): void {
        if (config.name) this.name = config.name;
        if (config.version) this.version = config.version;
        if (config.scheduler?.logging !== undefined) {
            this.config.scheduler = { logging: config.scheduler.logging };
        }
        if (config.cors) this.setCors(config.cors);
        if (config.port !== undefined) this.setPort(config.port);
        if (config.requestTimeoutMs !== undefined) this.setRequestTimeout(config.requestTimeoutMs);
        if (config.shutdownGracePeriodMs !== undefined) this.setShutdownGracePeriod(config.shutdownGracePeriodMs);
        if (config.bodyLimits?.max !== undefined) this.setMaxRequestBodySize(config.bodyLimits.max);
        if (config.bodyLimits?.json !== undefined) this.setJsonBodyLimit(config.bodyLimits.json);
        if (config.bodyLimits?.multipart !== undefined) this.setMultipartBodyLimit(config.bodyLimits.multipart);
        if (config.graphql?.maxDepth !== undefined) this.setGraphQLMaxDepth(config.graphql.maxDepth);
        if (config.graphql?.maxComplexity !== undefined) this.setGraphQLMaxComplexity(config.graphql.maxComplexity);
        if (config.graphql?.introspection !== undefined) this.setGraphQLIntrospection(config.graphql.introspection);
        if (config.graphql?.graphiql !== undefined) this.setGraphQLGraphiQL(config.graphql.graphiql);
        if (config.cache) this.setCacheConfig(config.cache);
        if (config.securityHeaders === false) this.setSecurityHeaders(false);
        else if (config.securityHeaders && typeof config.securityHeaders === "object") {
            this.setSecurityHeaders(config.securityHeaders);
        }
        if (config.requestId === false) this.setRequestId(false);
        if (config.metrics) this.setMetricsAccess(config.metrics);
        if (config.docs) this.setDocsAccess(config.docs);
        if (config.studio?.assetsPath !== undefined) {
            this.studioAssetsPath = resolveStudioDist(config.studio.assetsPath);
            this.studioMissingLogged = this.studioAssetsPath === null;
        }
    }

    private detectStudioDist(): void {
        if (this.studioAssetsPath || this.studioMissingLogged) return;
        const dist = resolveStudioDist(defaultStudioDistDir());
        if (dist) {
            this.studioAssetsPath = dist;
            return;
        }
        this.studioMissingLogged = true;
        logger.warn(
            "Studio dist not found (no index.html). Asset registration skipped. Run `bun run build:studio`.",
        );
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
        this.applyUnlockedEnv();
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
            // Verify connection assumptions (transaction pooling,
            // statement_timeout) before anything depends on them. Never
            // throws; logs at error when a documented mitigation is inert.
            await probeConnection();
            if (!(await HasValidBaseTable())) {
                await PrepareDatabase();
            } else {
                // Check for missing columns and run migrations
                await EnsureDatabaseMigrations();
            }
            logger.trace(`Database prepared...`);
            await InitializeProjections();
            // Engage DB admission only now: boot DDL and migrations run dozens of
            // statements that gain nothing from being bounded and would be
            // serialized behind a limit derived before the pool is warm.
            armGateway();
            ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
            await ComponentRegistry.registerAllComponents();
            // After partitions exist so M3 rebuild can scan LIST leaves.
            await InitializeReadModels();
            ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_REGISTERING);
        }
        this.ensureReconcileSweep();
        scheduleBackgroundIndexReconcile();
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
        if (this.server) {
            throw new Error(
                "app.use() after start() has no effect: middleware is composed when start() runs. Register middleware before start().",
            );
        }
        this.middlewares.push(middleware);
    }

    public addStaticAssets(route: string, folder: string) {
        // Resolve the folder path relative to the current working directory
        const resolvedFolder = path.resolve(folder);
        this.staticAssets.set(route, resolvedFolder);
    }

    private async handleRequest(req: Request): Promise<Response> {
        // Private fields are visible at runtime; RequestHost is the router's contract.
        return handleRequestFn(this as unknown as RequestHost, req);
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

    /**
     * Enable the Studio admin UI + API. Requires a bearer token: pass
     * `{ token }` or set `BUNSANE_STUDIO_TOKEN` (min 16 chars). Without a
     * token the call is REFUSED and studio stays fully disabled — every
     * /studio route 404s (SEC-01, deny-by-default).
     */
    public enableStudio(options?: { token?: string }): boolean {
        const token =
            options?.token ??
            process.env.BUNSANE_STUDIO_TOKEN ??
            null;

        if (!token || token.length < 16) {
            logger.error(
                "enableStudio() refused: a studio access token is required " +
                "(pass { token } or set BUNSANE_STUDIO_TOKEN, min 16 chars). " +
                "Studio remains fully disabled."
            );
            return false;
        }

        this.studioAuthToken = token;

        if (this.studioAssetsPath && existsSync(path.join(this.studioAssetsPath, "index.html"))) {
            this.addStaticAssets("/studio", this.studioAssetsPath);
            logger.info("Studio assets loaded from: " + this.studioAssetsPath);
        } else {
            this.warnStudioMissing();
        }

        this.studioEnabled = true;
        logger.info("Studio API enabled (token required)");
        return true;
    }

    /**
     * Set the maximum allowed GraphQL query depth. Must be an integer >= 15.
     * 0 does not disable the limit.
     */
    public setGraphQLMaxDepth(depth: number) {
        this._graphqlMaxDepth = assertGraphQLDepth(depth);
        this.depthExplicit = true;
    }

    /**
     * Set the maximum GraphQL query complexity. Must be an integer >= 1.
     * 0 does not disable the limit.
     */
    public setGraphQLMaxComplexity(complexity: number) {
        this._graphqlMaxComplexity = assertGraphQLComplexity(complexity);
        this.complexityExplicit = true;
    }

    public setGraphQLIntrospection(enabled: boolean) {
        this.graphqlIntrospection = enabled;
    }

    public setGraphQLGraphiQL(enabled: boolean) {
        this.graphqlGraphiQL = enabled;
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
        this.shutdownGracePeriod = assertNonNegativeMs("setShutdownGracePeriod", ms);
        this.graceExplicit = true;
    }

    /**
     * Absolute request body cap enforced by Bun.serve (default 50MB).
     * Does not raise the JSON limit (1MB) — use setJsonBodyLimit for that.
     */
    public setMaxRequestBodySize(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            throw new Error(`setMaxRequestBodySize(${bytes}) must be a positive byte count`);
        }
        this.maxRequestBodySize = bytes;
        this.bodySizeExplicit = true;
        if (!this.multipartLimitExplicit) this.multipartBodyLimit = bytes;
    }

    /** Non-multipart body cap. Default 1MB. */
    public setJsonBodyLimit(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            throw new Error(`setJsonBodyLimit(${bytes}) must be a positive byte count`);
        }
        this.jsonBodyLimit = bytes;
        this.jsonLimitExplicit = true;
    }

    /** Multipart body cap. Default follows setMaxRequestBodySize / 50MB. */
    public setMultipartBodyLimit(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            throw new Error(`setMultipartBodyLimit(${bytes}) must be a positive byte count`);
        }
        this.multipartBodyLimit = bytes;
        this.multipartLimitExplicit = true;
    }

    /** Wall-clock request timeout in ms. 0 disables. Default 30000. */
    public setRequestTimeout(ms: number) {
        this.requestTimeoutMs = assertNonNegativeMs("setRequestTimeout", ms);
        this.timeoutExplicit = true;
    }

    public setPort(port: number) {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`setPort(${port}) must be an integer from 1 to 65535`);
        }
        this.port = port;
        this.portExplicit = true;
    }

    /** Pass false to skip the default security-headers middleware. */
    public setSecurityHeaders(options: SecurityHeadersOptions | false) {
        this.rejectAfterStart("setSecurityHeaders");
        if (options === false) {
            this.securityHeadersEnabled = false;
            this.securityHeadersOptions = {};
            return;
        }
        this.securityHeadersEnabled = true;
        this.securityHeadersOptions = options;
    }

    /** Pass false to skip the default request-id middleware. */
    public setRequestId(enabled: boolean) {
        this.rejectAfterStart("setRequestId");
        this.requestIdEnabled = enabled;
    }

    public setMetricsAccess(access: { token?: string; public?: boolean }) {
        this.metricsAccess = {
            token: access.token ?? this.metricsAccess.token,
            public: access.public ?? false,
        };
        this.metricsExplicit = true;
    }

    public setDocsAccess(access: { token?: string; public?: boolean }) {
        this.docsAccess = {
            token: access.token ?? this.docsAccess.token,
            public: access.public ?? false,
        };
        this.docsExplicit = true;
    }

    /**
     * Re-weave the GraphQL schema from the currently registered services and
     * swap it into the live Yoga instance — no restart, no Yoga recreation.
     * The next request observes the new schema (Yoga reads it via a factory).
     *
     * Phase 0 primitive for runtime schema mutation: register/modify a service
     * (or its @GraphQLOperation metadata), then call this to reflect it live.
     * Returns the new schema version number (monotonic, starts at 1).
     */
    public rebuildGraphQLSchema(): number {
        ServiceRegistry.rebuildSchema();
        return ServiceRegistry.getSchemaVersion();
    }


    private async collectMetrics() {
        return collectMetricsFn(this);
    }

    async start() {
        if (this.server) {
            logger.warn("App.start() called again; ignoring. The server is already listening.");
            return;
        }
        this.applyUnlockedEnv();
        this.resolveListenConfig();

        const chain: Middleware[] = [];
        if (this.requestIdEnabled) chain.push(requestId());
        if (this.securityHeadersEnabled) chain.push(securityHeaders(this.securityHeadersOptions));
        chain.push(...this.middlewares);
        this.composedHandler = composeMiddleware(chain, (req) => this.handleRequest(req));

        const port = this.portExplicit ? this.port! : parseInt(process.env.APP_PORT || "3000", 10);
        const bunCap = Math.max(this.maxRequestBodySize, this.jsonBodyLimit, this.multipartBodyLimit);
        logger.info("Application Started");

        this.server = Bun.serve({
            idleTimeout: 0, // Disable idle timeout because we have subscriptions
            port,
            maxRequestBodySize: bunCap,
            fetch: async (req, server): Promise<Response> => {
                const addr = server.requestIP(req);
                const ctx: MiddlewareContext = { clientIp: addr?.address };
                const response = await this.composedHandler!(req, ctx);
                return addCorsHeaders(response, this.config.cors, req);
            },
        });

        this.openAPISpecGenerator!.addServer(
            `http://localhost:${port}`,
            "Development server"
        );

        logger.info(
            `Server is running on ${new URL(
                this.yoga?.graphqlEndpoint || "/graphql",
                `http://${this.server.hostname}:${this.server.port}`
            )} (BunSane v${BUNSANE_VERSION})`
        );

        this.isReady = true;
        this.appReadyCallbacks.forEach((cb) => cb());
    }

    private applyUnlockedEnv(): void {
        if (!this.depthExplicit && process.env.GRAPHQL_MAX_DEPTH) {
            this.setGraphQLMaxDepth(parseInt(process.env.GRAPHQL_MAX_DEPTH, 10));
        }
        if (!this.complexityExplicit && process.env.GRAPHQL_MAX_COMPLEXITY) {
            this.setGraphQLMaxComplexity(parseInt(process.env.GRAPHQL_MAX_COMPLEXITY, 10));
        }
    }

    private resolveListenConfig(): void {
        if (!this.timeoutExplicit && process.env.REQUEST_TIMEOUT_MS) {
            this.requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS, 10);
        }
        if (!this.graceExplicit && process.env.SHUTDOWN_GRACE_PERIOD_MS) {
            this.shutdownGracePeriod = parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS, 10);
        }
        if (!this.bodySizeExplicit && process.env.MAX_REQUEST_BODY_SIZE) {
            this.maxRequestBodySize = parseInt(process.env.MAX_REQUEST_BODY_SIZE, 10);
            if (!this.multipartLimitExplicit) this.multipartBodyLimit = this.maxRequestBodySize;
        }
        if (!this.jsonLimitExplicit && process.env.JSON_BODY_LIMIT) {
            this.jsonBodyLimit = parseInt(process.env.JSON_BODY_LIMIT, 10);
        }
        if (!this.multipartLimitExplicit && process.env.MULTIPART_BODY_LIMIT) {
            this.multipartBodyLimit = parseInt(process.env.MULTIPART_BODY_LIMIT, 10);
        }
        if (!this.metricsExplicit) {
            this.metricsAccess = {
                token: process.env.BUNSANE_METRICS_TOKEN || null,
                public: process.env.BUNSANE_METRICS === "public",
            };
        }
        if (!this.docsExplicit) {
            this.docsAccess = {
                token: process.env.BUNSANE_DOCS_TOKEN || null,
                public: process.env.BUNSANE_DOCS === "public",
            };
        }
    }

    private ensureReconcileSweep(): void {
        if (this.reconcileStop || !qspActive()) return;
        this.reconcileStop = startReconcileSweep();
        logger.info("QSP reconcile sweep started");
    }

    private warnStudioMissing(): void {
        if (this.studioMissingLogged) return;
        this.studioMissingLogged = true;
        logger.error(
            "Studio dist is missing (no index.html). Assets were not registered. Run `bun run build:studio`.",
        );
    }

    private rejectAfterStart(method: string): void {
        if (!this.server) return;
        throw new Error(`${method}() after start() has no effect. Call it before start().`);
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
