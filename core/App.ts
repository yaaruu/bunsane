import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { HasValidBaseTable, PrepareDatabase } from "database/DatabaseHelper";
import ComponentRegistry from "core/ComponentRegistry";
import { logger } from "core/Logger";
import { createYogaInstance } from "gql";
import ServiceRegistry from "service/ServiceRegistry";
import type { Plugin } from "graphql-yoga";
import * as path from "path";
import { registerDecoratedHooks } from "core/decorators/EntityHooks";
import { SchedulerManager } from "core/SchedulerManager";
import { registerScheduledTasks } from "core/decorators/ScheduledTask";
import { OpenAPISpecGenerator, type SwaggerEndpointMetadata } from "swagger";

export default class App {
    private name: string = "BunSane Application";
    private version: string = "1.0.0";
    private yoga: any;
    private yogaPlugins: Plugin[] = [];
    private restEndpoints: Array<{ method: string; path: string; handler: Function; service: any }> = [];
    private restEndpointMap: Map<string, { method: string; path: string; handler: Function; service: any }> = new Map();
    private staticAssets: Map<string, string> = new Map();
    private openAPISpecGenerator: OpenAPISpecGenerator | null = null;

    constructor(appName?: string, appVersion?: string) {
        if (appName) this.name = appName;
        if (appVersion) this.version = appVersion;
        this.init();
    }

