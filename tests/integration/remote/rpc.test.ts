import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RemoteManager } from "../../../core/remote/RemoteManager";
import { RemoteError } from "../../../core/remote/types";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";
import { createMockRedisFactory } from "../../helpers/MockRedisClient";

describe("RPC round-trip", () => {
    let server: MockRedisStreamServer;
    let client: RemoteManager;
    let server_app: RemoteManager;

    beforeEach(async () => {
        server = new MockRedisStreamServer();
        client = new RemoteManager({
            appName: "client-app",
            redisFactory: createMockRedisFactory(server),
            blockMs: 50,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 0,
            shutdownDrainMs: 100,
            defaultCallTimeout: 1000,
        });
        server_app = new RemoteManager({
            appName: "server-app",
            redisFactory: createMockRedisFactory(server),
            blockMs: 50,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 0,
            shutdownDrainMs: 100,
        });
        await client.start();
        await server_app.start();
    });

    afterEach(async () => {
        await client.shutdown();
        await server_app.shutdown();
    });

    test("call() returns handler result", async () => {
        server_app.onRpc(
            "order.get",
            async (data: any) => ({ id: data.id, status: "ok" }),
            "h1"
        );
        const result = await client.call<{ id: string; status: string }>(
            "server-app",
            "order.get",
            { id: "abc" }
        );
        expect(result).toEqual({ id: "abc", status: "ok" });
    });

    test("call() rejects with TIMEOUT when no handler registered", async () => {
        // server_app has no handler — still returns NOT_FOUND, not TIMEOUT
        try {
            await client.call(
                "server-app",
                "nonexistent.method",
                {},
                { timeout: 500 }
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteError);
            expect((err as RemoteError).code).toBe("NOT_FOUND");
        }
    });

    test("call() rejects with TIMEOUT when target app down", async () => {
        // Kill server_app — no consumer for the request stream
        await server_app.shutdown();
        try {
            await client.call(
                "server-app",
                "anything",
                {},
                { timeout: 200 }
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteError);
            expect((err as RemoteError).code).toBe("TIMEOUT");
        }
    });

    test("call() to broadcast target * rejects INVALID_TARGET", async () => {
        try {
            await client.call("*", "anything", {});
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteError);
            expect((err as RemoteError).code).toBe("INVALID_TARGET");
        }
    });

    test("handler exception propagates as HANDLER_ERROR", async () => {
        server_app.onRpc(
            "fail",
            async () => {
                throw new Error("something bad");
            },
            "h1"
        );
        try {
            await client.call("server-app", "fail", {});
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteError);
            expect((err as RemoteError).code).toBe("HANDLER_ERROR");
        }
    });

    test("handler custom RemoteError code flows through", async () => {
        server_app.onRpc(
            "forbidden",
            async () => {
                throw new RemoteError("no", {
                    code: "FORBIDDEN",
                    extensions: { reason: "test" },
                });
            },
            "h1"
        );
        try {
            await client.call("server-app", "forbidden", {});
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteError);
            const re = err as RemoteError;
            expect(re.code).toBe("FORBIDDEN");
            expect(re.extensions).toEqual({ reason: "test" });
        }
    });

    test("ctx carries correlationId + deadline", async () => {
        let captured: any = null;
        server_app.onRpc(
            "ctx-check",
            async (_data, ctx) => {
                captured = {
                    correlationId: ctx.correlationId,
                    deadline: ctx.deadline,
                    sourceApp: ctx.sourceApp,
                };
                return null;
            },
            "h1"
        );
        await client.call("server-app", "ctx-check", {}, { timeout: 2000 });
        expect(captured.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(captured.deadline).toBeInstanceOf(Date);
        expect(captured.sourceApp).toBe("client-app");
    });

    test("metrics track successful + failed RPCs", async () => {
        server_app.onRpc("ok", async () => "x", "h1");
        server_app.onRpc(
            "bad",
            async () => {
                throw new Error("x");
            },
            "h2"
        );
        await client.call("server-app", "ok", {});
        await client.call("server-app", "bad", {}).catch(() => {});

        const clientSnap = client.getMetrics();
        expect(clientSnap.rpc.called).toBe(2);
        expect(clientSnap.rpc.succeeded).toBe(1);
        expect(clientSnap.rpc.failed).toBe(1);

        const serverSnap = server_app.getMetrics();
        expect(serverSnap.rpc.handlerExecuted).toBe(1);
        expect(serverSnap.rpc.handlerFailed).toBe(1);
    });
});
