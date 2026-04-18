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
import { getSerializedMetadataStorage } from "./metadata";
const logger = MainLogger.child({ scope: "App" });
import { createYogaInstance } from "../gql";
import ServiceRegistry from "../service/ServiceRegistry";
import { type Plugin, createPubSub } from "graphql-yoga";
import * as path from "path";
import { SchedulerManager } from "./SchedulerManager";
import { registerScheduledTasks } from "../scheduler";
import { OpenAPISpecGenerator, type SwaggerEndpointMetadata } from "../swagger";
import type BasePlugin from "../plugins";
import { preparedStatementCache } from "../database/PreparedStatementCache";
import db from "../database";
import studioEndpoint from "../endpoints";
import { type Middleware, composeMiddleware } from "./Middleware";
import { deepHealthCheck, readinessCheck } from "./health";
import { validateEnv } from "./validateEnv";
import {
    RemoteManager,
    registerRemoteHandlers,
    setRemoteManager,
} from "./remote";
import type { RemoteManagerConfig } from "./remote";
import type { CacheConfig } from "../config/cache.config";
import { createRequestContextPlugin } from "./RequestContext";

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
        this.config.cors = cors;
        // Warn about invalid configuration
        if (cors.credentials && cors.origin === '*') {
            console.warn('[CORS] Warning: credentials=true with origin="*" is invalid per spec. Origin will be reflected from request.');
        }
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
        
        // Initialize CacheManager with merged config. MUST await — initialize()
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
        this.phaseListener = async (event: PhaseChangeEvent) => {
            const phase = event.detail;
            logger.info(`Application phase changed to: ${phase}`);
            // Notify plugins of phase change
            for (const plugin of this.plugins) {
                if (plugin.onPhaseChange) {
                    await plugin.onPhaseChange(phase, this);
                }
            }
            switch (phase) {
                case ApplicationPhase.DATABASE_READY: {
                    // Warm up prepared statement cache with common query patterns
                    try {
                        await this.warmUpPreparedStatementCache();
                    } catch (error) {
                        logger.warn(
                            "Failed to warm up prepared statement cache:",
                            error as any
                        );
                    }
                    break;
                }
                case ApplicationPhase.SYSTEM_READY: {
                    // Perform cache health check
                    try {
                        const { CacheManager } = await import('./cache/CacheManager');
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
                        const schema = ServiceRegistry.getSchema();

                        // Wrap user's context factory to automatically spread Yoga context
                        const wrappedContextFactory = this.contextFactory
                            ? async (yogaContext: any) => {
                                  const userContext =
                                      await this.contextFactory!(yogaContext);
                                  // Merge Yoga's context with user's context, preserving Yoga properties
                                  return {
                                      ...yogaContext, // Yoga context (request, params, etc.)
                                      ...userContext, // User's additional context
                                  };
                              }
                            : undefined;

                        // Read env override for GraphQL depth limit
                        const envDepth = process.env.GRAPHQL_MAX_DEPTH;
                        if (envDepth) {
                            this.graphqlMaxDepth = parseInt(envDepth, 10);
                        }

                        const yogaOptions = {
                            cors: this.config.cors,
                            maxDepth: this.graphqlMaxDepth || undefined,
                        };

                        // Auto-apply RequestContext plugin by default so
                        // apps using @BelongsTo / @HasMany get DataLoader
                        // batching without opt-in. Prevents N+1 query
                        // explosion. Opt out via disableRequestContextPlugin().
                        const effectivePlugins: Plugin[] = this.requestContextPluginEnabled
                            ? [createRequestContextPlugin(), ...this.yogaPlugins]
                            : [...this.yogaPlugins];

                        if (schema) {
                            this.yoga = createYogaInstance(
                                schema,
                                effectivePlugins,
                                wrappedContextFactory,
                                yogaOptions
                            );
                        } else {
                            this.yoga = createYogaInstance(
                                undefined,
                                effectivePlugins,
                                wrappedContextFactory,
                                yogaOptions
                            );
                        }

                        // Get all services for processing
                        const services = ServiceRegistry.getServices();

                        // Initialize Scheduler
                        const scheduler = SchedulerManager.getInstance();
                        scheduler.config.enableLogging =
                            this.config.scheduler.logging;

                        // Register scheduled tasks for all services
                        for (const service of services) {
                            try {
                                registerScheduledTasks(service);
                            } catch (error) {
                                logger.warn(
                                    `Failed to register scheduled tasks for service ${service.constructor.name}`
                                );
                                logger.warn(error);
                            }
                        }
                        logger.info(
                            `Registered scheduled tasks for ${services.length} services`
                        );

                        // Initialize RemoteManager (opt-in via enableRemote())
                        if (this.remoteConfig) {
                            try {
                                const rmConfig: RemoteManagerConfig = {
                                    appName:
                                        this.remoteConfig.appName ||
                                        this.name,
                                    ...this.remoteConfig,
                                };
                                this.remote = new RemoteManager(rmConfig);
                                setRemoteManager(this.remote);
                                await this.remote.start();

                                for (const service of services) {
                                    try {
                                        registerRemoteHandlers(service);
                                    } catch (error) {
                                        logger.warn(
                                            `Failed to register remote handlers for service ${service.constructor.name}`
                                        );
                                        logger.warn(error);
                                    }
                                }
                                logger.info(
                                    `RemoteManager initialized for app "${rmConfig.appName}"`
                                );
                            } catch (error) {
                                logger.error(
                                    "Failed to start RemoteManager:"
                                );
                                logger.error(error);
                            }
                        }

                        // Collect REST endpoints from all services
                        for (const service of services) {
                            const endpoints = (service.constructor as any)
                                .httpEndpoints;
                            if (endpoints) {
                                for (const endpoint of endpoints) {
                                    const endpointInfo = {
                                        method: endpoint.method,
                                        path: endpoint.path,
                                        handler: endpoint.handler.bind(service),
                                        service: service,
                                    };
                                    logger.trace(
                                        `Registered REST endpoint: [${endpoint.method}] ${endpoint.path} for service ${service.constructor.name}`
                                    );
                                    this.restEndpoints.push(endpointInfo);
                                    this.restEndpointMap.set(
                                        `${endpoint.method}:${endpoint.path}`,
                                        endpointInfo
                                    );

                                    // Check if this endpoint has a swagger operation
                                    if (
                                        (endpoint.handler as any)
                                            .swaggerOperation
                                    ) {
                                        // Collect tags from class and method decorators
                                        const classTags =
                                            (service.constructor as any)
                                                .swaggerClassTags || [];
                                        const methodTags =
                                            (service.constructor as any)
                                                .swaggerMethodTags?.[
                                                endpoint.handler.name
                                            ] || [];
                                        const allTags = [
                                            ...classTags,
                                            ...methodTags,
                                        ];

                                        logger.trace(
                                            `Generating OpenAPI spec for endpoint: [${
                                                endpoint.method
                                            }] ${
                                                endpoint.path
                                            } with tags: ${allTags.join(", ")}`
                                        );

                                        // Merge tags into the operation
                                        const operation = {
                                            ...(endpoint.handler as any)
                                                .swaggerOperation,
                                        };
                                        if (allTags.length > 0) {
                                            operation.tags = [
                                                ...(operation.tags || []),
                                                ...allTags,
                                            ];
                                        }

                                        this.openAPISpecGenerator!.addEndpoint({
                                            method: endpoint.method,
                                            path: endpoint.path,
                                            operation,
                                        });
                                        logger.trace(
                                            `Registered OpenAPI spec for endpoint: [${endpoint.method}] ${endpoint.path}`
                                        );
                                    } else {
                                        if (this.enforceDocs) {
                                            logger.warn(
                                                `No swagger operation found for endpoint: [${endpoint.method}] ${endpoint.path} in service ${service.constructor.name}`
                                            );
                                            this.openAPISpecGenerator!.addEndpoint(
                                                {
                                                    method: endpoint.method,
                                                    path: endpoint.path,
                                                    operation: {
                                                        summary: `No description for ${endpoint.path}. Don't use this endpoint until it's properly documented!`,
                                                        requestBody: {
                                                            content: {
                                                                "application/json":
                                                                    {
                                                                        schema: {},
                                                                    },
                                                            },
                                                        },
                                                        responses: {
                                                            "200": {
                                                                description:
                                                                    "Success",
                                                            },
                                                        },
                                                    },
                                                }
                                            );
                                        }
                                    }
                                }
                            }
                        }

                        ApplicationLifecycle.setPhase(
                            ApplicationPhase.APPLICATION_READY
                        );
                    } catch (error) {
                        // SYSTEM_READY failures must not be swallowed silently.
                        // Without this, the app stays forever in SYSTEM_READY
                        // (isReady=false, /health/ready → 503 forever) and k8s
                        // rollout hangs with no observable cause. Surface the
                        // failure so the readiness probe reports it and the
                        // orchestrator can restart.
                        this.isReady = false;
                        logger.fatal({ scope: 'app', component: 'App', err: error }, 'Fatal error during SYSTEM_READY phase — marking app unready');
                        // In production, exit so k8s can restart the pod.
                        // In tests, rethrow so the test sees the failure.
                        if (process.env.NODE_ENV === 'test') {
                            throw error;
                        }
                        // Give the logger a chance to flush, then exit.
                        setTimeout(() => process.exit(1), 100).unref?.();
                    }
                    break;
                }
                case ApplicationPhase.APPLICATION_READY: {
                    if (process.env.NODE_ENV !== "test") {
                        this.start();
                    }
                    break;
                }
            }
        };
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

    waitForAppReady(): Promise<void> {
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                if (
                    ApplicationLifecycle.getCurrentPhase() >=
                    ApplicationPhase.APPLICATION_READY
                ) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
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

    private validateOrigin(requestOrigin: string | null | undefined): string | null {
        if (!this.config.cors || !requestOrigin) return null;

        const configOrigin = this.config.cors.origin;

        // Wildcard allows all
        if (configOrigin === '*' || configOrigin === undefined) {
            // If credentials enabled, cannot use wildcard - return actual origin
            return this.config.cors.credentials ? requestOrigin : '*';
        }

        // String match
        if (typeof configOrigin === 'string') {
            return requestOrigin === configOrigin ? configOrigin : null;
        }

        // Array - check if origin is in list
        if (Array.isArray(configOrigin)) {
            return configOrigin.includes(requestOrigin) ? requestOrigin : null;
        }

        // Function validator
        if (typeof configOrigin === 'function') {
            return configOrigin(requestOrigin) ? requestOrigin : null;
        }

        return null;
    }

    private getCorsHeaders(req?: Request): Record<string, string> {
        if (!this.config.cors) return {};

        const requestOrigin = req?.headers.get('Origin');
        const allowedOrigin = this.validateOrigin(requestOrigin);

        // If origin not allowed, return empty (no CORS headers)
        if (requestOrigin && !allowedOrigin) return {};

        const headers: Record<string, string> = {
            'Access-Control-Allow-Origin': allowedOrigin || '*',
            'Access-Control-Allow-Methods': this.config.cors.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': this.config.cors.allowedHeaders?.join(', ') || 'Content-Type, Authorization',
            'Vary': 'Origin',
        };

        if (this.config.cors.credentials) {
            headers['Access-Control-Allow-Credentials'] = 'true';
        }

        if (this.config.cors.exposedHeaders?.length) {
            headers['Access-Control-Expose-Headers'] = this.config.cors.exposedHeaders.join(', ');
        }

        if (this.config.cors.maxAge !== undefined) {
            headers['Access-Control-Max-Age'] = String(this.config.cors.maxAge);
        }

        return headers;
    }

    /**
     * Combine multiple AbortSignals into one that aborts when any input
     * aborts. Uses `AbortSignal.any` when available (Node 20+/current Bun),
     * falls back to a manual combiner for older runtimes.
     */
    private combineSignals(signals: AbortSignal[]): AbortSignal {
        const anyFn = (AbortSignal as any).any;
        if (typeof anyFn === 'function') {
            return anyFn.call(AbortSignal, signals);
        }
        const controller = new AbortController();
        for (const s of signals) {
            if (s.aborted) {
                controller.abort((s as any).reason);
                return controller.signal;
            }
            s.addEventListener('abort', () => controller.abort((s as any).reason), { once: true });
        }
        return controller.signal;
    }

    private addCorsHeaders(response: Response, req?: Request): Response {
        const corsHeaders = this.getCorsHeaders(req);
        if (Object.keys(corsHeaders).length === 0) return response;

        const newHeaders = new Headers(response.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
            newHeaders.set(key, value);
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    }

    private async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;
        const startTime = Date.now();

        // Handle CORS preflight requests
        if (method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: this.getCorsHeaders(req),
            });
        }

        // Request timeout — combine the framework wall-clock with the client's
        // abort signal. The combined signal is attached to a cloned request
        // that is passed to Yoga / REST handlers so downstream work (DB
        // queries, resolvers) actually gets cancelled on timeout or client
        // disconnect. Previously the signal was created but never propagated,
        // so the timer only logged a warning while the request continued
        // consuming resources (C05).
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort(new Error(`Request timeout after 30000ms: ${method} ${url.pathname}`));
            logger.warn(`Request timeout: ${method} ${url.pathname}`);
        }, 30000);
        const combinedSignal = this.combineSignals([req.signal, controller.signal]);
        // Rebind the request with the combined signal so handlers (Yoga, REST)
        // see it via req.signal and can propagate cancellation.
        req = new Request(req, { signal: combinedSignal });

        try {
            // Health check endpoint
            if (url.pathname === "/health") {
                clearTimeout(timeoutId);
                const health = await deepHealthCheck();
                return this.addCorsHeaders(new Response(
                    JSON.stringify(health.result),
                    {
                        status: health.httpStatus,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            // Metrics endpoint
            if (url.pathname === "/metrics") {
                clearTimeout(timeoutId);
                const metrics = await this.collectMetrics();
                return this.addCorsHeaders(new Response(
                    JSON.stringify(metrics),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            // Remote health check
            if (url.pathname === "/health/remote") {
                clearTimeout(timeoutId);
                if (!this.remote) {
                    return this.addCorsHeaders(new Response(
                        JSON.stringify({
                            healthy: false,
                            error: "Remote subsystem not enabled",
                        }),
                        {
                            status: 503,
                            headers: { "Content-Type": "application/json" },
                        }
                    ), req);
                }
                const health = await this.remote.health();
                return this.addCorsHeaders(new Response(
                    JSON.stringify(health),
                    {
                        status: health.healthy ? 200 : 503,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            // Readiness probe
            if (url.pathname === "/health/ready") {
                clearTimeout(timeoutId);
                const ready = await readinessCheck(this.isReady, this.isShuttingDown);
                return this.addCorsHeaders(new Response(
                    JSON.stringify(ready.result),
                    {
                        status: ready.httpStatus,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            // OpenAPI spec endpoint
            if (url.pathname === "/openapi.json") {
                clearTimeout(timeoutId);
                return this.addCorsHeaders(new Response(this.openAPISpecGenerator!.toJSON(), {
                    headers: { "Content-Type": "application/json" },
                }), req);
            }

            // Swagger UI endpoint
            if (url.pathname === "/docs") {
                clearTimeout(timeoutId);
                const swaggerUIHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>${this.name} Documentation</title>
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui.css" />
    <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin: 0; background: #fafafa; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui-bundle.js"></script>
    <script>
        window.onload = function() {
            const ui = SwaggerUIBundle({
                url: '/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIBundle.presets.standalone
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "BaseLayout"
            });
        };
    </script>
</body>
</html>`;
                return this.addCorsHeaders(new Response(swaggerUIHTML, {
                    headers: { "Content-Type": "text/html" },
                }), req);
            }

            // Studio API endpoints
            if (this.studioEnabled && url.pathname.startsWith("/studio/api/")) {
                clearTimeout(timeoutId);

                // Studio tables endpoint
                if (url.pathname === "/studio/api/tables") {
                    return this.addCorsHeaders(await studioEndpoint.getTables(), req);
                }

                // Studio stats endpoint
                if (url.pathname === "/studio/api/stats") {
                    return this.addCorsHeaders(await studioEndpoint.handleStudioStatsRequest(), req);
                }

                // Studio components endpoint
                if (url.pathname === "/studio/api/components") {
                    return this.addCorsHeaders(await studioEndpoint.handleStudioComponentsRequest(), req);
                }

                // Studio query endpoint (POST only)
                if (url.pathname === "/studio/api/query" && method === "POST") {
                    const body = await req.json();
                    return this.addCorsHeaders(await studioEndpoint.handleStudioQueryRequest(body), req);
                }

                const studioApiPath = url.pathname.replace("/studio/api/", "");
                const pathSegments = studioApiPath.split("/");

                if (pathSegments[0] === "entity" && pathSegments[1]) {
                    const entityId = pathSegments[1];
                    return this.addCorsHeaders(
                        await studioEndpoint.handleEntityInspectorRequest(entityId),
                        req
                    );
                }

                if (pathSegments[0] === "table" && pathSegments[1]) {
                    const tableName = pathSegments[1];

                    if (method === "DELETE") {
                        const body = await req.json();
                        return this.addCorsHeaders(await studioEndpoint.handleStudioTableDeleteRequest(
                            tableName,
                            body
                        ), req);
                    }

                    const limit = url.searchParams.get("limit");
                    const offset = url.searchParams.get("offset");
                    const search = url.searchParams.get("search");

                    return this.addCorsHeaders(await studioEndpoint.handleStudioTableRequest(tableName, {
                        limit: limit ? parseInt(limit, 10) : undefined,
                        offset: offset ? parseInt(offset, 10) : undefined,
                        search: search ?? undefined,
                    }), req);
                }

                if (pathSegments[0] === "arche-type" && pathSegments[1]) {
                    const archeTypeName = pathSegments[1];

                    if (method === "DELETE") {
                        const body = await req.json();
                        return this.addCorsHeaders(await studioEndpoint.handleStudioArcheTypeDeleteRequest(
                            archeTypeName,
                            body
                        ), req);
                    }

                    const limit = url.searchParams.get("limit");
                    const offset = url.searchParams.get("offset");
                    const search = url.searchParams.get("search");
                    const includeDeleted = url.searchParams.get("include_deleted");

                    return this.addCorsHeaders(await studioEndpoint.handleStudioArcheTypeRecordsRequest(
                        archeTypeName,
                        {
                            limit: limit ? parseInt(limit, 10) : undefined,
                            offset: offset ? parseInt(offset, 10) : undefined,
                            search: search ?? undefined,
                            include_deleted: includeDeleted === "true",
                        }
                    ), req);
                }

                return this.addCorsHeaders(new Response(
                    JSON.stringify({ error: "Studio API endpoint not found" }),
                    {
                        status: 404,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            // Studio endpoint - handle both root and all sub-routes
            if (
                this.studioEnabled &&
                (url.pathname === "/studio" ||
                url.pathname.startsWith("/studio/"))
            ) {
                clearTimeout(timeoutId);

                // Skip API routes - they're handled by the API handler above
                if (url.pathname.startsWith("/studio/api/")) {
                    return this.addCorsHeaders(new Response(
                        JSON.stringify({
                            error: "Studio API endpoint not found",
                        }),
                        {
                            status: 404,
                            headers: { "Content-Type": "application/json" },
                        }
                    ), req);
                }

                // Check if this is a request for static assets (CSS, JS, etc.)
                if (url.pathname.startsWith("/studio/assets/")) {
                    // Let the static assets handler below handle this
                    // Don't return here, fall through to static assets handler
                } else {
                    // For all other /studio/* routes, serve the React app's index.html
                    const studioIndexPath = path.join(
                        import.meta.dirname,
                        "..",
                        "studio",
                        "dist",
                        "index.html"
                    );
                    try {
                        const studioFile = Bun.file(studioIndexPath);
                        if (await studioFile.exists()) {
                            let html = await studioFile.text();
                            // Inject metadata into the HTML
                            const metadata = getSerializedMetadataStorage();
                            const metadataScript = `<script>window.bunsaneMetadata = ${JSON.stringify(
                                metadata
                            )};</script>`;
                            // Insert before the closing </head> tag
                            html = html.replace(
                                "</head>",
                                `${metadataScript}</head>`
                            );
                            return this.addCorsHeaders(new Response(html, {
                                headers: { "Content-Type": "text/html" },
                            }), req);
                        } else {
                            return this.addCorsHeaders(new Response(
                                "Studio not built. Run `bun run build:studio` to build the studio.",
                                {
                                    status: 404,
                                    headers: { "Content-Type": "text/plain" },
                                }
                            ), req);
                        }
                    } catch (error) {
                        console.log("Error loading studio index.html:", error);
                        return this.addCorsHeaders(new Response("Studio not available", {
                            status: 404,
                            headers: { "Content-Type": "text/plain" },
                        }), req);
                    }
                }
            }
            for (const [route, folder] of this.staticAssets) {
                if (url.pathname.startsWith(route)) {
                    const relativePath = url.pathname.slice(route.length);
                    const filePath = path.join(folder, relativePath);
                    try {
                        const file = Bun.file(filePath);
                        if (await file.exists()) {
                            clearTimeout(timeoutId);
                            return this.addCorsHeaders(new Response(file), req);
                        }
                    } catch (error) {
                        logger.error(
                            `Error serving static file ${filePath}:`,
                            error as any
                        );
                    }
                }
            }

            // Lookup REST endpoint using map for O(1) performance
            const endpointKey = `${method}:${url.pathname}`;
            let endpoint = this.restEndpointMap.get(endpointKey);

            // If exact match not found, try pattern matching for parameterized routes
            if (!endpoint) {
                for (const ep of this.restEndpoints) {
                    if (ep.method !== method) continue;
                    // Convert route pattern to regex (e.g., /api/v1/users/:id -> /api/v1/users/[^/]+)
                    const pattern = ep.path.replace(/:[^/]+/g, '[^/]+');
                    const regex = new RegExp(`^${pattern}$`);
                    if (regex.test(url.pathname)) {
                        endpoint = ep;
                        break;
                    }
                }
            }

            if (endpoint) {
                try {
                    const result = await endpoint.handler(req);
                    const duration = Date.now() - startTime;
                    logger.trace(
                        `REST ${method} ${url.pathname} completed in ${duration}ms`
                    );

                    clearTimeout(timeoutId);
                    if (result instanceof Response) {
                        return this.addCorsHeaders(result, req);
                    } else {
                        return this.addCorsHeaders(new Response(JSON.stringify(result), {
                            headers: { "Content-Type": "application/json" },
                        }), req);
                    }
                } catch (error) {
                    const duration = Date.now() - startTime;
                    logger.error(
                        `Error in REST endpoint ${method} ${endpoint.path} after ${duration}ms`,
                        error as any
                    );
                    clearTimeout(timeoutId);
                    return this.addCorsHeaders(new Response(
                        JSON.stringify({
                            error: "Internal server error",
                            code: "INTERNAL_ERROR",
                            ...(process.env.NODE_ENV === 'development' && {
                                message: (error as Error)?.message,
                            }),
                        }),
                        {
                            status: 500,
                            headers: { "Content-Type": "application/json" },
                        }
                    ), req);
                }
            }

            if (this.yoga) {
                const response = await this.yoga(req);
                const duration = Date.now() - startTime;
                logger.trace(`GraphQL request completed in ${duration}ms`);
                clearTimeout(timeoutId);
                return response;
            }

            clearTimeout(timeoutId);
            return this.addCorsHeaders(new Response("Not Found", { status: 404 }), req);
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(
                `Request failed after ${duration}ms: ${method} ${url.pathname}`,
                error as any
            );
            clearTimeout(timeoutId);

            if ((error as Error).name === "AbortError") {
                return this.addCorsHeaders(new Response(
                    JSON.stringify({ error: "Request timeout", code: "TIMEOUT_ERROR" }),
                    {
                        status: 408,
                        headers: { "Content-Type": "application/json" },
                    }
                ), req);
            }

            return this.addCorsHeaders(new Response(
                JSON.stringify({
                    error: "Internal server error",
                    code: "INTERNAL_ERROR",
                    ...(process.env.NODE_ENV === 'development' && {
                        message: (error as Error)?.message,
                    }),
                }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            ), req);
        }
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

    /**
     * Warm up the prepared statement cache with common query patterns
     */
    private async warmUpPreparedStatementCache(): Promise<void> {
        // Get registered components for generating common queries
        const components = ComponentRegistry.getComponents();

        if (components.length === 0) {
            logger.trace(
                "No components registered yet, skipping cache warm-up"
            );
            return;
        }

        const commonQueries: Array<{ sql: string; key: string }> = [];

        // Generate some common query patterns
        // 1. Simple entity count
        commonQueries.push({
            sql: "SELECT COUNT(*) as count FROM (SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.deleted_at IS NULL) AS subquery",
            key: "count_all_entities",
        });

        // 2. Common component queries (first few components)
        for (let i = 0; i < Math.min(5, components.length); i++) {
            const component = components[i];
            if (component) {
                const { name, ctor } = component;
                const typeId = ComponentRegistry.getComponentId(name);
                if (typeId) {
                    commonQueries.push({
                        sql: `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id = '${typeId}' AND ec.deleted_at IS NULL LIMIT 10`,
                        key: `find_${name.toLowerCase()}_sample`,
                    });
                }
            }
        }

        // 3. Multi-component queries (if we have multiple components)
        if (components.length >= 2) {
            const typeIds = components
                .slice(0, 3)
                .map((component: { name: string; ctor: any }) =>
                    ComponentRegistry.getComponentId(component.name)
                )
                .filter((id: string | undefined) => id)
                .join("','");

            if (typeIds) {
                commonQueries.push({
                    sql: `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id IN ('${typeIds}') AND ec.deleted_at IS NULL LIMIT 10`,
                    key: "find_multi_component_sample",
                });
            }
        }

        await preparedStatementCache.warmUp(commonQueries, db);
    }

    private async collectMetrics() {
        let cacheStats = null;
        try {
            const { CacheManager } = await import('./cache/CacheManager');
            cacheStats = await CacheManager.getInstance().getStats();
        } catch {}

        return {
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            process: process.memoryUsage(),
            cache: cacheStats,
            scheduler: SchedulerManager.getInstance().getMetrics(),
            preparedStatements: preparedStatementCache.getStats(),
            remote: this.remote ? this.remote.getMetrics() : null,
        };
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
     * idempotent — safe to call multiple times (e.g. in tests).
     */
    private registerProcessHandlers(): void {
        if (this.processHandlersRegistered) return;

        // Use arrow-bound handlers so `once` works cleanly.
        this.sigTermHandler = () => {
            logger.info({ scope: 'app', component: 'App', msg: 'Received SIGTERM' });
            this.shutdown().finally(() => process.exit(0));
        };
        this.sigIntHandler = () => {
            logger.info({ scope: 'app', component: 'App', msg: 'Received SIGINT' });
            this.shutdown().finally(() => process.exit(0));
        };
        process.once('SIGTERM', this.sigTermHandler);
        process.once('SIGINT', this.sigIntHandler);

        // Global error handlers to prevent silent crashes during init AND runtime.
        this.unhandledRejectionHandler = (reason, promise) => {
            logger.error({ scope: 'app', component: 'App', reason, msg: 'Unhandled promise rejection' });
        };
        this.uncaughtExceptionHandler = (error) => {
            logger.fatal({ scope: 'app', component: 'App', err: error, msg: 'Uncaught exception — shutting down' });
            this.shutdown().finally(() => process.exit(1));
        };
        process.on('unhandledRejection', this.unhandledRejectionHandler);
        process.on('uncaughtException', this.uncaughtExceptionHandler);

        this.processHandlersRegistered = true;
    }

    private unregisterProcessHandlers(): void {
        if (!this.processHandlersRegistered) return;
        if (this.sigTermHandler) process.removeListener('SIGTERM', this.sigTermHandler);
        if (this.sigIntHandler) process.removeListener('SIGINT', this.sigIntHandler);
        if (this.unhandledRejectionHandler) process.removeListener('unhandledRejection', this.unhandledRejectionHandler);
        if (this.uncaughtExceptionHandler) process.removeListener('uncaughtException', this.uncaughtExceptionHandler);
        this.sigTermHandler = null;
        this.sigIntHandler = null;
        this.unhandledRejectionHandler = null;
        this.uncaughtExceptionHandler = null;
        this.processHandlersRegistered = false;
    }

    /**
     * Gracefully shutdown the application.
     *
     * Ordered drain: HTTP → scheduler → remote → cache → database. Each step
     * awaits completion before the next begins so in-flight work always sees
     * its dependencies still available. Total budget bounded by
     * `shutdownGracePeriod`; per-step budgets fall back to reasonable defaults.
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.isReady = false;

        const shutdownStart = Date.now();
        logger.info({ scope: 'app', component: 'App', msg: 'Shutting down application', gracePeriodMs: this.shutdownGracePeriod });

        const budgetRemaining = () => Math.max(500, this.shutdownGracePeriod - (Date.now() - shutdownStart));

        // 1. Stop HTTP server: stop accepting new connections, wait for in-flight
        //    requests to finish. Bun's server.stop(false) initiates graceful
        //    drain but does not return a promise — we poll the server's
        //    pendingRequests count, then force-close on deadline.
        if (this.server) {
            try {
                logger.info({ scope: 'app', component: 'App', msg: 'Draining HTTP connections' });
                this.server.stop(false);
                await this.waitForHttpDrain(budgetRemaining());
                try { this.server.stop(true); } catch {}
                logger.info({ scope: 'app', component: 'App', msg: 'HTTP server stopped' });
            } catch (error) {
                logger.warn({ scope: 'app', component: 'App', msg: 'HTTP server stop error', err: error });
            }
        }

        // 2. Stop scheduler (awaits in-flight tasks internally, see C14).
        try {
            await SchedulerManager.getInstance().stop(Math.min(budgetRemaining(), 15_000));
            logger.info({ scope: 'app', component: 'App', msg: 'Scheduler stopped' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'Scheduler stop error', err: error });
        }

        // 3. Shutdown RemoteManager (after scheduler, before cache — DB still available).
        if (this.remote) {
            try {
                await this.remote.shutdown();
                setRemoteManager(null);
                this.remote = null;
                logger.info({ scope: 'app', component: 'App', msg: 'RemoteManager shutdown' });
            } catch (error) {
                logger.warn({ scope: 'app', component: 'App', msg: 'RemoteManager shutdown error', err: error });
            }
        }

        // 4. Shutdown cache (flush pending writes, unsubscribe pub/sub, disconnect).
        try {
            const { CacheManager } = await import('./cache/CacheManager');
            await CacheManager.getInstance().shutdown();
            logger.info({ scope: 'cache', component: 'App', msg: 'Cache shutdown completed' });
        } catch (error) {
            logger.warn({ scope: 'cache', component: 'App', msg: 'Cache shutdown error', err: error });
        }

        // 5. Close database pool (last — after all consumers done).
        try {
            db.close();
            logger.info({ scope: 'app', component: 'App', msg: 'Database pool closed' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'Database pool close error', err: error });
        }

        // 6. Dispose lifecycle listeners so a subsequent init() (tests) doesn't
        //    stack handlers on the singleton.
        try {
            if (this.phaseListener) {
                ApplicationLifecycle.removePhaseListener(this.phaseListener);
                this.phaseListener = null;
            }
            SchedulerManager.getInstance().disposeLifecycleIntegration();
        } catch { /* ignore */ }

        // 7. Unregister process handlers (signals + error handlers) last so
        //    shutdown errors still surface via them above.
        this.unregisterProcessHandlers();

        logger.info({ scope: 'app', component: 'App', msg: 'Application shutdown completed', durationMs: Date.now() - shutdownStart });
    }

    /**
     * Wait for pending HTTP requests to drain, bounded by `timeoutMs`.
     * Bun's `Server` exposes `pendingRequests` for this poll. If the field is
     * unavailable (older Bun), fall back to a fixed sleep.
     */
    private async waitForHttpDrain(timeoutMs: number): Promise<void> {
        if (!this.server) return;
        const deadline = Date.now() + timeoutMs;
        // Poll pending request count. Bun exposes this on the Server object.
        while (Date.now() < deadline) {
            const pending = (this.server as any).pendingRequests ?? 0;
            if (pending === 0) return;
            await new Promise((r) => setTimeout(r, 50));
        }
        const leftover = (this.server as any).pendingRequests ?? -1;
        if (leftover > 0) {
            logger.warn({ scope: 'app', component: 'App', msg: 'HTTP drain timeout, pending requests remaining', pendingRequests: leftover });
        }
    }
}
