import { logger as MainLogger } from './Logger';
const logger = MainLogger.child({ scope: 'Middleware' });

export type MiddlewareNext = () => Promise<Response>;
export type Middleware = (req: Request, next: MiddlewareNext) => Promise<Response>;

/**
 * Composes an array of middleware into a single handler function.
 * Each middleware wraps the next, forming an onion-style execution chain.
 */
export function composeMiddleware(
    middlewares: Middleware[],
    finalHandler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
    return (req: Request) => {
        let index = -1;

        function dispatch(i: number): Promise<Response> {
            if (i <= index) {
                return Promise.reject(new Error('next() called multiple times'));
            }
            index = i;

            if (i >= middlewares.length) {
                return finalHandler(req);
            }

            const middleware = middlewares[i]!;
            return middleware(req, () => dispatch(i + 1));
        }

        return dispatch(0);
    };
}
