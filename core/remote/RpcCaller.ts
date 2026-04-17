/**
 * Remote Communication: RpcCaller
 *
 * Phase 1: Request/response over Redis Streams.
 * - Per-instance response stream `rpc:responses:<instanceId>` — no consumer group
 * - Dedicated blocking Redis connection for XREAD $
 * - Pending map keyed by correlationId, timer per call
 * - Response writes capped via MAXLEN ~ to prevent unbounded growth
 */

import Redis from "ioredis";
import { logger } from "../Logger";
import { RemoteError } from "./types";
import type {
    CallOptions,
    RpcResponse,
} from "./types";
import type { CircuitBreaker } from "./CircuitBreaker";
import type { RemoteMetrics } from "./metrics";

const loggerInstance = logger.child({ scope: "RpcCaller" });

interface PendingEntry {
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    target: string;
}

export interface RpcCallerConfig {
    instanceId: string;
    responseStream: string;
    defaultTimeout: number;
    responseStreamMaxLen: number;
    enableLogging: boolean;
}

export class RpcCaller {
    private listenerRedis: Redis;
    private publisher: Redis;
    private config: RpcCallerConfig;
    private pending = new Map<string, PendingEntry>();
    private running = false;
    private draining = false;
    private loopPromise: Promise<void> | null = null;
    private lastId = "$";
    private breaker?: CircuitBreaker;
    private metrics?: RemoteMetrics;

    constructor(
        listenerRedis: Redis,
        publisher: Redis,
        config: RpcCallerConfig,
        breaker?: CircuitBreaker,
        metrics?: RemoteMetrics
    ) {
        this.listenerRedis = listenerRedis;
        this.publisher = publisher;
        this.config = config;
        this.breaker = breaker;
        this.metrics = metrics;
    }

    get responseStream(): string {
        return this.config.responseStream;
    }

    get instanceId(): string {
        return this.config.instanceId;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.loopPromise = this.listenLoop();
        loggerInstance.info(
            `RpcCaller started: responseStream=${this.config.responseStream}`
        );
    }

    /**
     * Stop accepting new calls and drain pending within `drainMs`.
     * Pending calls remaining after drain are rejected with code="SHUTDOWN".
     */
    async stop(drainMs: number): Promise<void> {
        if (!this.running) return;
        this.draining = true;

        // Wait for pending to settle — bounded by drainMs
        const deadline = Date.now() + drainMs;
        while (this.pending.size > 0 && Date.now() < deadline) {
            await this.sleep(50);
        }

        // Force-reject remaining
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(
                new RemoteError(
                    `RPC ${entry.method} cancelled by shutdown`,
                    { code: "SHUTDOWN", sourceApp: entry.target }
                )
            );
            this.pending.delete(id);
        }

        this.running = false;
        if (this.loopPromise) {
            await this.loopPromise.catch(() => {});
            this.loopPromise = null;
        }
        loggerInstance.info("RpcCaller stopped");
    }

    async call<T = unknown>(
        target: string,
        method: string,
        data: unknown,
        requestStreamPrefix: string,
        sourceApp: string,
        options: CallOptions = {}
    ): Promise<T> {
        if (target === "*") {
            throw new RemoteError(
                "call() does not support broadcast target '*' — use emit() for fan-out",
                { code: "INVALID_TARGET" }
            );
        }
        if (this.draining || !this.running) {
            throw new RemoteError(
                `RPC ${method} rejected — RemoteManager draining/stopped`,
                { code: "SHUTDOWN" }
            );
        }

        this.metrics?.rpcCalled();

        const timeout = options.timeout ?? this.config.defaultTimeout;
        const correlationId = crypto.randomUUID();
        const deadline = Date.now() + timeout;
        const requestStream = `${requestStreamPrefix}${target}`;

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(correlationId)) {
                    this.metrics?.rpcTimedOut();
                    reject(
                        new RemoteError(
                            `RPC ${method} to "${target}" timed out after ${timeout}ms`,
                            { code: "TIMEOUT", sourceApp: target }
                        )
                    );
                }
            }, timeout);

            this.pending.set(correlationId, {
                resolve: (v) => {
                    this.metrics?.rpcSucceeded();
                    (resolve as (x: unknown) => void)(v);
                },
                reject: (err) => {
                    this.metrics?.rpcFailed();
                    reject(err);
                },
                timer,
                method,
                target,
            });

            const envelope = JSON.stringify({
                kind: "rpc_request",
                sourceApp,
                event: method,
                data,
                emittedAt: Date.now(),
                correlationId,
                replyTo: this.config.responseStream,
                deadline,
            });

            const publish = this.breaker
                ? this.breaker.exec(() =>
                      this.publisher.xadd(requestStream, "*", "data", envelope)
                  )
                : this.publisher.xadd(
                      requestStream,
                      "*",
                      "data",
                      envelope
                  );

            Promise.resolve(publish)
                .then((id) => {
                    if (this.config.enableLogging) {
                        loggerInstance.debug(
                            `call → ${requestStream} method=${method} id=${id} cid=${correlationId}`
                        );
                    }
                })
                .catch((err) => {
                    if (this.pending.delete(correlationId)) {
                        clearTimeout(timer);
                        const code =
                            (err && (err as any).code) === "CIRCUIT_OPEN"
                                ? "CIRCUIT_OPEN"
                                : "PUBLISH_FAILED";
                        reject(
                            new RemoteError(
                                `Failed to publish RPC request: ${err?.message ?? err}`,
                                { code, sourceApp: target }
                            )
                        );
                    }
                });
        });
    }

    private async listenLoop(): Promise<void> {
        while (this.running) {
            try {
                const result: any = await (this.listenerRedis as any).xread(
                    "COUNT",
                    50,
                    "BLOCK",
                    2000,
                    "STREAMS",
                    this.config.responseStream,
                    this.lastId
                );

                if (!result || !this.running) continue;

                for (const [, entries] of result) {
                    for (const [msgId, fields] of entries) {
                        this.lastId = msgId;
                        const response = this.parseResponse(fields);
                        if (response) {
                            this.dispatchResponse(response);
                        }
                    }
                }
            } catch (error: any) {
                if (!this.running) break;
                if (String(error?.message).includes("Connection is closed")) {
                    break;
                }
                loggerInstance.error(
                    { err: error, msg: "Response listen error" }
                );
                await this.sleep(500);
            }
        }
    }

    private dispatchResponse(response: RpcResponse): void {
        const entry = this.pending.get(response.correlationId);
        if (!entry) {
            // Orphan response — caller already timed out or never existed
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Orphan response cid=${response.correlationId}`
                );
            }
            return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(response.correlationId);

        if (response.success) {
            entry.resolve(response.result);
        } else {
            entry.reject(
                new RemoteError(response.error.message, {
                    code: response.error.code,
                    sourceApp: response.sourceApp,
                    extensions: response.error.extensions,
                })
            );
        }
    }

    private parseResponse(fields: string[]): RpcResponse | null {
        let payload: string | undefined;
        for (let i = 0; i < fields.length - 1; i += 2) {
            if (fields[i] === "data") {
                payload = fields[i + 1];
                break;
            }
        }
        if (!payload) return null;
        try {
            const parsed = JSON.parse(payload);
            if (
                !parsed ||
                typeof parsed.correlationId !== "string" ||
                typeof parsed.success !== "boolean"
            ) {
                return null;
            }
            return parsed as RpcResponse;
        } catch {
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}
