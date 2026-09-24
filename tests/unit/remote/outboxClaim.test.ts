import { describe, test, expect, beforeEach } from "bun:test";
import type Redis from "ioredis";
import db from "../../../database";
import { ensureOutboxSchema } from "../../../core/remote/outboxSchema";
import { OutboxWorker } from "../../../core/remote/OutboxWorker";

describe("outbox claim then publish", () => {
    beforeEach(async () => {
        await ensureOutboxSchema(db);
    });

    test("commits the claim before XADD and stamps sourceApp from config", async () => {
        const target = `claim-${crypto.randomUUID()}`;
        // JS object, not JSON.stringify — PGlite JSONB rejects the string form.
        const inserted = await db`
            INSERT INTO remote_outbox (target, event, data)
            VALUES (${target}, ${"order.created"}, ${{ sourceApp: "attacker", n: 1 }})
            RETURNING id
        `;
        const id = inserted[0]!.id as string;

        let payload = "";
        let claimCommittedBeforeRedis = false;
        const publisher = {
            async xadd(_stream: string, _id: string, _field: string, data: string) {
                const rows = await db.unsafe(
                    `SELECT claim_token, published_at FROM remote_outbox WHERE id = $1`,
                    [id]
                );
                claimCommittedBeforeRedis =
                    rows[0]?.claim_token != null && rows[0]?.published_at == null;
                payload = data;
                return "1-0";
            },
        };

        const worker = new OutboxWorker(db, publisher as unknown as Redis, {
            sourceApp: "this-app",
            streamPrefix: "remote:",
            pollIntervalMs: 60_000,
            batchSize: 10,
            enableLogging: false,
            retentionMs: 0,
        });

        await worker.flush();

        expect(claimCommittedBeforeRedis).toBe(true);
        const parsed = JSON.parse(payload) as {
            sourceApp: string;
            correlationId: string;
            data: { sourceApp?: string };
        };
        expect(parsed.sourceApp).toBe("this-app");
        expect(parsed.data.sourceApp).toBe("attacker");
        expect(parsed.correlationId).toBe(id);

        const after = await db.unsafe(
            `SELECT published_at, claim_token FROM remote_outbox WHERE id = $1`,
            [id]
        );
        expect(after[0]?.published_at).not.toBeNull();
        expect(after[0]?.claim_token).toBeNull();

        await db.unsafe(`DELETE FROM remote_outbox WHERE id = $1`, [id]);
    });
});
