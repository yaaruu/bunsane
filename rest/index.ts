export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
export type HTTPEndpointOptions = {
    method: HTTPMethod;
    path: string;
}

export function httpEndpoint(options: HTTPEndpointOptions) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.constructor.httpEndpoints) {
            target.constructor.httpEndpoints = [];
        }
        target.constructor.httpEndpoints.push({
            method: options.method,
            path: options.path,
            handler: descriptor.value
        });
    }
}

export class RestController {
    static httpEndpoints: Array<{ method: HTTPMethod; path: string; handler: Function }> = [];
}