import { logger as MainLogger } from './Logger';
const logger = MainLogger.child({ scope: 'Middleware' });

export type MiddlewareNext = () => Promise<Response>;

/** Per-request values the server knows and middleware cannot see on Request alone. */
export type MiddlewareContext = {
    /** Socket address from `server.requestIP(req)`, when Bun provided one. */
    clientIp?: string;
};

export type Middleware = (
    req: Request,
    next: MiddlewareNext,
    ctx?: MiddlewareContext,
) => Promise<Response>;

/**
 * Composes an array of middleware into a single handler function.
 * Each middleware wraps the next, forming an onion-style execution chain.
 */
export function composeMiddleware(
    middlewares: Middleware[],
    finalHandler: (req: Request, ctx: MiddlewareContext) => Promise<Response>,
): (req: Request, ctx?: MiddlewareContext) => Promise<Response> {
    return (req: Request, ctx: MiddlewareContext = {}) => {
        let index = -1;

        function dispatch(i: number): Promise<Response> {
            if (i <= index) {
                return Promise.reject(new Error('next() called multiple times'));
            }
            index = i;

            if (i >= middlewares.length) {
                return finalHandler(req, ctx);
            }

            const middleware = middlewares[i]!;
            return middleware(req, () => dispatch(i + 1), ctx);
        }

        return dispatch(0);
    };
}
