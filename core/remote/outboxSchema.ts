/**
 * Remote Communication: Transactional Outbox schema
 *
 * The outbox table records `emit()` calls made inside a DB transaction.
 * A background worker picks pending rows up and publishes them to Redis.
 * This guarantees that the event is only released to consumers if the
 * transaction that produced it committed — no "committed write without
 * matching event" after a crash.
 *
 * Schema: id, target, event, data, created_at, published_at, plus claim
 * columns used so the worker can commit a claim before any Redis I/O.
 * `source_app` is NOT a column — the worker stamps `sourceApp` from its
 * server-side config when publishing, never from the row payload.
 */

import type { SQL } from "bun";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "OutboxSchema" });
function isPreparedCollision(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const errno = "errno" in error ? String(error.errno) : "";
    const code = "code" in error ? String(error.code) : "";
    // Bun names prepared statements from a truncated SQL prefix (42P05).
    return errno === "42P05" || code === "42P05";
}

async function runDdl(db: SQL, statement: string): Promise<void> {
    try {
        // unsafe: DDL must not be prepared. Repeated ALTER text collides on
        // Bun's truncated statement names after a connection recycle.
        await db.unsafe(statement);
    } catch (error) {
        if (isPreparedCollision(error)) return;
        throw error;
    }
}

export async function ensureOutboxSchema(db: SQL): Promise<void> {
    await runDdl(db, `
        CREATE TABLE IF NOT EXISTS remote_outbox (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target VARCHAR(255) NOT NULL,
            event VARCHAR(255) NOT NULL,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            published_at TIMESTAMPTZ,
            claim_token TEXT,
            claimed_at TIMESTAMPTZ
        )
    `);

    // Existing installs created the table before claim columns existed.
    await runDdl(db, `ALTER TABLE remote_outbox ADD COLUMN IF NOT EXISTS claim_token TEXT`);
    await runDdl(db, `ALTER TABLE remote_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);

    await runDdl(db, `
        CREATE INDEX IF NOT EXISTS idx_remote_outbox_pending
        ON remote_outbox (created_at)
        WHERE published_at IS NULL
    `);

    loggerInstance.info("remote_outbox schema ensured");
}
