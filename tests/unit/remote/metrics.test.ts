import { describe, test, expect, beforeEach } from "bun:test";
import { RemoteMetrics } from "../../../core/remote/metrics";

describe("RemoteMetrics", () => {
    let m: RemoteMetrics;
    beforeEach(() => {
        m = new RemoteMetrics();
    });

    test("fresh snapshot is all zeros", () => {
        const snap = m.getSnapshot();
        expect(snap.emit).toEqual({ direct: 0, outbox: 0, failed: 0 });
        expect(snap.events).toEqual({
            received: 0,
            handled: 0,
            handlerFailed: 0,
            noHandler: 0,
            dlq: 0,
        });
        expect(snap.rpc).toEqual({
            called: 0,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            handlerExecuted: 0,
            handlerFailed: 0,
            pastDeadline: 0,
        });
        expect(snap.outbox).toEqual({ claimed: 0, published: 0, publishFailed: 0 });
        expect(snap.circuitBreaker).toEqual({ trips: 0, rejected: 0 });
    });

    test("emit counters", () => {
        m.emitDirect();
        m.emitDirect();
        m.emitOutbox();
        m.emitFailed();
        const s = m.getSnapshot();
        expect(s.emit.direct).toBe(2);
        expect(s.emit.outbox).toBe(1);
        expect(s.emit.failed).toBe(1);
    });

    test("event counters", () => {
        m.eventReceived();
        m.eventHandled();
        m.eventHandlerFailed();
        m.eventNoHandler();
        m.eventDlq();
        const s = m.getSnapshot();
        expect(s.events).toEqual({
            received: 1,
            handled: 1,
            handlerFailed: 1,
            noHandler: 1,
            dlq: 1,
        });
    });

    test("rpc counters", () => {
        m.rpcCalled();
        m.rpcSucceeded();
        m.rpcFailed();
        m.rpcTimedOut();
        m.rpcHandlerExecuted();
        m.rpcHandlerFailed();
        m.rpcPastDeadline();
        const s = m.getSnapshot();
        expect(s.rpc.called).toBe(1);
        expect(s.rpc.succeeded).toBe(1);
        expect(s.rpc.failed).toBe(1);
        expect(s.rpc.timedOut).toBe(1);
        expect(s.rpc.handlerExecuted).toBe(1);
        expect(s.rpc.handlerFailed).toBe(1);
        expect(s.rpc.pastDeadline).toBe(1);
    });

    test("outbox claimed is summable, not +1", () => {
        m.outboxClaimed(5);
        m.outboxClaimed(3);
        m.outboxPublished(4);
        m.outboxPublishFailed();
        const s = m.getSnapshot();
        expect(s.outbox.claimed).toBe(8);
        expect(s.outbox.published).toBe(4);
        expect(s.outbox.publishFailed).toBe(1);
    });

    test("circuit breaker counters", () => {
        m.cbTripped();
        m.cbRejected();
        m.cbRejected();
        const s = m.getSnapshot();
        expect(s.circuitBreaker).toEqual({ trips: 1, rejected: 2 });
    });

    test("snapshot is a deep copy", () => {
        m.emitDirect();
        const s1 = m.getSnapshot();
        s1.emit.direct = 9999;
        const s2 = m.getSnapshot();
        expect(s2.emit.direct).toBe(1);
    });

    test("reset zeroes all counters", () => {
        m.emitDirect();
        m.rpcFailed();
        m.eventDlq();
        m.reset();
        const s = m.getSnapshot();
        expect(s.emit.direct).toBe(0);
        expect(s.rpc.failed).toBe(0);
        expect(s.events.dlq).toBe(0);
    });
});
