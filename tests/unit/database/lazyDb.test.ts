/**
 * The default `db` export is a lazy proxy over getDb(). Importing the module
 * must not open a pool (covered by tests/public-api). Once a caller uses the
 * client, tagged templates, unsafe(), and begin() have to hit the live pool.
 */
import { describe, expect, test } from "bun:test";
import db, { getDb } from "../../../database";

describe("lazy database proxy", () => {
    test("tagged template, unsafe, and begin forward to the live pool", async () => {
        const viaTemplate = await db`SELECT 1 AS n`;
        expect(Number(viaTemplate[0]?.n)).toBe(1);

        const viaUnsafe = await db.unsafe("SELECT 2 AS n");
        expect(Number(viaUnsafe[0]?.n)).toBe(2);

        const viaBegin = await db.begin(async (tx) => {
            const rows = await tx`SELECT 3 AS n`;
            return Number(rows[0]?.n);
        });
        expect(viaBegin).toBe(3);

        const viaGetDb = await getDb()`SELECT 4 AS n`;
        expect(Number(viaGetDb[0]?.n)).toBe(4);
    });
});
