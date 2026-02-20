import { describe, it, expect } from "bun:test";
import { GraphQLError } from "graphql";
import {
    Middleware,
    composeOperationMiddleware,
    type OperationMiddleware,
} from "../../../gql/middleware";

// --- Test helpers ---

function createMockService() {
    return {
        getUser: async (args: any, context: any, _info: any) => {
            return { id: args.id, name: "Test User", role: context.user?.role };
        },
        createUser: async (args: any, _context: any, _info: any) => {
            return { id: "new-1", name: args.name };
        },
    };
}

const Authenticate: OperationMiddleware = async (args, ctx, info, next) => {
    if (!ctx.user) {
        throw new GraphQLError("Unauthenticated", {
            extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
        });
    }
    return next();
};

function Authorize(...permissions: string[]): OperationMiddleware {
    return async (args, ctx, info, next) => {
        const userPerms: string[] = ctx.user?.permissions ?? [];
        if (!permissions.every((p) => userPerms.includes(p))) {
            throw new GraphQLError("Forbidden", {
                extensions: { code: "FORBIDDEN", http: { status: 403 } },
            });
        }
        return next();
    };
}

// --- Tests ---

describe("composeOperationMiddleware", () => {
    it("calls handler directly with empty middleware array", async () => {
        const handler = async (args: any) => args.value;
        const chain = composeOperationMiddleware([], handler, null);
        const result = await chain({ value: 42 }, {}, {});
        expect(result).toBe(42);
    });

    it("executes middleware in order", async () => {
        const order: number[] = [];
        const mw1: OperationMiddleware = async (a, c, i, next) => {
            order.push(1);
            const result = await next();
            order.push(4);
            return result;
        };
        const mw2: OperationMiddleware = async (a, c, i, next) => {
            order.push(2);
            const result = await next();
            order.push(3);
            return result;
        };
        const handler = async () => {
            order.push(0);
            return "done";
        };
        const chain = composeOperationMiddleware([mw1, mw2], handler, null);
        await chain({}, {}, {});
        expect(order).toEqual([1, 2, 0, 3, 4]);
    });

    it("short-circuits when middleware throws", async () => {
        const handlerCalled = { value: false };
        const mw: OperationMiddleware = async () => {
            throw new GraphQLError("Blocked");
        };
        const handler = async () => {
            handlerCalled.value = true;
        };
        const chain = composeOperationMiddleware([mw], handler, null);
        expect(chain({}, {}, {})).rejects.toThrow("Blocked");
        expect(handlerCalled.value).toBe(false);
    });

    it("middleware can transform the return value", async () => {
        const transform: OperationMiddleware = async (a, c, i, next) => {
            const result = await next();
            return { ...result, extra: true };
        };
        const handler = async () => ({ name: "test" });
        const chain = composeOperationMiddleware([transform], handler, null);
        const result = await chain({}, {}, {});
        expect(result).toEqual({ name: "test", extra: true });
    });

    it("preserves thisArg for the handler", async () => {
        const service = {
            prefix: "Hello",
            greet: async function (args: any) {
                return `${this.prefix} ${args.name}`;
            },
        };
        const passthrough: OperationMiddleware = async (a, c, i, next) => next();
        const chain = composeOperationMiddleware(
            [passthrough],
            service.greet,
            service,
        );
        const result = await chain({ name: "World" }, {}, {});
        expect(result).toBe("Hello World");
    });
});

