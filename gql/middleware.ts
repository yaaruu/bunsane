import { GraphQLError } from "graphql";

/**
 * Middleware function for GraphQL operations (onion model).
 *
 * Call `next()` to continue to the next middleware or the resolver.
 * Throw a `GraphQLError` to short-circuit the chain.
 * Return the result of `next()` (or transform it).
 */
export type OperationMiddleware = (
    args: any,
    context: any,
    info: any,
    next: () => Promise<any>,
) => Promise<any>;

/**
 * Compose an array of OperationMiddleware into a single chain.
 * The final `handler` is the original service method.
 */
export function composeOperationMiddleware(
    middlewares: OperationMiddleware[],
    handler: (...args: any[]) => Promise<any>,
    thisArg: any,
): (args: any, context: any, info: any) => Promise<any> {
    return (args: any, context: any, info: any) => {
        let index = 0;
        const dispatch = (): Promise<any> => {
            if (index >= middlewares.length) {
                return handler.call(thisArg, args, context, info);
            }
            const mw = middlewares[index++]!;
            return mw(args, context, info, dispatch);
        };
        return dispatch();
    };
}

/**
 * Decorator that attaches an ordered chain of middleware to a GraphQL operation.
 *
 * Middleware execute in array order (left-to-right), wrapping the resolver
 * in an onion model identical to HTTP middleware.
 *
 * @example
 * ```ts
 * const Authenticate: OperationMiddleware = async (args, ctx, info, next) => {
 *     if (!ctx.user) throw new GraphQLError("Unauthenticated", {
 *         extensions: { code: "UNAUTHENTICATED", http: { status: 401 } }
 *     });
 *     return next();
 * };
 *
 * function Authorize(...permissions: string[]): OperationMiddleware {
 *     return async (args, ctx, info, next) => {
 *         if (!permissions.every(p => ctx.user.permissions?.includes(p)))
 *             throw new GraphQLError("Forbidden", {
 *                 extensions: { code: "FORBIDDEN", http: { status: 403 } }
 *             });
 *         return next();
 *     };
 * }
 *
 * class UserService extends BaseService {
 *     @Middleware([Authenticate, Authorize("users.read")])
 *     @GraphQLOperation({ type: "Query", output: "User", input: { id: "ID!" } })
 *     async getUser(args, context, info) { ... }
 * }
 * ```
 */
export function Middleware(middlewares: OperationMiddleware[]) {
    return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
        const original = descriptor.value;
        descriptor.value = function (this: any, args: any, context: any, info: any) {
            const chain = composeOperationMiddleware(middlewares, original, this);
            return chain(args, context, info);
        };
    };
}
