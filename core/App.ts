import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { GenerateTableName, HasValidBaseTable, PrepareDatabase, UpdateComponentIndexes, EnsureDatabaseMigrations } from "database/DatabaseHelper";
import ComponentRegistry from "core/ComponentRegistry";
import { logger as MainLogger } from "core/Logger";
import { getSerializedMetadataStorage } from "core/metadata";
const logger = MainLogger.child({ scope: "App" });
import { createYogaInstance } from "gql";
import ServiceRegistry from "service/ServiceRegistry";
import type { Plugin } from "graphql-yoga";
import * as path from "path";
import { SchedulerManager } from "core/SchedulerManager";
import { registerScheduledTasks } from "core/decorators/ScheduledTask";
import { OpenAPISpecGenerator, type SwaggerEndpointMetadata } from "swagger";
import type BasePlugin from "plugins";
import { preparedStatementCache } from "database/PreparedStatementCache";
import db from "database";
import studioEndpoint from "studio/endpoint";

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

    private studioEnabled: boolean = false;

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

    async init() {
        logger.trace(`Initializing App`);
        ComponentRegistry.init();
        ServiceRegistry.init();
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

                        if (schema) {
                            this.yoga = createYogaInstance(
                                schema,
                                this.yogaPlugins,
                                wrappedContextFactory
                            );
                        } else {
                            this.yoga = createYogaInstance(
                                undefined,
                                this.yogaPlugins,
                                wrappedContextFactory
                            );
                        }

                        // Get all services for processing
                        const services = ServiceRegistry.getServices();

                        // Initialize Scheduler
                        const scheduler = SchedulerManager.getInstance();

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

    public addStaticAssets(route: string, folder: string) {
        // Resolve the folder path relative to the current working directory
        const resolvedFolder = path.resolve(folder);
        this.staticAssets.set(route, resolvedFolder);
    }

    private async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;
        const startTime = Date.now();

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
                return new Response(
                    JSON.stringify({
                        status: "ok",
                        timestamp: new Date().toISOString(),
                        uptime: process.uptime(),
                    }),
                    {
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }

            // OpenAPI spec endpoint
            if (url.pathname === "/openapi.json") {
                clearTimeout(timeoutId);
                return new Response(this.openAPISpecGenerator!.toJSON(), {
                    headers: { "Content-Type": "application/json" },
                });
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
                return new Response(swaggerUIHTML, {
                    headers: { "Content-Type": "text/html" },
                });
            }

            // Studio API endpoints
            if (this.studioEnabled && url.pathname.startsWith("/studio/api/")) {
                clearTimeout(timeoutId);
            
                // Studio tables endpoint
                if (url.pathname === "/studio/api/tables") {
                    return studioEndpoint.getTables();
                }

                const studioApiPath = url.pathname.replace("/studio/api/", "");
                const pathSegments = studioApiPath.split("/");

                if (pathSegments[0] === "table" && pathSegments[1]) {
                    const tableName = pathSegments[1];

                    if (method === "DELETE") {
                        const body = await req.json();
                        return studioEndpoint.handleStudioTableDeleteRequest(tableName, body);
                    }

                    const limit = url.searchParams.get("limit");
                    const offset = url.searchParams.get("offset");
                    const search = url.searchParams.get("search");

                    return studioEndpoint.handleStudioTableRequest(tableName, {
                        limit: limit ? parseInt(limit, 10) : undefined,
                        offset: offset ? parseInt(offset, 10) : undefined,
                        search: search ?? undefined,
                    });
                }

                if (pathSegments[0] === "arche-type" && pathSegments[1]) {
                    const archeTypeName = pathSegments[1];

                    if (method === "DELETE") {
                        const body = await req.json();
                        return studioEndpoint.handleStudioArcheTypeDeleteRequest(archeTypeName, body);
                    }

                    const limit = url.searchParams.get("limit");
                    const offset = url.searchParams.get("offset");
                    const search = url.searchParams.get("search");

                    return studioEndpoint.handleStudioArcheTypeRecordsRequest(archeTypeName, {
                        limit: limit ? parseInt(limit, 10) : undefined,
                        offset: offset ? parseInt(offset, 10) : undefined,
                        search: search ?? undefined,
                    });
                }

                return new Response(
                    JSON.stringify({ error: "Studio API endpoint not found" }),
                    {
                        status: 404,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }


            // Studio endpoint - handle both root and all sub-routes
            if (url.pathname === "/studio" || url.pathname.startsWith("/studio/")) {
                clearTimeout(timeoutId);
                
                // Skip API routes - they're handled by the API handler above
                if (url.pathname.startsWith("/studio/api/")) {
                    return new Response(
                        JSON.stringify({ error: "Studio API endpoint not found" }),
                        {
                            status: 404,
                            headers: { "Content-Type": "application/json" },
                        }
                    );
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
                            return new Response(html, {
                                headers: { "Content-Type": "text/html" },
                            });
                        } else {
                            return new Response(
                                "Studio not built. Run `bun run build:studio` to build the studio.",
                                {
                                    status: 404,
                                    headers: { "Content-Type": "text/plain" },
                                }
                            );
                        }
                    } catch (error) {
                        console.log("Error loading studio index.html:", error);
                        return new Response("Studio not available", {
                            status: 404,
                            headers: { "Content-Type": "text/plain" },
                        });
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
                            return new Response(file);
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
            const endpoint = this.restEndpointMap.get(endpointKey);
            if (endpoint) {
                try {
                    const result = await endpoint.handler(req);
                    const duration = Date.now() - startTime;
                    logger.trace(
                        `REST ${method} ${url.pathname} completed in ${duration}ms`
                    );

                    clearTimeout(timeoutId);
                    if (result instanceof Response) {
                        return result;
                    } else {
                        return new Response(JSON.stringify(result), {
                            headers: { "Content-Type": "application/json" },
                        });
                    }
                } catch (error) {
                    const duration = Date.now() - startTime;
                    logger.error(
                        `Error in REST endpoint ${method} ${endpoint.path} after ${duration}ms`,
                        error as any
                    );
                    clearTimeout(timeoutId);
                    return new Response(
                        JSON.stringify({ error: "Internal server error" }),
                        {
                            status: 500,
                            headers: { "Content-Type": "application/json" },
                        }
                    );
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
            return new Response("Not Found", { status: 404 });
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(
                `Request failed after ${duration}ms: ${method} ${url.pathname}`,
                error as any
            );
            clearTimeout(timeoutId);

            if ((error as Error).name === "AbortError") {
                return new Response(
                    JSON.stringify({ error: "Request timeout" }),
                    {
                        status: 408,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }

            return new Response(
                JSON.stringify({ error: "Internal server error" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
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

    async start() {
        logger.info("Application Started");
        const port = parseInt(process.env.APP_PORT || "3000");
        const server = Bun.serve({
            port: port,
            fetch: this.handleRequest.bind(this),
        });

        // Update the OpenAPI spec with the actual server URL
        this.openAPISpecGenerator!.addServer(
            `http://localhost:${port}`,
            "Development server"
        );

        logger.info(
            `Server is running on ${new URL(
                this.yoga?.graphqlEndpoint || "/graphql",
                `http://${server.hostname}:${server.port}`
            )}`
        );

        this.appReadyCallbacks.forEach((cb) => cb());
    }
}