    async init() {
        logger.trace(`Initializing App`);
        this.openAPISpecGenerator = new OpenAPISpecGenerator(
            this.name,
            this.version,
        );
        ComponentRegistry.init();
        ServiceRegistry.init();
        if(ApplicationLifecycle.getCurrentPhase() === ApplicationPhase.DATABASE_INITIALIZING) {
            if(!await HasValidBaseTable()) {
                await PrepareDatabase();
            }
            logger.trace(`Database prepared...`);
            ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
        }

        ApplicationLifecycle.addPhaseListener((event) => {
            const phase = event.detail;
            logger.info(`Application phase changed to: ${phase}`);
            switch(phase) {
                case ApplicationPhase.DATABASE_READY: {
                    break;
                }
                case ApplicationPhase.COMPONENTS_READY: {
                    // Automatically register decorated hooks for all services
                    const services = ServiceRegistry.getServices();
                    for (const service of services) {
                        try {
                            registerDecoratedHooks(service);
                        } catch (error) {
                            logger.warn(`Failed to register hooks for service ${service.constructor.name}`);
                            logger.warn(error);
                        }
                    }
                    logger.info(`Registered hooks for ${services.length} services`);
                    
                    ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_REGISTERING);
                    break;
                }
                case ApplicationPhase.SYSTEM_READY: {
                    try {
                        const schema = ServiceRegistry.getSchema();
                        if (schema) {
                            this.yoga = createYogaInstance(schema, this.yogaPlugins);
                        } else {
                            this.yoga = createYogaInstance(undefined, this.yogaPlugins);
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
                                logger.warn(`Failed to register scheduled tasks for service ${service.constructor.name}`);
                                logger.warn(error);
                            }
                        }
                        logger.info(`Registered scheduled tasks for ${services.length} services`);

                        // Collect REST endpoints from all services
                        for (const service of services) {
                            const endpoints = (service.constructor as any).httpEndpoints;
                            if (endpoints) {
                                for (const endpoint of endpoints) {
                                    const endpointInfo = {
                                        method: endpoint.method,
                                        path: endpoint.path,
                                        handler: endpoint.handler.bind(service),
                                        service: service
                                    };
                                    logger.trace(`Registered REST endpoint: [${endpoint.method}] ${endpoint.path} for service ${service.constructor.name}`);
                                    this.restEndpoints.push(endpointInfo);
                                    this.restEndpointMap.set(`${endpoint.method}:${endpoint.path}`, endpointInfo);

                                    // Check if this endpoint has a swagger operation
                                    if ((endpoint.handler as any).swaggerOperation) {
                                        // Collect tags from class and method decorators
                                        const classTags = (service.constructor as any).swaggerClassTags || [];
                                        const methodTags = (service.constructor as any).swaggerMethodTags?.[endpoint.handler.name] || [];
                                        const allTags = [...classTags, ...methodTags];

                                        logger.trace(`Generating OpenAPI spec for endpoint: [${endpoint.method}] ${endpoint.path} with tags: ${allTags.join(", ")}`);
                                        
                                        // Merge tags into the operation
                                        const operation = { ...(endpoint.handler as any).swaggerOperation };
                                        if (allTags.length > 0) {
                                            operation.tags = [...(operation.tags || []), ...allTags];
                                        }   
                                        
                                        this.openAPISpecGenerator!.addEndpoint({
                                            method: endpoint.method,
                                            path: endpoint.path,
                                            operation
                                        });
                                        logger.trace(`Registered OpenAPI spec for endpoint: [${endpoint.method}] ${endpoint.path}`);
                                    } else {
                                        logger.warn(`No swagger operation found for endpoint: [${endpoint.method}] ${endpoint.path} in service ${service.constructor.name}`);
                                        this.openAPISpecGenerator!.addEndpoint({
                                            method: endpoint.method,
                                            path: endpoint.path,
                                            operation: {
                                                summary: `No description for ${endpoint.path}. Don't use this endpoint until it's properly documented!`,
                                                requestBody: {content: {"application/json": {schema: {}}}},
                                                responses: { "200": { description: "Success" } }
                                            }
                                        });
                                    }
                                }
                            }
                        }


                        ApplicationLifecycle.setPhase(ApplicationPhase.APPLICATION_READY);
                    } catch (error) {
                        logger.error("Error during SYSTEM_READY phase:");
                        logger.error(error);
                    }
                    break;
                }
                case ApplicationPhase.APPLICATION_READY: {
                    if(process.env.NODE_ENV !== "test") {
                        this.start();
                    }
                    break;
                }
            }
        });
    }

    waitForAppReady(): Promise<void> {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (ApplicationLifecycle.getCurrentPhase() === ApplicationPhase.APPLICATION_READY) {
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
            if (url.pathname === '/health') {
                clearTimeout(timeoutId);
                return new Response(JSON.stringify({ 
                    status: 'ok', 
                    timestamp: new Date().toISOString(),
                    uptime: process.uptime()
                }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // OpenAPI spec endpoint
            if (url.pathname === '/openapi.json') {
                clearTimeout(timeoutId);
                return new Response(this.openAPISpecGenerator!.toJSON(), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Swagger UI endpoint
            if (url.pathname === '/docs') {
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
                    headers: { 'Content-Type': 'text/html' }
                });
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
                        logger.error(`Error serving static file ${filePath}:`, error as any);
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
                    logger.trace(`REST ${method} ${url.pathname} completed in ${duration}ms`);
                    
                    clearTimeout(timeoutId);
                    if (result instanceof Response) {
                        return result;
                    } else {
                        return new Response(JSON.stringify(result), {
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                } catch (error) {
                    const duration = Date.now() - startTime;
                    logger.error(`Error in REST endpoint ${method} ${endpoint.path} after ${duration}ms`, error as any);
                    clearTimeout(timeoutId);
                    return new Response(JSON.stringify({ error: 'Internal server error' }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
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
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`Request failed after ${duration}ms: ${method} ${url.pathname}`, error as any);
            clearTimeout(timeoutId);
            
            if ((error as Error).name === 'AbortError') {
                return new Response(JSON.stringify({ error: 'Request timeout' }), {
                    status: 408,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            return new Response(JSON.stringify({ error: 'Internal server error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    public setName(name: string) {
        this.name = name;
    }

    public setVersion(version: string) {
        this.version = version;
    }

    async start() {
        logger.info("Application Started");
        const port = parseInt(process.env.PORT || "3000");
        const server = Bun.serve({
            port: port,
            fetch: this.handleRequest.bind(this),
        });
        
        // Update the OpenAPI spec with the actual server URL
        this.openAPISpecGenerator!.addServer(`http://localhost:${port}`, "Development server");
        
        logger.info(`Server is running on ${new URL(this.yoga?.graphqlEndpoint || '/graphql', `http://${server.hostname}:${server.port}`)}`)
    }
}