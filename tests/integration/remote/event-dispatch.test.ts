import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RemoteManager } from "../../../core/remote/RemoteManager";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";
import { createMockRedisFactory } from "../../helpers/MockRedisClient";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Event round-trip over mock Redis", () => {
    let server: MockRedisStreamServer;
    let appA: RemoteManager;
    let appB: RemoteManager;

    beforeEach(async () => {
        server = new MockRedisStreamServer();
        appA = new RemoteManager({
            appName: "app-a",
            redisFactory: createMockRedisFactory(server),
            blockMs: 50,
            autoClaimIdleMs: 0, // skip orphan reclaim
            dlqMaxDeliveries: 0, // no DLQ for basic tests
        });
        appB = new RemoteManager({
            appName: "app-b",
            redisFactory: createMockRedisFactory(server),
            blockMs: 50,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 0,
        });
        await appA.start();
        await appB.start();
    });

    afterEach(async () => {
        await appA.shutdown();
        await appB.shutdown();
    });

    test("emit from A is received by B's handler", async () => {
        const received: any[] = [];
        appB.on(
            "order.created",
            async (data, ctx) => {
                received.push({ data, sourceApp: ctx.sourceApp });
            },
            "h1"
        );

        await appA.emit("app-b", "order.created", { orderId: "abc" });
        await wait(150);

        expect(received).toHaveLength(1);
        expect(received[0].data).toEqual({ orderId: "abc" });
        expect(received[0].sourceApp).toBe("app-a");
    });

    test("handler receives ctx.attempt=1 on first delivery", async () => {
        const attempts: number[] = [];
        appB.on(
            "x",
            async (_data, ctx) => {
                attempts.push(ctx.attempt);
            },
            "h1"
        );
        await appA.emit("app-b", "x", {});
        await wait(150);
        expect(attempts).toEqual([1]);
    });

    test("no-handler event is ACKed silently", async () => {
        await appA.emit("app-b", "unhandled.event", {});
        await wait(150);
        // PEL should be empty after ACK
        expect(server.getPelSize("remote:app-b", "app-b")).toBe(0);
        const snap = appB.getMetrics();
        expect(snap.events.noHandler).toBeGreaterThan(0);
    });

    test("multiple handlers all fire for one event", async () => {
        const log: string[] = [];
        appB.on("e", async () => { log.push("h1"); }, "h1");
        appB.on("e", async () => { log.push("h2"); }, "h2");
        await appA.emit("app-b", "e", {});
        await wait(150);
        expect(log.sort()).toEqual(["h1", "h2"]);
    });

    test("handler failure leaves message in PEL (no ACK)", async () => {
        appB.on(
            "fail",
            async () => {
                throw new Error("handler boom");
            },
            "h1"
        );
        await appA.emit("app-b", "fail", {});
        await wait(150);
        expect(server.getPelSize("remote:app-b", "app-b")).toBe(1);
        const snap = appB.getMetrics();
        expect(snap.events.handlerFailed).toBe(1);
    });

    test("metrics reflect emit + receive counters", async () => {
        appB.on("m", async () => {}, "h1");
        await appA.emit("app-b", "m", {});
        await appA.emit("app-b", "m", {});
        await wait(200);

        const aSnap = appA.getMetrics();
        const bSnap = appB.getMetrics();
        expect(aSnap.emit.direct).toBe(2);
        expect(bSnap.events.handled).toBe(2);
    });
});
