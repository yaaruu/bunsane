/**
 * Remote Communication: Health check
 *
 * Aggregates health signals from Redis, the consumer group PEL, the outbox
 * table, the DLQ, and the circuit breaker. Exposed via `/health/remote`
 * and callable directly through `RemoteManager.health()`.
 */

import type Redis from "ioredis";
import type { SQL } from "bun";
import type { CircuitBreaker } from "./CircuitBreaker";

export interface RemoteHealthCheck {
    healthy: boolean;
    checks: {
        redis: { ok: boolean; latencyMs?: number; error?: string };
        consumer: {
            streamKey: string;
            pelCount?: number;
            error?: string;
        };
        dlq: { stream: string; length?: number; error?: string };
        outbox?: { pendingCount?: number; error?: string };
        circuitBreaker: {
            state: string;
            failures: number;
        };
    };
    timestamp: string;
}

export interface HealthInputs {
    publisher: Redis | null;
    consumerRedis: Redis | null;
    streamKey: string;
    consumerGroup: string;
    dlqStream: string;
    outboxEnabled: boolean;
    db: SQL;
    breaker: CircuitBreaker;
}

export async function collectRemoteHealth(
    inputs: HealthInputs
): Promise<RemoteHealthCheck> {
    const result: RemoteHealthCheck = {
        healthy: true,
        checks: {
            redis: { ok: false },
            consumer: { streamKey: inputs.streamKey },
            dlq: { stream: inputs.dlqStream },
            circuitBreaker: {
                state: inputs.breaker.getState(),
                failures: inputs.breaker.getStats().failures,
            },
        },
        timestamp: new Date().toISOString(),
    };

    // Redis ping via publisher connection
    if (inputs.publisher) {
        const start = Date.now();
        try {
            await inputs.publisher.ping();
            result.checks.redis = {
                ok: true,
                latencyMs: Date.now() - start,
            };
        } catch (error: any) {
            result.checks.redis = {
                ok: false,
                error: error?.message ?? String(error),
            };
            result.healthy = false;
        }
    } else {
        result.checks.redis = { ok: false, error: "publisher not started" };
        result.healthy = false;
    }

    // PEL count (pending entries in consumer group)
    if (inputs.publisher) {
        try {
            const pending: any = await inputs.publisher.xpending(
                inputs.streamKey,
                inputs.consumerGroup
            );
            // XPENDING summary: [total, smallest-id, largest-id, consumers]
            const count = Array.isArray(pending)
                ? (pending[0] as number) ?? 0
                : 0;
            result.checks.consumer.pelCount = count;
        } catch (error: any) {
            result.checks.consumer.error = error?.message ?? String(error);
        }
    }

    // DLQ length
    if (inputs.publisher) {
        try {
            const len = await inputs.publisher.xlen(inputs.dlqStream);
            result.checks.dlq.length = len ?? 0;
        } catch (error: any) {
            const msg = error?.message ?? String(error);
            // ERR no such key = stream hasn't been created yet, that's fine
            if (String(msg).toLowerCase().includes("no such key")) {
                result.checks.dlq.length = 0;
            } else {
                result.checks.dlq.error = msg;
            }
        }
    }

    // Outbox pending count
    if (inputs.outboxEnabled) {
        try {
            const db = inputs.db as any;
            const rows = await db`
                SELECT COUNT(*)::int AS pending
                FROM remote_outbox
                WHERE published_at IS NULL
            `;
            result.checks.outbox = {
                pendingCount: rows?.[0]?.pending ?? 0,
            };
        } catch (error: any) {
            result.checks.outbox = {
                error: error?.message ?? String(error),
            };
        }
    }

    // Circuit breaker open -> degrade health
    if (result.checks.circuitBreaker.state === "open") {
        result.healthy = false;
    }

    return result;
}
