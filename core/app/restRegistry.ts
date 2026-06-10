import { logger as MainLogger } from "../Logger";

const logger = MainLogger.child({ scope: "App" });

export function collectRestEndpoints(app: any, services: any[]): void {
    for (const service of services) {
        const endpoints = (service.constructor as any).httpEndpoints;
        if (!endpoints) continue;

        for (const endpoint of endpoints) {
            // Precompile the parameterized regex once so the hot-path router
            // never calls replace + new RegExp per request.
            const hasParams = endpoint.path.includes(':');
            const regex = hasParams
                ? new RegExp(`^${endpoint.path.replace(/:[^/]+/g, '[^/]+')}$`)
                : undefined;

            const endpointInfo = {
                method: endpoint.method,
                path: endpoint.path,
                regex,
                handler: endpoint.handler.bind(service),
                service: service,
            };
            logger.trace(
                `Registered REST endpoint: [${endpoint.method}] ${endpoint.path} for service ${service.constructor.name}`,
            );
            app.restEndpoints.push(endpointInfo);
            app.restEndpointMap.set(`${endpoint.method}:${endpoint.path}`, endpointInfo);

            if ((endpoint.handler as any).swaggerOperation) {
                const classTags = (service.constructor as any).swaggerClassTags || [];
                const methodTags =
                    (service.constructor as any).swaggerMethodTags?.[endpoint.handler.name] || [];
                const allTags = [...classTags, ...methodTags];

                logger.trace(
                    `Generating OpenAPI spec for endpoint: [${endpoint.method}] ${endpoint.path} with tags: ${allTags.join(", ")}`,
                );

                const operation = { ...(endpoint.handler as any).swaggerOperation };
                if (allTags.length > 0) {
                    operation.tags = [...(operation.tags || []), ...allTags];
                }

                app.openAPISpecGenerator!.addEndpoint({
                    method: endpoint.method,
                    path: endpoint.path,
                    operation,
                });
                logger.trace(
                    `Registered OpenAPI spec for endpoint: [${endpoint.method}] ${endpoint.path}`,
                );
            } else if (app.enforceDocs) {
                logger.warn(
                    `No swagger operation found for endpoint: [${endpoint.method}] ${endpoint.path} in service ${service.constructor.name}`,
                );
                app.openAPISpecGenerator!.addEndpoint({
                    method: endpoint.method,
                    path: endpoint.path,
                    operation: {
                        summary: `No description for ${endpoint.path}. Don't use this endpoint until it's properly documented!`,
                        requestBody: {
                            content: {
                                "application/json": {
                                    schema: {},
                                },
                            },
                        },
                        responses: {
                            "200": {
                                description: "Success",
                            },
                        },
                    },
                });
            }
        }
    }
}
