import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type Redis from "ioredis";
import { StreamConsumer } from "../../../core/remote/StreamConsumer";
import { RemoteMetrics } from "../../../core/remote/metrics";
import {
    encodeEnvelope,
    isAllowedReplyTo,
    RPC_SECRET_ENV,
    verifyEnvelopeSignature,
} from "../../../core/remote/envelopeSign";
import { resetIdempotencyCache } from "../../../core/remote/idempotency";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";
import { MockRedisClient } from "../../helpers/MockRedisClient";

// The consumer is a background XREADGROUP loop; these waits bound that poll.
// A gate cannot replace them when the assertion is "handler was not called".
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function envelope(overrides: Record<string, unknown> = {}) {
    return {
        kind: "event" as const,
        sourceApp: "peer",
        event: "ping",
        data: { n: 1 },
        emittedAt: 1,
        ...overrides,
    };
}

describe("RPC trust boundary", () => {
    const prev = process.env[RPC_SECRET_ENV];

    beforeEach(() => {
        delete process.env[RPC_SECRET_ENV];
        resetIdempotencyCache();
    });

    afterEach(() => {
        if (prev === undefined) delete process.env[RPC_SECRET_ENV];
        else process.env[RPC_SECRET_ENV] = prev;
        resetIdempotencyCache();
    });

    test("replyTo must stay under the response-stream prefix", () => {
        expect(isAllowedReplyTo("rpc:responses:11111111-2222-3333-4444-555555555555")).toBe(true);
        expect(isAllowedReplyTo("remote:secrets")).toBe(false);
        expect(isAllowedReplyTo("rpc:responses:")).toBe(false);
        expect(isAllowedReplyTo("rpc:responses:foo/bar")).toBe(false);
        expect(isAllowedReplyTo("rpc:responses:../other")).toBe(false);
    });

    test("secret rejects unsigned and tampered envelopes; unset stays legacy", () => {
        const raw = envelope();
        process.env[RPC_SECRET_ENV] = "test-secret";
        const signed = JSON.parse(encodeEnvelope(raw));
        expect(verifyEnvelopeSignature(signed, "test-secret")).toBe(true);
        expect(verifyEnvelopeSignature(raw, "test-secret")).toBe(false);
        signed.data = { n: 2 };
        expect(verifyEnvelopeSignature(signed, "test-secret")).toBe(false);

        delete process.env[RPC_SECRET_ENV];
        expect(encodeEnvelope(raw)).toBe(JSON.stringify(raw));
    });

    test("Date payloads verify and nested sig is part of the signature", () => {
        process.env[RPC_SECRET_ENV] = "test-secret";
        const when = new Date("2020-01-02T03:04:05.000Z");
        const raw = {
            ...envelope(),
            data: { when, sig: "nested" },
        };
        const signed = JSON.parse(encodeEnvelope(raw));
        expect(signed.data.when).toBe(when.toISOString());
        expect(verifyEnvelopeSignature(signed, "test-secret")).toBe(true);
        signed.data.sig = "tampered";
        expect(verifyEnvelopeSignature(signed, "test-secret")).toBe(false);
    });

    test("consumer ACK-drops a bad signature and a foreign replyTo", async () => {
        const server = new MockRedisStreamServer();
        const redis = new MockRedisClient(server) as unknown as Redis;
        const publisher = new MockRedisClient(server) as unknown as Redis;
        const metrics = new RemoteMetrics();
        const consumer = new StreamConsumer(redis, publisher, {
            appName: "app",
            blockMs: 20,
            autoClaimIdleMs: 0,
            consumerConcurrency: 2,
        }, metrics);

        let handlerCalls = 0;
        await consumer.start();
        consumer.addHandler("ping", () => {
            handlerCalls++;
        }, "h");
        consumer.addRpcHandler("order.get", async () => ({ ok: true }), "rpc");

        process.env[RPC_SECRET_ENV] = "test-secret";
        await publisher.xadd(
            "remote:app",
            "*",
            "data",
            JSON.stringify(envelope())
        );


        await wait(80);
        expect(handlerCalls).toBe(0);
        expect(metrics.getSnapshot().security.signatureRejected).toBe(1);

        delete process.env[RPC_SECRET_ENV];
        await publisher.xadd(
            "remote:app",
            "*",
            "data",
            JSON.stringify({
                kind: "rpc_request",
                sourceApp: "peer",
                event: "order.get",
                data: {},
                emittedAt: 1,
                correlationId: "cid-2",
                replyTo: "remote:evil",
                deadline: Date.now() + 5_000,
            })
        );
        await wait(80);
        expect(handlerCalls).toBe(0);
        expect(metrics.getSnapshot().security.replyToRejected).toBe(1);
        expect(await publisher.xlen("remote:evil")).toBe(0);

        await consumer.stop();
    });

    test("consumer concurrency stays at the configured cap", async () => {
        const server = new MockRedisStreamServer();
        const redis = new MockRedisClient(server) as unknown as Redis;
        const publisher = new MockRedisClient(server) as unknown as Redis;
        const consumer = new StreamConsumer(redis, publisher, {
            appName: "app",
            blockMs: 20,
            batchSize: 10,
            autoClaimIdleMs: 0,
            consumerConcurrency: 2,
        });
        await consumer.start();

        let inflight = 0;
        let maxInflight = 0;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        consumer.addHandler("ping", async () => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            await gate;
            inflight--;
        }, "h");

        for (let i = 0; i < 4; i++) {
            await publisher.xadd(
                "remote:app",
                "*",
                "data",
                JSON.stringify(envelope({ emittedAt: i }))
            );
        }

        await wait(100);
        expect(maxInflight).toBe(2);
        expect(inflight).toBe(2);

        release();
        await wait(50);
        await consumer.stop();
        expect(inflight).toBe(0);
    });
});
