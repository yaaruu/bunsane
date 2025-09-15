import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { HasValidBaseTable, PrepareDatabase } from "database/DatabaseHelper";
import ComponentRegistry from "core/ComponentRegistry";
import { logger } from "core/Logger";
import { createYogaInstance } from "gql";
import ServiceRegistry from "service/ServiceRegistry";
import type { Plugin } from "graphql-yoga";

export default class App {
    private yoga: any;
    private yogaPlugins: Plugin[] = [];
    private restEndpoints: Array<{ method: string; path: string; handler: Function; service: any }> = [];

    constructor() {
        this.init();
    }

    async init() {
        logger.trace(`Initializing App`);
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
                        
                        // Collect REST endpoints from all services
                        const services = ServiceRegistry.getServices();
                        for (const service of services) {
                            const endpoints = (service.constructor as any).httpEndpoints;
                            if (endpoints) {
                                for (const endpoint of endpoints) {
                                    this.restEndpoints.push({
                                        method: endpoint.method,
                                        path: endpoint.path,
                                        handler: endpoint.handler.bind(service),
                                        service: service
                                    });
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

    public addYogaPlugin(plugin: Plugin) {
        this.yogaPlugins.push(plugin);
    }

    private async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;

        // Check for REST endpoints
        for (const endpoint of this.restEndpoints) {
            if (endpoint.method === method && endpoint.path === url.pathname) {
                try {
                    const result = await endpoint.handler(req);
                    if (result instanceof Response) {
                        return result;
                    } else {
                        // If handler doesn't return Response, assume it's JSON
                        return new Response(JSON.stringify(result), {
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                } catch (error) {
                    logger.error(`Error in REST endpoint ${method} ${endpoint.path}`, error as any);
                    return new Response(JSON.stringify({ error: 'Internal server error' }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
        }

        // Fallback to GraphQL
        if (this.yoga) {
            return this.yoga(req);
        }

        return new Response('Not Found', { status: 404 });
    }

    async start() {
        logger.info("Application Started");
        const server = Bun.serve({
            fetch: this.handleRequest.bind(this),
        });
        logger.info(`Server is running on ${new URL(this.yoga?.graphqlEndpoint || '/graphql', `http://${server.hostname}:${server.port}`)}`)
    }
}