describe("@Middleware decorator", () => {
    it("wraps a method with middleware chain", async () => {
        const log: string[] = [];
        const logger: OperationMiddleware = async (a, c, i, next) => {
            log.push("before");
            const result = await next();
            log.push("after");
            return result;
        };

        class TestService {
            @Middleware([logger])
            async getData(args: any, _ctx: any, _info: any) {
                log.push("handler");
                return { value: args.id };
            }
        }

        const svc = new TestService();
        const result = await svc.getData({ id: 1 }, {}, {});
        expect(result).toEqual({ value: 1 });
        expect(log).toEqual(["before", "handler", "after"]);
    });

    it("chains multiple middleware in order", async () => {
        const order: string[] = [];
        const first: OperationMiddleware = async (a, c, i, next) => {
            order.push("first-in");
            const r = await next();
            order.push("first-out");
            return r;
        };
        const second: OperationMiddleware = async (a, c, i, next) => {
            order.push("second-in");
            const r = await next();
            order.push("second-out");
            return r;
        };

        class TestService {
            @Middleware([first, second])
            async doWork(_args: any, _ctx: any, _info: any) {
                order.push("resolver");
                return true;
            }
        }

        await new TestService().doWork({}, {}, {});
        expect(order).toEqual([
            "first-in",
            "second-in",
            "resolver",
            "second-out",
            "first-out",
        ]);
    });

    it("preserves this context of the service", async () => {
        class TestService {
            private secret = "s3cret";

            @Middleware([async (a, c, i, next) => next()])
            async getSecret(_args: any, _ctx: any, _info: any) {
                return this.secret;
            }
        }

        const result = await new TestService().getSecret({}, {}, {});
        expect(result).toBe("s3cret");
    });
});

describe("Auth guard middleware", () => {
    it("Authenticate allows requests with user in context", async () => {
        const service = createMockService();

        class UserService {
            @Middleware([Authenticate])
            async getUser(args: any, context: any, info: any) {
                return service.getUser(args, context, info);
            }
        }

        const svc = new UserService();
        const result = await svc.getUser(
            { id: "1" },
            { user: { role: "admin" } },
            {},
        );
        expect(result).toEqual({ id: "1", name: "Test User", role: "admin" });
    });

    it("Authenticate rejects requests without user", async () => {
        class UserService {
            @Middleware([Authenticate])
            async getUser(args: any, ctx: any, info: any) {
                return { id: args.id };
            }
        }

        try {
            await new UserService().getUser({ id: "1" }, {}, {});
            expect.unreachable("Should have thrown");
        } catch (err: any) {
            expect(err).toBeInstanceOf(GraphQLError);
            expect(err.extensions.code).toBe("UNAUTHENTICATED");
            expect(err.extensions.http.status).toBe(401);
        }
    });

    it("Authorize allows requests with correct permissions", async () => {
        class UserService {
            @Middleware([Authenticate, Authorize("users.read")])
            async getUser(args: any, ctx: any, info: any) {
                return { id: args.id };
            }
        }

        const ctx = { user: { permissions: ["users.read", "users.write"] } };
        const result = await new UserService().getUser({ id: "1" }, ctx, {});
        expect(result).toEqual({ id: "1" });
    });

    it("Authorize rejects requests with missing permissions", async () => {
        class UserService {
            @Middleware([Authenticate, Authorize("users.delete")])
            async deleteUser(args: any, ctx: any, info: any) {
                return true;
            }
        }

        const ctx = { user: { permissions: ["users.read"] } };
        try {
            await new UserService().deleteUser({ id: "1" }, ctx, {});
            expect.unreachable("Should have thrown");
        } catch (err: any) {
            expect(err).toBeInstanceOf(GraphQLError);
            expect(err.extensions.code).toBe("FORBIDDEN");
            expect(err.extensions.http.status).toBe(403);
        }
    });

    it("Authenticate runs before Authorize in the chain", async () => {
        class UserService {
            @Middleware([Authenticate, Authorize("admin")])
            async adminOp(_args: any, _ctx: any, _info: any) {
                return true;
            }
        }

        // No user → should get UNAUTHENTICATED, not FORBIDDEN
        try {
            await new UserService().adminOp({}, {}, {});
            expect.unreachable("Should have thrown");
        } catch (err: any) {
            expect(err.extensions.code).toBe("UNAUTHENTICATED");
        }
    });

    it("resolver does not execute when middleware rejects", async () => {
        let resolverCalled = false;

        class UserService {
            @Middleware([Authenticate])
            async getUser(_args: any, _ctx: any, _info: any) {
                resolverCalled = true;
                return {};
            }
        }

        try {
            await new UserService().getUser({}, {}, {});
        } catch {}
        expect(resolverCalled).toBe(false);
    });
});
