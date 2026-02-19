import ApplicationLifecycle, {
    ApplicationPhase,
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
    private server: ReturnType<typeof Bun.serve> | null = null;
    private isShuttingDown = false;
    private isReady = false;
    private graphqlMaxDepth: number = 10;
    private shutdownGracePeriod = 10_000;

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
        validateEnv();
        logger.trace(`Initializing App`);
        ComponentRegistry.init();
        ServiceRegistry.init();
        
        // Initialize CacheManager
        try {
            const { CacheManager } = await import('./cache/CacheManager');
            const cacheManager = CacheManager.getInstance();
            // CacheManager initializes with default config, can be customized later
            logger.info({ scope: 'cache', component: 'App', msg: 'CacheManager initialized' });
        } catch (error) {
            logger.warn({ scope: 'cache', component: 'App', msg: 'Failed to initialize CacheManager', error });
        }
        
        // Plugin initialization
        for (const plugin of this.plugins) {
            if (plugin.init) {
                await plugin.init(this);
            }
        }

        ApplicationLifecycle.addPhaseListener(async (event) => {
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
                            ? (yogaContext: any) => {
                                  const userContext =
                                      this.contextFactory!(yogaContext);
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

                        if (schema) {
                            this.yoga = createYogaInstance(
                                schema,
                                this.yogaPlugins,
                                wrappedContextFactory,
                                yogaOptions
                            );
                        } else {
                            this.yoga = createYogaInstance(
                                undefined,
                                this.yogaPlugins,
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
                        logger.error("Error during SYSTEM_READY phase:");
                        logger.error(error);
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
        });

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

        // Add request timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            logger.warn(`Request timeout: ${method} ${url.pathname}`);
        }, 30000); // 30 second timeout

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

                const studioApiPath = url.pathname.replace("/studio/api/", "");
                const pathSegments = studioApiPath.split("/");

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

                    return this.addCorsHeaders(await studioEndpoint.handleStudioArcheTypeRecordsRequest(
                        archeTypeName,
                        {
                            limit: limit ? parseInt(limit, 10) : undefined,
                            offset: offset ? parseInt(offset, 10) : undefined,
                            search: search ?? undefined,
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
                url.pathname === "/studio" ||
                url.pathname.startsWith("/studio/")
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

    public setVersion(version: string) {
        this.version = version;
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
     * Set the grace period for draining connections during shutdown (ms).
     */
    public setShutdownGracePeriod(ms: number) {
        this.shutdownGracePeriod = ms;
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
        };
    }

    async start() {
        logger.info("Application Started");
        const port = parseInt(process.env.APP_PORT || "3000");

        // Read env override for shutdown grace period
        const envGracePeriod = process.env.SHUTDOWN_GRACE_PERIOD_MS;
        if (envGracePeriod) {
            this.shutdownGracePeriod = parseInt(envGracePeriod, 10);
        }

        // Compose middleware chain around the core request handler
        this.composedHandler = composeMiddleware(
            this.middlewares,
            this.handleRequest.bind(this),
        );

        this.server = Bun.serve({
            idleTimeout: 0, // Disable idle timeout because we have subscriptions
            port: port,
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

        // Register signal handlers for graceful shutdown
        process.on('SIGTERM', async () => {
            logger.info({ scope: 'app', component: 'App', msg: 'Received SIGTERM' });
            await this.shutdown();
            process.exit(0);
        });

        process.on('SIGINT', async () => {
            logger.info({ scope: 'app', component: 'App', msg: 'Received SIGINT' });
            await this.shutdown();
            process.exit(0);
        });

        // Global error handlers to prevent silent crashes
        process.on('unhandledRejection', (reason, promise) => {
            logger.error({ scope: 'app', component: 'App', reason, msg: 'Unhandled promise rejection' });
        });

        process.on('uncaughtException', (error) => {
            logger.fatal({ scope: 'app', component: 'App', error, msg: 'Uncaught exception — shutting down' });
            this.shutdown().finally(() => process.exit(1));
        });

        this.isReady = true;
        this.appReadyCallbacks.forEach((cb) => cb());
    }

    /**
     * Gracefully shutdown the application
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.isReady = false;

        logger.info({ scope: 'app', component: 'App', msg: 'Shutting down application' });

        // Stop HTTP server — drain then force-close after grace period
        if (this.server) {
            try {
                logger.info({ scope: 'app', component: 'App', msg: 'Draining connections' });
                this.server.stop(false);
                const forceTimer = setTimeout(() => {
                    logger.warn({ scope: 'app', component: 'App', msg: 'Grace period expired, forcing connection close' });
                    try { this.server?.stop(true); } catch {}
                }, this.shutdownGracePeriod);
                forceTimer.unref?.();
                logger.info({ scope: 'app', component: 'App', msg: 'HTTP server stopped' });
            } catch (error) {
                logger.warn({ scope: 'app', component: 'App', msg: 'HTTP server stop error', error });
            }
        }

        // Stop scheduler
        try {
            await SchedulerManager.getInstance().stop();
            logger.info({ scope: 'app', component: 'App', msg: 'Scheduler stopped' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'Scheduler stop error', error });
        }

        // Shutdown cache
        try {
            const { CacheManager } = await import('./cache/CacheManager');
            await CacheManager.getInstance().shutdown();
            logger.info({ scope: 'cache', component: 'App', msg: 'Cache shutdown completed' });
        } catch (error) {
            logger.warn({ scope: 'cache', component: 'App', msg: 'Cache shutdown error', error });
        }

        // Close database pool (last step)
        try {
            db.close();
            logger.info({ scope: 'app', component: 'App', msg: 'Database pool closed' });
        } catch (error) {
            logger.warn({ scope: 'app', component: 'App', msg: 'Database pool close error', error });
        }

        logger.info({ scope: 'app', component: 'App', msg: 'Application shutdown completed' });
    }
}
