/**
 * Remote Communication: Metrics
 *
 * In-memory counters for the remote subsystem. Exposed via
 * `RemoteManager.getMetrics()` and the `/metrics` HTTP endpoint.
 */

export interface RemoteMetricsSnapshot {
    emit: {
        direct: number;
        outbox: number;
        failed: number;
    };
    events: {
        received: number;
        handled: number;
        handlerFailed: number;
        noHandler: number;
        dlq: number;
    };
    rpc: {
        called: number;
        succeeded: number;
        failed: number;
        timedOut: number;
        handlerExecuted: number;
        handlerFailed: number;
        pastDeadline: number;
    };
    outbox: {
        claimed: number;
        published: number;
        publishFailed: number;
    };
    circuitBreaker: {
        trips: number;
        rejected: number;
    };
}

function emptySnapshot(): RemoteMetricsSnapshot {
    return {
        emit: { direct: 0, outbox: 0, failed: 0 },
        events: { received: 0, handled: 0, handlerFailed: 0, noHandler: 0, dlq: 0 },
        rpc: {
            called: 0,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            handlerExecuted: 0,
            handlerFailed: 0,
            pastDeadline: 0,
        },
        outbox: { claimed: 0, published: 0, publishFailed: 0 },
        circuitBreaker: { trips: 0, rejected: 0 },
    };
}

export class RemoteMetrics {
    private snapshot: RemoteMetricsSnapshot = emptySnapshot();

    // Emit
    emitDirect(): void { this.snapshot.emit.direct++; }
    emitOutbox(): void { this.snapshot.emit.outbox++; }
    emitFailed(): void { this.snapshot.emit.failed++; }

    // Events
    eventReceived(): void { this.snapshot.events.received++; }
    eventHandled(): void { this.snapshot.events.handled++; }
    eventHandlerFailed(): void { this.snapshot.events.handlerFailed++; }
    eventNoHandler(): void { this.snapshot.events.noHandler++; }
    eventDlq(): void { this.snapshot.events.dlq++; }

    // RPC
    rpcCalled(): void { this.snapshot.rpc.called++; }
    rpcSucceeded(): void { this.snapshot.rpc.succeeded++; }
    rpcFailed(): void { this.snapshot.rpc.failed++; }
    rpcTimedOut(): void { this.snapshot.rpc.timedOut++; }
    rpcHandlerExecuted(): void { this.snapshot.rpc.handlerExecuted++; }
    rpcHandlerFailed(): void { this.snapshot.rpc.handlerFailed++; }
    rpcPastDeadline(): void { this.snapshot.rpc.pastDeadline++; }

    // Outbox
    outboxClaimed(n: number): void { this.snapshot.outbox.claimed += n; }
    outboxPublished(n: number): void { this.snapshot.outbox.published += n; }
    outboxPublishFailed(): void { this.snapshot.outbox.publishFailed++; }

    // Circuit Breaker
    cbTripped(): void { this.snapshot.circuitBreaker.trips++; }
    cbRejected(): void { this.snapshot.circuitBreaker.rejected++; }

    getSnapshot(): RemoteMetricsSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot));
    }

    reset(): void {
        this.snapshot = emptySnapshot();
    }
}
