/**
 * Remote Communication: StreamConsumer
 *
 * Blocking XREADGROUP loop on a dedicated Redis connection.
 * - Consumer group auto-created on start (MKSTREAM, BUSYGROUP-safe)
 * - BLOCK 2000 so `running` flag is polled at most every 2s
 * - XACK on success; failures skip ACK to allow PEL redelivery
 * - XAUTOCLAIM on startup reclaims PEL entries idle > autoClaimIdleMs
 * - RPC dispatch via `kind: "rpc_request"` envelope — sends response to `replyTo`
 */

import Redis from "ioredis";
import { logger } from "../Logger";
import type {
    RemoteContext,
    RemoteEnvelope,
    RemoteHandler,
    RemoteManagerConfig,
    RpcHandler,
    RpcResponse,
} from "./types";
import type { RemoteMetrics } from "./metrics";

const loggerInstance = logger.child({ scope: "StreamConsumer" });

type InternalEventHandler = { id: string; fn: RemoteHandler };
type InternalRpcHandler = { id: string; fn: RpcHandler };

export class StreamConsumer {
    private redis: Redis;
    private publisher: Redis;
    private config: Required<
        Pick<
            RemoteManagerConfig,
            | "appName"
            | "batchSize"
            | "blockMs"
            | "streamPrefix"
            | "consumerGroup"
            | "consumerId"
            | "enableLogging"
            | "autoClaimIdleMs"
            | "responseStreamMaxLen"
            | "dlqMaxDeliveries"
        >
    >;
    private eventHandlers = new Map<string, InternalEventHandler[]>();
    private rpcHandlers = new Map<string, InternalRpcHandler>();
    private running = false;
    private loopPromise: Promise<void> | null = null;
    private currentHandlerPromise: Promise<void> | null = null;
    private metrics?: RemoteMetrics;

    constructor(
        redis: Redis,
        publisher: Redis,
        config: RemoteManagerConfig,
        metrics?: RemoteMetrics
    ) {
        this.redis = redis;
        this.publisher = publisher;
        this.metrics = metrics;
        this.config = {
            appName: config.appName,
            batchSize: config.batchSize ?? 10,
            blockMs: config.blockMs ?? 2000,
            streamPrefix: config.streamPrefix ?? "remote:",
            consumerGroup: config.consumerGroup ?? config.appName,
            consumerId:
                config.consumerId ?? `consumer-${process.pid}-${Date.now()}`,
            enableLogging: config.enableLogging ?? false,
            autoClaimIdleMs: config.autoClaimIdleMs ?? 60_000,
            responseStreamMaxLen: config.responseStreamMaxLen ?? 1000,
            dlqMaxDeliveries: config.dlqMaxDeliveries ?? 3,
        };
    }

    get dlqStream(): string {
        return `${this.streamKey}:dlq`;
    }

    get streamKey(): string {
        return `${this.config.streamPrefix}${this.config.appName}`;
    }

    addHandler(event: string, fn: RemoteHandler, handlerId: string): void {
        const existing = this.eventHandlers.get(event) ?? [];
        if (existing.some((h) => h.id === handlerId)) return;
        existing.push({ id: handlerId, fn });
        this.eventHandlers.set(event, existing);
    }

    addRpcHandler(event: string, fn: RpcHandler, handlerId: string): void {
        const existing = this.rpcHandlers.get(event);
        if (existing) {
            if (existing.id !== handlerId) {
                loggerInstance.warn(
                    `RPC handler for "${event}" already bound to ${existing.id}; overwriting with ${handlerId}`
                );
            }
        }
        this.rpcHandlers.set(event, { id: handlerId, fn });
    }

