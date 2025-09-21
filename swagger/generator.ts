import type { SwaggerEndpointMetadata } from "./decorators";

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

    constructor(title: string = "API Documentation", version: string = "1.0.0") {
        this.spec = {
            openapi: "3.0.0",
            info: {
                title,
                version
            },
            paths: {}
        };
    }

    addEndpoint(metadata: SwaggerEndpointMetadata) {
        const { method, path, operation } = metadata;

        if (!this.spec.paths[path]) {
            this.spec.paths[path] = {};
        }

        this.spec.paths[path][method.toLowerCase()] = {
            ...operation,
            responses: operation.responses || {
                "200": {
                    description: "Success"
                }
            }
        };
    }

    addServer(url: string, description?: string) {
        if (!this.spec.servers) {
            this.spec.servers = [];
        }
        this.spec.servers.push({ url, description });
    }

    addSecurityScheme(name: string, scheme: any) {
        if (!this.spec.components) {
            this.spec.components = {};
        }
        if (!this.spec.components.securitySchemes) {
            this.spec.components.securitySchemes = {};
        }
        this.spec.components.securitySchemes[name] = scheme;
    }

    addSchema(name: string, schema: any) {
        if (!this.spec.components) {
            this.spec.components = {};
        }
        if (!this.spec.components.schemas) {
            this.spec.components.schemas = {};
        }
        this.spec.components.schemas[name] = schema;
    }

    generate(): OpenAPISpec {
        return this.spec;
    }

    toJSON(): string {
        return JSON.stringify(this.spec, null, 2);
    }
}