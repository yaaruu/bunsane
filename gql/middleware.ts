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
 *
 * The middleware list is closed over once. Each invocation gets its own
 * index so concurrent calls do not share mutable chain state.
 */
export function bindOperationMiddleware(
    middlewares: readonly OperationMiddleware[],
): (
    handler: (...args: unknown[]) => Promise<unknown>,
    thisArg: unknown,
    args: unknown,
    context: unknown,
    info: unknown,
) => Promise<unknown> {
    const chain = middlewares;
    const len = chain.length;
    return (handler, thisArg, args, context, info) => {
        const dispatch = (index: number): Promise<unknown> => {
            if (index >= len) {
                return handler.call(thisArg, args, context, info);
            }
            const mw = chain[index];
            if (!mw) return handler.call(thisArg, args, context, info);
            return mw(args, context, info, () => dispatch(index + 1));
        };
        return dispatch(0);
    };
}

export function composeOperationMiddleware(
    middlewares: OperationMiddleware[],
    handler: (...args: unknown[]) => Promise<unknown>,
    thisArg: unknown,
): (args: unknown, context: unknown, info: unknown) => Promise<unknown> {
    const run = bindOperationMiddleware(middlewares);
    return (args, context, info) => run(handler, thisArg, args, context, info);
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
    const run = bindOperationMiddleware(middlewares);
    return function (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) {
        const original = descriptor.value;
        descriptor.value = function (this: unknown, args: unknown, context: unknown, info: unknown) {
            return run(original, this, args, context, info);
        };
    };
}
