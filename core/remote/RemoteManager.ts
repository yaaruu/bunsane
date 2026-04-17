/**
 * Remote Communication: RemoteManager
 *
 * Phase 1: events + RPC over Redis Streams.
 * - emit(target, event, data): fire-and-forget XADD to `remote:<target>`
 * - call(target, method, data, options): RPC with correlationId + deadline
 * - Dedicated Redis connections:
 *     publisher   — XADD only (non-blocking, retries enabled)
 *     consumer    — XREADGROUP BLOCK (retries=null, required for blocking)
 *     rpcListener — XREAD BLOCK on per-instance response stream
 * - Graceful shutdown drains pending RPC calls within `shutdownDrainMs`
 */

import Redis, { type RedisOptions } from "ioredis";
import { logger } from "../Logger";
import { StreamConsumer } from "./StreamConsumer";
import { RpcCaller } from "./RpcCaller";
import { OutboxWorker } from "./OutboxWorker";
import { ensureOutboxSchema } from "./outboxSchema";
import { CircuitBreaker } from "./CircuitBreaker";
import { RemoteMetrics, type RemoteMetricsSnapshot } from "./metrics";
import { collectRemoteHealth, type RemoteHealthCheck } from "./health";
import db from "../../database";
import type {
    CallOptions,
    EmitOptions,
    RemoteHandler,
    RemoteManagerConfig,
    RpcHandler,
} from "./types";

const loggerInstance = logger.child({ scope: "RemoteManager" });

function buildRedisOptions(blocking: boolean): RedisOptions {
    return {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379", 10),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || "0", 10),
        maxRetriesPerRequest: blocking ? null : 3,
        enableReadyCheck: false,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
    };
}

export class RemoteManager {
    private publisher: Redis | null = null;
    private consumerRedis: Redis | null = null;
    private rpcListenerRedis: Redis | null = null;
    private consumer: StreamConsumer | null = null;
    private caller: RpcCaller | null = null;
    private outboxWorker: OutboxWorker | null = null;
    private breaker: CircuitBreaker;
    private metrics = new RemoteMetrics();
    private config: RemoteManagerConfig;
    private _instanceId: string;
    private started = false;

    constructor(config: RemoteManagerConfig) {
        this.config = config;
        this._instanceId = crypto.randomUUID();
        this.breaker = new CircuitBreaker({
            threshold: config.circuitBreakerThreshold,
            resetTimeoutMs: config.circuitBreakerResetMs,
        });
        this.breaker.onTrip = () => this.metrics.cbTripped();
        this.breaker.onReject = () => this.metrics.cbRejected();
    }

    getMetrics(): RemoteMetricsSnapshot & {
        circuitBreaker: RemoteMetricsSnapshot["circuitBreaker"] & {
            state: string;
        };
    } {
        const snap = this.metrics.getSnapshot();
        return {
            ...snap,
            circuitBreaker: {
                ...snap.circuitBreaker,
                state: this.breaker.getState(),
            },
        };
    }

    getCircuitBreaker(): CircuitBreaker {
        return this.breaker;
    }

    async health(): Promise<RemoteHealthCheck> {
        return collectRemoteHealth({
            publisher: this.publisher,
            consumerRedis: this.consumerRedis,
            streamKey: `${this.streamPrefix}${this.config.appName}`,
            consumerGroup:
                this.config.consumerGroup ?? this.config.appName,
            dlqStream: `${this.streamPrefix}${this.config.appName}:dlq`,
            outboxEnabled: this.config.enableOutbox ?? false,
            db,
            breaker: this.breaker,
        });
    }

    get appName(): string {
        return this.config.appName;
    }

    get instanceId(): string {
        return this._instanceId;
    }

    get streamPrefix(): string {
        return this.config.streamPrefix ?? "remote:";
    }

    get responseStream(): string {
        return `rpc:responses:${this._instanceId}`;
    }

