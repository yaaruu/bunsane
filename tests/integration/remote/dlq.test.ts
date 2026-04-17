import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RemoteManager } from "../../../core/remote/RemoteManager";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";
import { createMockRedisFactory } from "../../helpers/MockRedisClient";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Dead Letter Queue", () => {
    let server: MockRedisStreamServer;
    let producer: RemoteManager;

    beforeEach(async () => {
        server = new MockRedisStreamServer();
        producer = new RemoteManager({
            appName: "prod",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 0,
            shutdownDrainMs: 100,
        });
        await producer.start();
    });

    afterEach(async () => {
        await producer.shutdown();
    });

    test("poison message routed to DLQ after second delivery", async () => {
        // Consumer 1: handler fails → message stays in PEL with deliveryCount=1
        const c1 = new RemoteManager({
            appName: "cons",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 2,
            shutdownDrainMs: 100,
        });
        await c1.start();
        c1.on(
            "poison",
            async () => {
                throw new Error("always fails");
            },
            "h1"
        );
        await producer.emit("cons", "poison", { bad: true });
        await wait(200);
        expect(server.getPelSize("remote:cons", "cons")).toBe(1);
        await c1.shutdown();

        // Consumer 2: autoClaimIdleMs > 0 triggers XAUTOCLAIM on startup →
        // claims the orphan, deliveryCount becomes 2 → DLQ check fires.
        const c2 = new RemoteManager({
            appName: "cons",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 1,
            dlqMaxDeliveries: 2,
            shutdownDrainMs: 100,
            enableLogging: true,
        });
        await c2.start();
        c2.on(
            "poison",
            async () => {
                throw new Error("still fails");
            },
            "h1"
        );
        await wait(300);

        expect(server.getStreamLength("remote:cons:dlq")).toBe(1);
        const snap = c2.getMetrics();
        expect(snap.events.dlq).toBe(1);

        await c2.shutdown();
    });

    test("dlqMaxDeliveries=0 disables DLQ routing", async () => {
        const c1 = new RemoteManager({
            appName: "cons2",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 0,
            shutdownDrainMs: 100,
        });
        await c1.start();
        c1.on(
            "fail",
            async () => {
                throw new Error("x");
            },
            "h1"
        );
        await producer.emit("cons2", "fail", {});
        await wait(200);
        await c1.shutdown();

        const c2 = new RemoteManager({
            appName: "cons2",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 1,
            dlqMaxDeliveries: 0,
            shutdownDrainMs: 100,
        });
        await c2.start();
        c2.on(
            "fail",
            async () => {
                throw new Error("x");
            },
            "h1"
        );
        await wait(300);

        expect(server.getStreamLength("remote:cons2:dlq")).toBe(0);

        await c2.shutdown();
    });

    test("DLQ entry carries original_id + delivery_count metadata", async () => {
        const c1 = new RemoteManager({
            appName: "cons3",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 2,
            shutdownDrainMs: 100,
        });
        await c1.start();
        c1.on(
            "p",
            async () => {
                throw new Error("x");
            },
            "h1"
        );
        await producer.emit("cons3", "p", {});
        await wait(200);
        await c1.shutdown();

        const c2 = new RemoteManager({
            appName: "cons3",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 1,
            dlqMaxDeliveries: 2,
            shutdownDrainMs: 100,
        });
        await c2.start();
        c2.on(
            "p",
            async () => {
                throw new Error("x");
            },
            "h1"
        );
        await wait(300);

        const dlqEntries = server.xrange("remote:cons3:dlq", "-", "+");
        expect(dlqEntries.length).toBe(1);
        const [, fields] = dlqEntries[0]!;
        // fields = [k1, v1, k2, v2, ...]
        const flat = fields as string[];
        const idx = (k: string) => flat.indexOf(k);
        expect(idx("original_id")).toBeGreaterThanOrEqual(0);
        expect(idx("delivery_count")).toBeGreaterThanOrEqual(0);
        expect(idx("moved_at")).toBeGreaterThanOrEqual(0);
        expect(idx("data")).toBeGreaterThanOrEqual(0);

        await c2.shutdown();
    });
});
