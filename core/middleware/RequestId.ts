import { AsyncLocalStorage } from 'async_hooks';
import type { Middleware } from '../Middleware';
import { setResponseHeaders } from './headers';

/**
 * AsyncLocalStorage to propagate requestId to any code running within a request.
 * Import this from your modules to access the current request's ID and logger.
 */
const requestStore = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
    return requestStore.getStore()?.requestId;
}

export { requestStore };

/**
 * Middleware that generates a unique request ID per request and stores it
 * in AsyncLocalStorage so it's accessible anywhere in the call stack.
 * Respects incoming X-Request-Id header (from load balancers/proxies).
 */
export function requestId(): Middleware {
    return async (req, next) => {
        // SEC-17: reject header injection and oversized ids. Generate instead.
        const inbound = req.headers.get('X-Request-Id');
        const id = inbound && /^[A-Za-z0-9-]{1,64}$/.test(inbound)
            ? inbound
            : crypto.randomUUID();

        return requestStore.run({ requestId: id }, async () => {
            const response = await next();
            return setResponseHeaders(response, [['X-Request-Id', id]]);
        });
    };
}
