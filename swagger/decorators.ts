import type { HTTPMethod } from "../rest";

export interface OpenAPIOperation {
    summary?: string;
    description?: string;
    tags?: string[];
    parameters?: OpenAPIParameter[];
    requestBody?: OpenAPIRequestBody;
    responses?: Record<string, OpenAPIResponse>;
    security?: any[];
}

export interface OpenAPIParameter {
    name: string;
    in: 'query' | 'header' | 'path' | 'cookie';
    description?: string;
    required?: boolean;
    schema: any;
}

export interface OpenAPIRequestBody {
    description?: string;
    required?: boolean;
    content: Record<string, { schema: any }>;
}

export interface OpenAPIResponse {
    description: string;
    content?: Record<string, { schema: any }>;
}

export interface SwaggerEndpointMetadata {
    method: HTTPMethod;
    path: string;
    operation: OpenAPIOperation;
}

export function ApiOperation(operation: OpenAPIOperation) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        // Store the operation on the function itself
        (descriptor.value as any).swaggerOperation = operation;
    }
}

export function ApiTags(...tags: string[]) {
    return function (target: any, propertyKey?: string) {
        if (propertyKey) {
            // Method decorator
            if (!target.constructor.swaggerMethodTags) {
                target.constructor.swaggerMethodTags = {};
            }
            target.constructor.swaggerMethodTags[propertyKey] = tags;
        } else {
            // Class decorator
            target.swaggerClassTags = tags;
        }
    };
}