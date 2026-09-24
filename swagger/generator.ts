import type { SwaggerEndpointMetadata } from "./decorators";
import {logger as MainLogger}  from "../core/Logger";
const logger = MainLogger.child({ scope: "OpenAPISpecGenerator" });
export interface OpenAPISpec {
    openapi: string;
    info: {
        title: string;
        version: string;
        description?: string;
    };
    servers?: Array<{
        url: string;
        description?: string;
    }>;
    paths: Record<string, Record<string, any>>;
    components?: {
        schemas?: Record<string, any>;
        securitySchemes?: Record<string, any>;
    };
    tags?: Array<{
        name: string;
        description?: string;
    }>;
}

export class OpenAPISpecGenerator {
    private spec: OpenAPISpec;
    private _jsonCache: string | undefined;

    constructor(title: string = "API Documentation", version: string = "1.0.0") {
        this.spec = {
            openapi: "3.0.0",
            info: {
                title,
                version
            },
            paths: {},
            components: {},
        };
    }

    addEndpoint(metadata: SwaggerEndpointMetadata) {
        const { method, path, operation } = metadata;
        logger.trace(`Adding endpoint to OpenAPI spec: [${method}] ${path}`);
        if (!this.spec.paths[path]) {
            this.spec.paths[path] = {};
        }

        const published = { ...operation };
        const authenticated = published.authenticated === true;
        delete published.authenticated;
        const declaredSecurity = Array.isArray(published.security) && published.security.length > 0;
        if (authenticated && !declaredSecurity) {
            published.security = [{ BearerAuth: [] }];
        }
        if (authenticated || declaredSecurity) {
            this.ensureBearerAuth();
        }

        this.spec.paths[path][method.toLowerCase()] = {
            ...published,
            responses: published.responses || {
                "200": {
                    description: "Success"
                }
            }
        };
        this._jsonCache = undefined;
    }

    private ensureBearerAuth() {
        this.addSecurityScheme("BearerAuth", {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
        });
    }

    addServer(url: string, description?: string) {
        if (!this.spec.servers) {
            this.spec.servers = [];
        }
        this.spec.servers.push({ url, description });
        this._jsonCache = undefined;
    }

    addSecurityScheme(name: string, scheme: any) {
        if (!this.spec.components) {
            this.spec.components = {};
        }
        if (!this.spec.components.securitySchemes) {
            this.spec.components.securitySchemes = {};
        }
        this.spec.components.securitySchemes[name] = scheme;
        this._jsonCache = undefined;
    }

    addSchema(name: string, schema: any) {
        if (!this.spec.components) {
            this.spec.components = {};
        }
        if (!this.spec.components.schemas) {
            this.spec.components.schemas = {};
        }
        this.spec.components.schemas[name] = schema;
        this._jsonCache = undefined;
    }

    generate(): OpenAPISpec {
        return this.spec;
    }

    // Memoized — spec is frozen after startup so re-serialization per request
    // is unnecessary. Mutator methods above clear the cache on any post-boot change.
    toJSON(): string {
        if (!this._jsonCache) {
            this._jsonCache = JSON.stringify(this.spec, null, 2);
        }
        return this._jsonCache;
    }
}