    async start(): Promise<void> {
        if (this.running) return;

        try {
            await this.redis.xgroup(
                "CREATE",
                this.streamKey,
                this.config.consumerGroup,
                "$",
                "MKSTREAM"
            );
            loggerInstance.info(
                `Created consumer group ${this.config.consumerGroup} on ${this.streamKey}`
            );
        } catch (error: any) {
            if (!String(error?.message).includes("BUSYGROUP")) {
                throw error;
            }
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `Consumer group ${this.config.consumerGroup} already exists`
                );
            }
        }

        if (this.config.autoClaimIdleMs > 0) {
            await this.reclaimOrphaned();
        }

        this.running = true;
        this.loopPromise = this.consumeLoop();
        loggerInstance.info(
            `Stream consumer started: stream=${this.streamKey} group=${this.config.consumerGroup} consumer=${this.config.consumerId}`
        );
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.loopPromise) {
            await this.loopPromise.catch(() => {});
            this.loopPromise = null;
        }
        if (this.currentHandlerPromise) {
            await this.currentHandlerPromise.catch(() => {});
        }
        loggerInstance.info("Stream consumer stopped");
    }

    /**
     * XAUTOCLAIM orphaned PEL entries — any consumer in the group idle
     * beyond autoClaimIdleMs has its pending messages reassigned to us.
     */
    private async reclaimOrphaned(): Promise<void> {
        let cursor = "0-0";
        let totalClaimed = 0;
        try {
            while (true) {
                const result: any = await (this.redis as any).xautoclaim(
                    this.streamKey,
                    this.config.consumerGroup,
                    this.config.consumerId,
                    this.config.autoClaimIdleMs,
                    cursor,
                    "COUNT",
                    this.config.batchSize
                );
                if (!result) break;
                const [nextCursor, entries] = result;
                if (Array.isArray(entries)) {
                    for (const [msgId, fields] of entries) {
                        await this.processMessage(msgId, fields, true);
                        totalClaimed++;
                    }
                }
                if (!nextCursor || nextCursor === "0-0") break;
                cursor = nextCursor;
            }
            if (totalClaimed > 0) {
                loggerInstance.info(
                    `XAUTOCLAIM recovered ${totalClaimed} orphaned messages`
                );
            }
        } catch (error: any) {
            // XAUTOCLAIM requires Redis 6.2+. Log and continue.
            loggerInstance.warn(
                { err: error, msg: "XAUTOCLAIM failed — Redis < 6.2?" }
            );
        }
    }

    private async consumeLoop(): Promise<void> {
        while (this.running) {
            try {
                const result: any = await (this.redis as any).xreadgroup(
                    "GROUP",
                    this.config.consumerGroup,
                    this.config.consumerId,
                    "COUNT",
                    this.config.batchSize,
                    "BLOCK",
                    this.config.blockMs,
                    "STREAMS",
                    this.streamKey,
                    ">"
                );

                if (!result || !this.running) continue;

                for (const [, entries] of result) {
                    for (const [msgId, fields] of entries) {
                        if (!this.running) break;
                        this.currentHandlerPromise = this.processMessage(
                            msgId,
                            fields,
                            false
                        );
                        await this.currentHandlerPromise;
                        this.currentHandlerPromise = null;
                    }
                }
            } catch (error: any) {
                if (!this.running) break;
                if (String(error?.message).includes("Connection is closed")) {
                    break;
                }
                loggerInstance.error(
                    { err: error, msg: "Stream consume error" }
                );
                await this.sleep(1000);
            }
        }
    }

    private async processMessage(
        msgId: string,
        fields: string[],
        reclaimed: boolean
    ): Promise<void> {
        const envelope = this.parseEnvelope(fields);
        if (!envelope) {
            await this.ack(msgId);
            loggerInstance.warn(`Malformed envelope at ${msgId}, ACK'd`);
            return;
        }

        // DLQ check: if this message has been redelivered too many times,
        // move it to the DLQ and ACK the original so the consumer group can
        // progress past it. Disabled when dlqMaxDeliveries is 0.
        if (this.config.dlqMaxDeliveries > 0) {
            const deliveryCount = await this.getDeliveryCount(msgId);
            if (deliveryCount >= this.config.dlqMaxDeliveries) {
                await this.sendToDlq(msgId, fields, deliveryCount);
                await this.ack(msgId);
                this.metrics?.eventDlq();
                loggerInstance.warn(
                    {
                        msgId,
                        deliveryCount,
                        event: envelope.event,
                        msg: "Message routed to DLQ — max deliveries exceeded",
                    }
                );
                return;
            }
        }

        const kind = envelope.kind ?? "event";
        if (kind === "rpc_request") {
            await this.handleRpcRequest(msgId, envelope, reclaimed);
        } else {
            await this.handleEvent(msgId, envelope, reclaimed);
        }
    }

    /**
     * Query PEL for this message id; returns the delivery count, or 1 if
     * the message isn't in PEL (first delivery before ACK).
     */
    private async getDeliveryCount(msgId: string): Promise<number> {
        try {
            const result: any = await (this.redis as any).xpending(
                this.streamKey,
                this.config.consumerGroup,
                msgId,
                msgId,
                1
            );
            // XPENDING with id range returns: [[msgId, consumer, idleMs, deliveryCount], ...]
            const entry = Array.isArray(result) ? result[0] : null;
            if (!entry || !Array.isArray(entry)) return 1;
            const count = entry[3];
            return typeof count === "number" ? count : parseInt(count ?? "1", 10);
        } catch (error) {
            // On error, fall through to process normally — avoid false DLQ routing.
            return 1;
        }
    }

    private async sendToDlq(
        msgId: string,
        fields: string[],
        deliveryCount: number
    ): Promise<void> {
        // Forward original envelope + metadata to DLQ stream.
        const flatFields: string[] = [];
        flatFields.push("original_id", msgId);
        flatFields.push("delivery_count", String(deliveryCount));
        flatFields.push("moved_at", String(Date.now()));
        for (let i = 0; i < fields.length; i++) {
            flatFields.push(fields[i]!);
        }
        try {
            await (this.publisher as any).xadd(
                this.dlqStream,
                "MAXLEN",
                "~",
                10_000,
                "*",
                ...flatFields
            );
        } catch (error: any) {
            loggerInstance.error(
                {
                    err: error,
                    dlqStream: this.dlqStream,
                    originalId: msgId,
                    msg: "Failed to write to DLQ",
                }
            );
        }
    }

    private async handleEvent(
        msgId: string,
        envelope: RemoteEnvelope,
        reclaimed: boolean
    ): Promise<void> {
        this.metrics?.eventReceived();
        const handlers = this.eventHandlers.get(envelope.event) ?? [];
        if (handlers.length === 0) {
            await this.ack(msgId);
            this.metrics?.eventNoHandler();
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `No handler for event "${envelope.event}", ACK'd ${msgId}`
                );
            }
            return;
        }

        const ctx: RemoteContext = {
            sourceApp: envelope.sourceApp,
            messageId: msgId,
            timestamp: new Date(envelope.emittedAt),
            attempt: reclaimed ? 2 : 1,
        };

        let allOk = true;
        for (const h of handlers) {
            try {
                await h.fn(envelope.data, ctx);
            } catch (error: any) {
                allOk = false;
                this.metrics?.eventHandlerFailed();
                loggerInstance.error(
                    {
                        err: error,
                        event: envelope.event,
                        handlerId: h.id,
                        msgId,
                        msg: "Remote handler failed",
                    }
                );
            }
        }

        if (allOk) {
            this.metrics?.eventHandled();
            await this.ack(msgId);
        }
    }

    private async handleRpcRequest(
        msgId: string,
        envelope: RemoteEnvelope,
        reclaimed: boolean
    ): Promise<void> {
        const { correlationId, replyTo, deadline, event } = envelope;
        if (!correlationId || !replyTo) {
            await this.ack(msgId);
            loggerInstance.warn(
                `RPC request missing correlationId/replyTo at ${msgId}, ACK'd`
            );
            return;
        }

        // Deadline check — caller may already have timed out
        if (typeof deadline === "number" && Date.now() > deadline) {
            await this.ack(msgId);
            this.metrics?.rpcPastDeadline();
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    `RPC ${event} past deadline, skipping (cid=${correlationId})`
                );
            }
            return;
        }

        const handler = this.rpcHandlers.get(event);
        if (!handler) {
            await this.sendRpcResponse(replyTo, {
                correlationId,
                sourceApp: this.config.appName,
                success: false,
                error: {
                    code: "NOT_FOUND",
                    message: `No RPC handler for "${event}" on ${this.config.appName}`,
                },
                respondedAt: Date.now(),
            });
            await this.ack(msgId);
            return;
        }

        const ctx: RemoteContext = {
            sourceApp: envelope.sourceApp,
            messageId: msgId,
            timestamp: new Date(envelope.emittedAt),
            attempt: reclaimed ? 2 : 1,
            correlationId,
            deadline: typeof deadline === "number" ? new Date(deadline) : undefined,
        };

        try {
            const result = await handler.fn(envelope.data, ctx);
            await this.sendRpcResponse(replyTo, {
                correlationId,
                sourceApp: this.config.appName,
                success: true,
                result,
                respondedAt: Date.now(),
            });
            await this.ack(msgId);
            this.metrics?.rpcHandlerExecuted();
        } catch (error: any) {
            const code = error?.code ?? "HANDLER_ERROR";
            const message = error?.message ?? String(error);
            const extensions = error?.extensions;
            await this.sendRpcResponse(replyTo, {
                correlationId,
                sourceApp: this.config.appName,
                success: false,
                error: { code, message, extensions },
                respondedAt: Date.now(),
            });
            await this.ack(msgId);
            this.metrics?.rpcHandlerFailed();
            loggerInstance.error(
                {
                    err: error,
                    event,
                    msgId,
                    msg: "RPC handler failed",
                }
            );
        }
    }

    private async sendRpcResponse(
        replyTo: string,
        response: RpcResponse
    ): Promise<void> {
        try {
            await this.publisher.xadd(
                replyTo,
                "MAXLEN",
                "~",
                this.config.responseStreamMaxLen,
                "*",
                "data",
                JSON.stringify(response)
            );
        } catch (error: any) {
            loggerInstance.error(
                {
                    err: error,
                    replyTo,
                    correlationId: response.correlationId,
                    msg: "Failed to send RPC response",
                }
            );
        }
    }

    private async ack(msgId: string): Promise<void> {
        try {
            await this.redis.xack(
                this.streamKey,
                this.config.consumerGroup,
                msgId
            );
        } catch (error: any) {
            loggerInstance.warn(
                { err: error, msgId, msg: "XACK failed" }
            );
        }
    }

    private parseEnvelope(fields: string[]): RemoteEnvelope | null {
        let payload: string | undefined;
        for (let i = 0; i < fields.length - 1; i += 2) {
            if (fields[i] === "data") {
                payload = fields[i + 1];
                break;
            }
        }
        if (!payload) return null;
        try {
            const parsed = JSON.parse(payload) as RemoteEnvelope;
            if (!parsed || typeof parsed.event !== "string") return null;
            return parsed;
        } catch {
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}
