import type { CorsConfig } from "../App";
import { setResponseHeaders } from "../middleware/headers";

export function assertValidCorsConfig(cors: CorsConfig): void {
    if (cors.origin === undefined) {
        throw new Error('[CORS] `origin` is required. Pass an explicit string, array, function, or "*" if you truly want to allow everyone.');
    }
    if (cors.credentials && cors.origin === '*') {
        console.warn('[CORS] Warning: credentials=true with origin="*" is invalid per spec. Origin will be reflected from request.');
    }
}

export function validateOrigin(
    cors: CorsConfig | undefined,
    requestOrigin: string | null | undefined,
): string | null {
    if (!cors || !requestOrigin) return null;

    const configOrigin = cors.origin;

    if (configOrigin === undefined) return null;

    if (configOrigin === '*') {
        return cors.credentials ? requestOrigin : '*';
    }

    if (typeof configOrigin === 'string') {
        return requestOrigin === configOrigin ? configOrigin : null;
    }

    if (Array.isArray(configOrigin)) {
        return configOrigin.includes(requestOrigin) ? requestOrigin : null;
    }

    if (typeof configOrigin === 'function') {
        return configOrigin(requestOrigin) ? requestOrigin : null;
    }

    return null;
}

export function getCorsHeaders(
    cors: CorsConfig | undefined,
    req?: Request,
): Record<string, string> {
    if (!cors) return {};

    const requestOrigin = req?.headers.get('Origin');
    const allowedOrigin = validateOrigin(cors, requestOrigin);

    if (requestOrigin && !allowedOrigin) return {};

    const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': cors.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': cors.allowedHeaders?.join(', ') || 'Content-Type, Authorization',
        'Vary': 'Origin',
    };
    if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin;
    }

    if (cors.credentials) {
        headers['Access-Control-Allow-Credentials'] = 'true';
    }

    if (cors.exposedHeaders?.length) {
        headers['Access-Control-Expose-Headers'] = cors.exposedHeaders.join(', ');
    }

    if (cors.maxAge !== undefined) {
        headers['Access-Control-Max-Age'] = String(cors.maxAge);
    }

    return headers;
}

export function addCorsHeaders(
    response: Response,
    cors: CorsConfig | undefined,
    req?: Request,
): Response {
    const corsHeaders = getCorsHeaders(cors, req);
    if (Object.keys(corsHeaders).length === 0) return response;
    return setResponseHeaders(response, Object.entries(corsHeaders));
}
