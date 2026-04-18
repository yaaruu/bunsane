/**
 * Remote Communication: OutboxWorker
 *
 * Polls `remote_outbox` for unpublished rows, publishes each to Redis, and
 * marks the row published. Uses `FOR UPDATE SKIP LOCKED` so multiple
 * instances can run workers concurrently without double-publishing:
 * each row is claimed by exactly one worker per batch.
 *
 * At-least-once semantics: if the worker crashes after XADD but before the
 * UPDATE commits, the row stays pending and will be republished. Consumers
 * must be idempotent — enforce this at the handler level (e.g., dedup on
 * `ctx.messageId` or domain-level idempotency keys).
 */

import type Redis from "ioredis";
import { sql as sqlHelper, type SQL } from "bun";
import { logger } from "../Logger";
import type { RemoteMetrics } from "./metrics";

const loggerInstance = logger.child({ scope: "OutboxWorker" });

export interface OutboxWorkerConfig {
    sourceApp: string;
    streamPrefix: string;
    pollIntervalMs: number;
    batchSize: number;
    enableLogging: boolean;
}

interface OutboxRow {
    id: string;
    target: string;
    event: string;
    data: unknown;
    created_at: Date;
}

export class OutboxWorker {
    private db: SQL;
    private publisher: Redis;
    private config: OutboxWorkerConfig;
    private running = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private currentTick: Promise<void> | null = null;
    private metrics?: RemoteMetrics;

    constructor(
        db: SQL,
        publisher: Redis,
        config: OutboxWorkerConfig,
        metrics?: RemoteMetrics
    ) {
        this.db = db;
        this.publisher = publisher;
        this.config = config;
        this.metrics = metrics;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.scheduleNext(0);
        loggerInstance.info(
            `OutboxWorker started pollMs=${this.config.pollIntervalMs} batch=${this.config.batchSize}`
        );
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.currentTick) {
            await this.currentTick.catch(() => {});
        }
        loggerInstance.info("OutboxWorker stopped");
    }

    /**
     * Force an immediate tick. Used during shutdown to flush any
     * committed-but-unpublished rows before the process exits.
     */
    async flush(): Promise<void> {
        await this.tick();
    }

    private scheduleNext(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.currentTick = this.tick().finally(() => {
                this.currentTick = null;
                this.scheduleNext(this.config.pollIntervalMs);
            });
        }, delayMs);
    }

    private async tick(): Promise<void> {
        if (!this.running) return;
        try {
            await this.processBatch();
        } catch (error: any) {
            loggerInstance.error(
                { err: error, msg: "OutboxWorker tick error" }
            );
        }
    }

    private async processBatch(): Promise<void> {
        const db = this.db as any;
        await db.begin(async (trx: any) => {
            const rows: OutboxRow[] = await trx`
                SELECT id, target, event, data, created_at
                FROM remote_outbox
                WHERE published_at IS NULL
                ORDER BY created_at
                LIMIT ${this.config.batchSize}
                FOR UPDATE SKIP LOCKED
            `;

            if (rows.length === 0) return;

            this.metrics?.outboxClaimed(rows.length);
            if (this.config.enableLogging) {
                loggerInstance.debug(`Claimed ${rows.length} outbox rows`);
            }

            // Publish concurrently rather than serially. Each xadd is bounded
            // by the publisher client's `commandTimeout`; with serial awaits a
            // batch of N slow rows would hold PG row locks for N × timeout.
            // Parallel keeps worst-case lock hold ≈ single-xadd timeout.
            // (H-DB-1 partial — full fix requires a claim-via-column design
            // so Redis latency no longer sits inside a PG transaction at all.)
            const publishResults = await Promise.allSettled(
                rows.map((row) => {
                    const stream = `${this.config.streamPrefix}${row.target}`;
                    const envelope = JSON.stringify({
                        kind: "event",
                        sourceApp: this.config.sourceApp,
                        event: row.event,
                        data: row.data,
                        emittedAt: row.created_at.getTime(),
                    });
                    return this.publisher.xadd(stream, "*", "data", envelope);
                })
            );

            const successIds: string[] = [];
            for (let i = 0; i < publishResults.length; i++) {
                const r = publishResults[i];
                const row = rows[i]!;
                if (r!.status === "fulfilled") {
                    successIds.push(row.id);
                } else {
                    this.metrics?.outboxPublishFailed();
                    loggerInstance.error({
                        err: r!.reason,
                        outboxId: row.id,
                        target: row.target,
                        event: row.event,
                        msg: "Outbox XADD failed — row will retry next tick",
                    });
                    // Leave row unpublished; SKIP LOCKED releases on tx end
                    // so next tick (or another instance) picks it up.
                }
            }

            if (successIds.length > 0) {
                // Single bulk UPDATE instead of N round-trips holding row
                // locks (H-DB-3). Previously each success fired its own
                // UPDATE statement serially. Uses Bun SQL's `sql(...)` helper
                // for the IN-list so ids are parameterised individually.
                await trx`
                    UPDATE remote_outbox
                    SET published_at = NOW()
                    WHERE id IN ${sqlHelper(successIds)}
                `;
                this.metrics?.outboxPublished(successIds.length);
            }
        });
    }
}
