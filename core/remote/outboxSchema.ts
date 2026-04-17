/**
 * Remote Communication: Transactional Outbox schema
 *
 * The outbox table records `emit()` calls made inside a DB transaction.
 * A background worker picks pending rows up and publishes them to Redis.
 * This guarantees that the event is only released to consumers if the
 * transaction that produced it committed — no "committed write without
 * matching event" after a crash.
 *
 * Schema is intentionally minimal (Gall's Law): id, target, event, data,
 * created_at, published_at. Retry counts, DLQ tracking, and leases can be
 * added in later phases when there's a concrete reason.
 */

import type { SQL } from "bun";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "OutboxSchema" });

export async function ensureOutboxSchema(db: SQL): Promise<void> {
    await db`
        CREATE TABLE IF NOT EXISTS remote_outbox (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target VARCHAR(255) NOT NULL,
            event VARCHAR(255) NOT NULL,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            published_at TIMESTAMPTZ
        )
    `;

    // Partial index: only unpublished rows. Keeps the index small even as
    // the table accumulates historical sent messages.
    await db`
        CREATE INDEX IF NOT EXISTS idx_remote_outbox_pending
        ON remote_outbox (created_at)
        WHERE published_at IS NULL
    `;

    loggerInstance.info("remote_outbox schema ensured");
}