    /**
     * Emit an event.
     *
     * Without `{ trx }`: direct XADD to Redis (fire-and-forget, no DB write).
     * With `{ trx }`: insert a row into `remote_outbox` within the caller's
     * transaction. The OutboxWorker publishes the row to Redis after commit.
     *
     * Returns the Redis message id (direct path) or the outbox row id
     * (transactional path).
     */
    async emit(
        target: string,
        event: string,
        data: unknown,
        options: EmitOptions = {}
    ): Promise<string | null> {
        if (!this.publisher) {
            throw new Error(
                "RemoteManager not started — call start() before emit()"
            );
        }

        if (options.trx) {
            const trx = options.trx as any;
            const rows = await trx`
                INSERT INTO remote_outbox (target, event, data)
                VALUES (${target}, ${event}, ${data})
                RETURNING id
            `;
            const id = rows?.[0]?.id ?? null;
            this.metrics.emitOutbox();
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `emit outbox → target=${target} event=${event} id=${id}`
                );
            }
            return id;
        }

        const stream = `${this.streamPrefix}${target}`;
        const envelope = JSON.stringify({
            kind: "event",
            sourceApp: this.config.appName,
            event,
            data,
            emittedAt: Date.now(),
        });
        try {
            const publisher = this.publisher;
            const id = await this.breaker.exec(() =>
                publisher.xadd(stream, "*", "data", envelope)
            );
            this.metrics.emitDirect();
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `emit → ${stream} event=${event} id=${id}`
                );
            }
            return id;
        } catch (error) {
            this.metrics.emitFailed();
            throw error;
        }
    }

    /**
     * RPC call — awaits a response or rejects on timeout/error.
     * Throws `RemoteError { code: "INVALID_TARGET" }` for broadcast target "*".
     */
    async call<T = unknown>(
        target: string,
        method: string,
        data: unknown,
        options: CallOptions = {}
    ): Promise<T> {
        if (!this.caller) {
            throw new Error(
                "RemoteManager not started — call start() before call()"
            );
        }
        return this.caller.call<T>(
            target,
            method,
            data,
            this.streamPrefix,
            this.config.appName,
            options
        );
    }

    on(event: string, fn: RemoteHandler, handlerId: string): void {
        if (!this.consumer) {
            throw new Error(
                "RemoteManager consumer not initialized — call start() first"
            );
        }
        this.consumer.addHandler(event, fn, handlerId);
    }

    onRpc(event: string, fn: RpcHandler, handlerId: string): void {
        if (!this.consumer) {
            throw new Error(
                "RemoteManager consumer not initialized — call start() first"
            );
        }
        this.consumer.addRpcHandler(event, fn, handlerId);
    }

    async start(): Promise<void> {
        if (this.started) return;

        const factory =
            this.config.redisFactory ??
            ((blocking: boolean) => new Redis(buildRedisOptions(blocking)));

        this.publisher = factory(false) as Redis;
        this.consumerRedis = factory(true) as Redis;
        this.rpcListenerRedis = factory(true) as Redis;

        for (const [name, client] of [
            ["publisher", this.publisher],
            ["consumer", this.consumerRedis],
            ["rpcListener", this.rpcListenerRedis],
        ] as const) {
            client.on("error", (err) => {
                loggerInstance.warn(
                    { err, name, msg: `${name} Redis error` }
                );
            });
        }

        this.consumer = new StreamConsumer(
            this.consumerRedis,
            this.publisher,
            this.config,
            this.metrics
        );
        await this.consumer.start();

        this.caller = new RpcCaller(
            this.rpcListenerRedis,
            this.publisher,
            {
                instanceId: this._instanceId,
                responseStream: this.responseStream,
                defaultTimeout: this.config.defaultCallTimeout ?? 5000,
                responseStreamMaxLen:
                    this.config.responseStreamMaxLen ?? 1000,
                enableLogging: this.config.enableLogging ?? false,
            },
            this.breaker,
            this.metrics
        );
        await this.caller.start();

        if (this.config.enableOutbox) {
            try {
                await ensureOutboxSchema(db);
                this.outboxWorker = new OutboxWorker(
                    db,
                    this.publisher,
                    {
                        sourceApp: this.config.appName,
                        streamPrefix: this.streamPrefix,
                        pollIntervalMs:
                            this.config.outboxPollIntervalMs ?? 1000,
                        batchSize: this.config.outboxBatchSize ?? 100,
                        enableLogging: this.config.enableLogging ?? false,
                    },
                    this.metrics
                );
                await this.outboxWorker.start();
            } catch (error) {
                loggerInstance.error(
                    { err: error, msg: "Failed to start OutboxWorker" }
                );
                this.outboxWorker = null;
            }
        }

        this.started = true;
        loggerInstance.info(
            `RemoteManager started app="${this.config.appName}" instance=${this._instanceId} outbox=${this.config.enableOutbox ?? false}`
        );
    }

    async shutdown(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        // 1. Stop outbox worker first — best-effort flush so committed rows
        //    emitted right before shutdown still reach Redis.
        if (this.outboxWorker) {
            try {
                await this.outboxWorker.flush();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "OutboxWorker flush error" }
                );
            }
            try {
                await this.outboxWorker.stop();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "OutboxWorker stop error" }
                );
            }
            this.outboxWorker = null;
        }

        // 2. Drain pending RPC calls first (caller rejects new)
        const drainMs = this.config.shutdownDrainMs ?? 2000;
        if (this.caller) {
            try {
                await this.caller.stop(drainMs);
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "RpcCaller stop error" }
                );
            }
            this.caller = null;
        }

        // 3. Stop consumer — waits for in-flight handler
        if (this.consumer) {
            try {
                await this.consumer.stop();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "Consumer stop error" }
                );
            }
            this.consumer = null;
        }

        // 4. Disconnect Redis conns
        if (this.rpcListenerRedis) {
            try {
                this.rpcListenerRedis.disconnect();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "RPC listener disconnect error" }
                );
            }
            this.rpcListenerRedis = null;
        }

        if (this.consumerRedis) {
            try {
                this.consumerRedis.disconnect();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "Consumer Redis disconnect error" }
                );
            }
            this.consumerRedis = null;
        }

        if (this.publisher) {
            try {
                await this.publisher.quit();
            } catch (error) {
                loggerInstance.warn(
                    { err: error, msg: "Publisher quit error" }
                );
            }
            this.publisher = null;
        }

        loggerInstance.info("RemoteManager shutdown completed");
    }
}

let remoteManagerInstance: RemoteManager | null = null;

export function getRemoteManager(): RemoteManager | null {
    return remoteManagerInstance;
}

export function setRemoteManager(instance: RemoteManager | null): void {
    remoteManagerInstance = instance;
}
