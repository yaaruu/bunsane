/**
 * Remote Communication: OutboxWorker
 *
 * Polls `remote_outbox` for unpublished rows and publishes each to Redis.
 *
 * Claim, commit, then XADD. Redis I/O never runs inside the PostgreSQL
 * transaction: a slow Redis must not hold row locks. The claim (`claim_token`
 * + `claimed_at`) is committed first; XADD happens after; `published_at` is
 * set in a later statement.
 *
 * At-least-once: if the process dies after XADD and before `published_at` is
 * set, the claim lease expires and another tick republishes the same row
 * (new Redis id, same `correlationId` = outbox row id). Consumers dedupe on
 * `(sourceApp, correlationId)` inside the in-memory retention window.
 * `sourceApp` is stamped from this worker's config, never from the row payload.
 */

import type Redis from "ioredis";
import type { SQL } from "bun";
import { logger } from "../Logger";
import type { RemoteMetrics } from "./metrics";
import { encodeEnvelope } from "./envelopeSign";

const loggerInstance = logger.child({ scope: "OutboxWorker" });

export interface OutboxWorkerConfig {
    sourceApp: string;
    streamPrefix: string;
    pollIntervalMs: number;
    batchSize: number;
    enableLogging: boolean;
    /** Retention window for published rows in ms. 0 disables trimming. Default 24h. */
    retentionMs: number;
    /** How long a claim blocks other workers before it can be stolen. Default 60s. */
    claimLeaseMs?: number;
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
    private lastTrimAt = 0;

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
     * Force an immediate publish pass. Used during shutdown and tests.
     * Does not require start() — `running` only gates the poll timer.
     */
    async flush(): Promise<void> {
        await this.processBatch();
        await this.maybeTrimPublished();
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
        await this.processOnce();
    }

    private async processOnce(): Promise<void> {
        try {
            await this.processBatch();
            await this.maybeTrimPublished();
        } catch (error: any) {
            loggerInstance.error(
                { err: error, msg: "OutboxWorker tick error" }
            );
        }
    }

    private async maybeTrimPublished(): Promise<void> {
        const { retentionMs } = this.config;
        if (!retentionMs) return;

        const now = Date.now();
        // At most once per hour to avoid frequent lock contention
        if (now - this.lastTrimAt < 3_600_000) return;
        this.lastTrimAt = now;

        const cutoff = new Date(now - retentionMs);
        const db = this.db as any;
        const result = await db`
            DELETE FROM remote_outbox
            WHERE id IN (
                SELECT id FROM remote_outbox
                WHERE published_at IS NOT NULL
                  AND published_at < ${cutoff}
                LIMIT 10000
            )
        `;
        const count = result.count ?? result.length ?? 0;
        if (count > 0) {
            loggerInstance.debug(`Trimmed ${count} published outbox rows older than ${cutoff.toISOString()}`);
        }
    }

    private claimLeaseMs(): number {
        return this.config.claimLeaseMs ?? 60_000;
    }

    /**
     * Claim unpublished rows and commit before returning. Callers must not
     * touch Redis until this promise resolves.
     */
    private async claimRows(): Promise<{ token: string; rows: OutboxRow[] }> {
        const token = crypto.randomUUID();
        const leaseSec = Math.max(1, Math.ceil(this.claimLeaseMs() / 1000));
        // Bun's SQL type doesn't expose begin(); the runtime does.
        const db = this.db as unknown as {
            begin(fn: (trx: { unsafe(query: string, params?: unknown[]): Promise<unknown> }) => Promise<void>): Promise<void>;
        };
        let rows: OutboxRow[] = [];
        await db.begin(async (trx) => {
            // unsafe: tagged templates are prepared, and Bun's truncated
            // statement names collide (42P05) after a connection recycle.
            const selected = await trx.unsafe(
                `SELECT id, target, event, data, created_at
                 FROM remote_outbox
                 WHERE published_at IS NULL
                   AND (claimed_at IS NULL OR claimed_at < NOW() - ($1 * INTERVAL '1 second'))
                 ORDER BY created_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED`,
                [leaseSec, this.config.batchSize]
            );
            if (!Array.isArray(selected) || selected.length === 0) return;
            const ids = selected.map((row: OutboxRow) => row.id);
            const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
            await trx.unsafe(
                `UPDATE remote_outbox
                 SET claim_token = $1, claimed_at = NOW()
                 WHERE id IN (${placeholders})`,
                [token, ...ids]
            );
            rows = selected;
        });
        return { token, rows };
    }

    private async publishRow(row: OutboxRow): Promise<void> {
        const stream = `${this.config.streamPrefix}${row.target}`;
        const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
        // sourceApp is server config, never row.data.sourceApp.
        const payload = encodeEnvelope({
            kind: "event",
            sourceApp: this.config.sourceApp,
            event: row.event,
            data: row.data,
            emittedAt: created.getTime(),
            correlationId: row.id,
        });
        await this.publisher.xadd(stream, "*", "data", payload);
    }

    private async markIds(token: string, ids: string[], published: boolean): Promise<void> {
        if (ids.length === 0) return;
        const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
        const sql = published
            ? `UPDATE remote_outbox SET published_at = NOW(), claim_token = NULL WHERE claim_token = $1 AND id IN (${placeholders})`
            : `UPDATE remote_outbox SET claim_token = NULL, claimed_at = NULL WHERE claim_token = $1 AND id IN (${placeholders})`;
        await this.db.unsafe(sql, [token, ...ids]);
    }

    private async processBatch(): Promise<void> {
        const { token, rows } = await this.claimRows();
        if (rows.length === 0) return;

        this.metrics?.outboxClaimed(rows.length);
        if (this.config.enableLogging) {
            loggerInstance.debug(`Claimed ${rows.length} outbox rows`);
        }

        // Redis I/O is outside the claim transaction (H-DB-1).
        const publishResults = await Promise.allSettled(rows.map((row) => this.publishRow(row)));

        const successIds: string[] = [];
        const failedIds: string[] = [];
        for (let i = 0; i < publishResults.length; i++) {
            const result = publishResults[i];
            const row = rows[i]!;
            if (result && result.status === "fulfilled") {
                successIds.push(row.id);
            } else {
                failedIds.push(row.id);
                this.metrics?.outboxPublishFailed();
                loggerInstance.error({
                    err: result && result.status === "rejected" ? result.reason : undefined,
                    outboxId: row.id,
                    target: row.target,
                    event: row.event,
                    msg: "Outbox XADD failed — claim released, row retries next tick",
                });
            }
        }

        await this.markIds(token, successIds, true);
        if (successIds.length > 0) this.metrics?.outboxPublished(successIds.length);
        await this.markIds(token, failedIds, false);
    }
}
