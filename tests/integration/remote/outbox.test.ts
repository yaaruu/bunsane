import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RemoteManager } from "../../../core/remote/RemoteManager";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";
import { createMockRedisFactory } from "../../helpers/MockRedisClient";
import db from "../../../database";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Transactional Outbox", () => {
    let server: MockRedisStreamServer;
    let app: RemoteManager;

    beforeEach(async () => {
        // Clear any residual outbox rows from earlier tests
        try {
            await db`DELETE FROM remote_outbox`;
        } catch {
            /* table may not exist yet */
        }
        server = new MockRedisStreamServer();
        app = new RemoteManager({
            appName: "app",
            redisFactory: createMockRedisFactory(server),
            blockMs: 30,
            autoClaimIdleMs: 0,
            dlqMaxDeliveries: 0,
            shutdownDrainMs: 100,
            enableOutbox: true,
            outboxPollIntervalMs: 50,
            outboxBatchSize: 10,
        });
        await app.start();
    });

    afterEach(async () => {
        await app.shutdown();
    });

    test("emit({ trx }) inserts outbox row within transaction", async () => {
        await (db as any).begin(async (trx: any) => {
            const id = await app.emit(
                "downstream",
                "order.created",
                { orderId: "abc" },
                { trx }
            );
            expect(id).toBeDefined();
        });

        const rows = await db`
            SELECT target, event, data, published_at
            FROM remote_outbox
        `;
        expect(rows.length).toBe(1);
        expect(rows[0]!.target).toBe("downstream");
        expect(rows[0]!.event).toBe("order.created");
    });

    test("worker publishes committed rows to Redis + marks published_at", async () => {
        await (db as any).begin(async (trx: any) => {
            await app.emit(
                "downstream",
                "published.event",
                { n: 1 },
                { trx }
            );
        });
        await wait(200); // allow at least one poll tick

        // Row should now be marked published
        const rows = await db`
            SELECT published_at FROM remote_outbox
            WHERE event = 'published.event'
        `;
        expect(rows[0]!.published_at).not.toBeNull();

        // Stream should have the message
        expect(server.getStreamLength("remote:downstream")).toBeGreaterThanOrEqual(
            1
        );
    });

    test("rolled-back transaction suppresses publish", async () => {
        try {
            await (db as any).begin(async (trx: any) => {
                await app.emit(
                    "downstream",
                    "rolled.back",
                    { n: 2 },
                    { trx }
                );
                throw new Error("force rollback");
            });
        } catch {
            /* expected */
        }
        await wait(200);

        const rows = await db`
            SELECT COUNT(*)::int AS c FROM remote_outbox
            WHERE event = 'rolled.back'
        `;
        expect(rows[0]!.c).toBe(0);
        expect(server.getStreamLength("remote:downstream")).toBe(0);
    });

    test("direct emit + outbox emit hit same target stream", async () => {
        await app.emit("other", "direct", { n: "a" });
        await (db as any).begin(async (trx: any) => {
            await app.emit("other", "outbox", { n: "b" }, { trx });
        });
        await wait(200);

        const entries = server.xrange("remote:other", "-", "+");
        expect(entries.length).toBe(2);
    });

    test("metrics count emit.direct vs emit.outbox separately", async () => {
        await app.emit("dst", "direct", {});
        await (db as any).begin(async (trx: any) => {
            await app.emit("dst", "outbox", {}, { trx });
        });
        await wait(150);

        const snap = app.getMetrics();
        expect(snap.emit.direct).toBe(1);
        expect(snap.emit.outbox).toBe(1);
        expect(snap.outbox.published).toBeGreaterThanOrEqual(1);
    });
});
