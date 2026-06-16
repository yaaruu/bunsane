import { describe, it, expect } from "bun:test";
import db from "../../../database/index";

// Verifies the ALTER form used by MigrateTimestampsToTimestamptz works on a
// partitioned parent (matches `components`) under both PostgreSQL and PGlite,
// and that the idempotency type check reads back correctly.
describe("timestamptz migration SQL", () => {
    const t = "tz_migrate_scratch";

    const colType = async (table: string, col: string): Promise<string | null> => {
        const rows = await db.unsafe(`
            SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${col}'
        `);
        return rows.length ? (rows[0] as any).data_type : null;
    };

    it("ALTERs bare timestamp → timestamptz on a partitioned table, idempotently", async () => {
        await db.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
        await db.unsafe(`CREATE TABLE ${t} (
            id UUID,
            type_id varchar(64) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            deleted_at TIMESTAMP,
            PRIMARY KEY (id, type_id)
        ) PARTITION BY HASH (type_id)`);
        await db.unsafe(`CREATE TABLE ${t}_p0 PARTITION OF ${t} FOR VALUES WITH (MODULUS 1, REMAINDER 0)`);

        expect(await colType(t, "created_at")).toBe("timestamp without time zone");

        for (const col of ["created_at", "deleted_at"]) {
            if ((await colType(t, col)) === "timestamp without time zone") {
                await db.unsafe(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE timestamptz USING ${col} AT TIME ZONE 'UTC'`);
            }
        }

        expect(await colType(t, "created_at")).toBe("timestamp with time zone");
        expect(await colType(t, "deleted_at")).toBe("timestamp with time zone");

        // Second pass is a no-op (idempotent).
        for (const col of ["created_at", "deleted_at"]) {
            if ((await colType(t, col)) === "timestamp without time zone") {
                await db.unsafe(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE timestamptz USING ${col} AT TIME ZONE 'UTC'`);
            }
        }
        expect(await colType(t, "created_at")).toBe("timestamp with time zone");

        await db.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    });
});
