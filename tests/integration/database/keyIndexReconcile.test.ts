/**
 * Key indexes after component registration: bk_ present, legacy per-field
 * names gone, definition changes and invalid indexes rebuilt, large tables
 * deferred until awaitIndexReconcile().
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import db from "../../../database";
import { dbTransaction } from "../../../database/gateway";
import { GenerateTableName } from "../../../database/DatabaseHelper";
import { componentKeyIndexSpecs, entityKeyIndexSpecs, keyFieldsOf } from "../../../database/keyIndexSpec";
import {
    awaitIndexReconcile,
    ensureNumericKeyFunction,
    legacyIndexNames,
    reconcileKeyIndexes,
} from "../../../database/indexReconciler";
import { ComponentRegistry } from "../../../core/components";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import { CompositeIndex } from "../../../core/decorators/CompositeIndex";
import { IndexedField } from "../../../core/decorators/IndexedField";
import { getMetadataStorage } from "../../../core/metadata";

@Component
class IdxDdlNum extends BaseComponent {
    @CompData({ indexed: true })
    f!: number;

    @CompData({ indexed: true })
    @IndexedField("gin")
    note!: string;

    @CompData()
    @IndexedField("btree")
    label!: string;

    @CompData()
    @IndexedField("hash")
    code!: string;

    @CompData({ indexed: true, arrayOf: String })
    tags!: string[];
}

@CompositeIndex<IdxDdlOrder>(["status", "total"])
@Component
class IdxDdlOrder extends BaseComponent {
    @CompData()
    status!: string;

    @CompData({ indexed: true })
    total!: number;
}

const NUM_TABLE = GenerateTableName("IdxDdlNum");
const ORDER_TABLE = GenerateTableName("IdxDdlOrder");

interface CatalogIndex {
    name: string;
    valid: boolean;
}

async function indexesOn(table: string): Promise<CatalogIndex[]> {
    const rows = await db.unsafe(
        `SELECT c.relname AS name, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = $1`,
        [table],
    ) as Array<{ name: string; valid: unknown }>;
    return rows.map((row) => ({
        name: row.name,
        valid: row.valid === true || row.valid === "t" || row.valid === "true",
    }));
}

function names(rows: CatalogIndex[]): string[] {
    return rows.map((row) => row.name);
}

describe("key index reconcile", () => {
    beforeAll(async () => {
        await ComponentRegistry.registerAllComponents();
        await ComponentRegistry.getReadyPromise("IdxDdlNum");
        await ComponentRegistry.getReadyPromise("IdxDdlOrder");

        const typeId = getMetadataStorage().getComponentId("IdxDdlNum");
        for (let i = 0; i < 8; i++) {
            const entityId = randomUUID();
            await db.unsafe(`INSERT INTO entities (id) VALUES ($1)`, [entityId]);
            await db.unsafe(
                `INSERT INTO ${NUM_TABLE} (id, entity_id, type_id, data) VALUES ($1, $2, $3, $4)`,
                [randomUUID(), entityId, typeId, { f: i, label: "a", code: "c", tags: ["t"] }],
            );
        }
        await db.unsafe(`ANALYZE ${NUM_TABLE}`);
        await db.unsafe(`ANALYZE entities`);
    }, 120_000);

    test("numeric key function never raises and is idempotent", async () => {
        await ensureNumericKeyFunction();
        await ensureNumericKeyFunction();
        const rows = await db.unsafe(
            `SELECT bunsane_num_v1('12.5') AS n, bunsane_num_v1('n/a') AS bad`,
        ) as Array<{ n: unknown; bad: unknown }>;
        expect(Number(rows[0]?.n)).toBe(12.5);
        expect(rows[0]?.bad).toBeNull();
    });

    test("boot creates bk_ indexes and drops legacy btree/numeric/scalar gin names", async () => {
        const specs = componentKeyIndexSpecs("IdxDdlNum", NUM_TABLE, "list");
        const present = names(await indexesOn(NUM_TABLE));
        for (const spec of specs) {
            expect(present).toContain(spec.name);
        }
        for (const field of keyFieldsOf("IdxDdlNum")) {
            const includeGin = field !== "note";
            for (const legacy of legacyIndexNames(NUM_TABLE, field, includeGin)) {
                expect(present).not.toContain(legacy);
            }
        }
        expect(present).toContain(`idx_${NUM_TABLE}_tags_gin`);
        expect(present).toContain(`idx_${NUM_TABLE}_note_gin`);
        expect(present).toContain(`idx_${NUM_TABLE}_code_hash`);
        expect(present.some((name) => name.includes("_btree"))).toBe(false);
        expect(present.some((name) => name.endsWith("_numeric"))).toBe(false);

        const entities = names(await indexesOn("entities"));
        for (const spec of entityKeyIndexSpecs()) {
            expect(entities).toContain(spec.name);
        }
        expect(entities).toContain("idx_entities_deleted_null");
    });

    test("a 0.8-shaped leaf converges: legacy names go, bk_ comes back, a second pass is a no-op", async () => {
        const specs = componentKeyIndexSpecs("IdxDdlNum", NUM_TABLE, "list");
        const fieldSpec = specs.find((item) => item.fields.length === 1 && item.fields[0] === "f");
        expect(fieldSpec).toBeDefined();
        await db.unsafe(`DROP INDEX IF EXISTS ${fieldSpec!.name}`);
        for (const legacy of legacyIndexNames(NUM_TABLE, "f")) {
            await db.unsafe(
                `CREATE INDEX IF NOT EXISTS ${legacy} ON ${NUM_TABLE} ((data->>'f'))`,
            );
        }
        await db.unsafe(
            `CREATE INDEX IF NOT EXISTS bk_idxddlnum_obsolete ON ${NUM_TABLE} ((data->>'f'), entity_id) WHERE deleted_at IS NULL`,
        );
        await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_${NUM_TABLE}_keep_custom ON ${NUM_TABLE} (entity_id)`);

        await reconcileKeyIndexes({
            components: [{ name: "IdxDdlNum", table: NUM_TABLE, strategy: "list" }],
            includeEntities: false,
            dropUndesired: true,
        });
        await reconcileKeyIndexes({
            components: [{ name: "IdxDdlNum", table: NUM_TABLE, strategy: "list" }],
            includeEntities: false,
            dropUndesired: true,
        });

        const present = names(await indexesOn(NUM_TABLE));
        expect(present).toContain(fieldSpec!.name);
        expect(present).not.toContain("bk_idxddlnum_obsolete");
        expect(present).toContain(`idx_${NUM_TABLE}_keep_custom`);
        for (const legacy of legacyIndexNames(NUM_TABLE, "f")) {
            expect(present).not.toContain(legacy);
        }
    });

    test("CompositeIndex creates the composite index and an unknown field fails", async () => {
        const specs = componentKeyIndexSpecs("IdxDdlOrder", ORDER_TABLE, "list");
        const present = names(await indexesOn(ORDER_TABLE));
        expect(specs.length).toBeGreaterThanOrEqual(2);
        for (const spec of specs) expect(present).toContain(spec.name);
        const composite = specs.find((item) => item.fields.length === 2);
        expect(composite?.fields).toEqual(["status", "total"]);

        @CompositeIndex(["no_such", "also_missing"])
        @Component
        class IdxDdlBadComposite extends BaseComponent {
            @CompData()
            present!: string;
        }
        await expect(reconcileKeyIndexes({
            components: [{ name: IdxDdlBadComposite.name, table: "components_idxddlbadcomposite", strategy: "list" }],
            includeEntities: false,
        })).rejects.toThrow(/no_such/);
    });

    test("a component registered after boot gets a key index", async () => {
        @Component
        class IdxDdlLate extends BaseComponent {
            @CompData({ indexed: true })
            label!: string;
        }
        await ComponentRegistry.getReadyPromise("IdxDdlLate");
        const table = GenerateTableName("IdxDdlLate");
        const specs = componentKeyIndexSpecs("IdxDdlLate", table, "list");
        const present = names(await indexesOn(table));
        expect(specs.length).toBe(1);
        expect(present).toContain(specs[0]!.name);
    });

    test("tables at or above the sync threshold build in the background", async () => {
        const stats = await db.unsafe(
            `SELECT reltuples FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = $1`,
            [NUM_TABLE],
        ) as Array<{ reltuples: unknown }>;
        const reltuples = Number(stats[0]?.reltuples);
        expect(reltuples).toBeGreaterThanOrEqual(0);

        const specs = componentKeyIndexSpecs("IdxDdlNum", NUM_TABLE, "list");
        const fieldSpec = specs.find((item) => item.fields.length === 1 && item.fields[0] === "label");
        expect(fieldSpec).toBeDefined();
        await db.unsafe(`DROP INDEX IF EXISTS ${fieldSpec!.name}`);

        const previous = process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
        process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = "0";
        try {
            await reconcileKeyIndexes({
                components: [{ name: "IdxDdlNum", table: NUM_TABLE, strategy: "list" }],
                includeEntities: false,
            });
            expect(names(await indexesOn(NUM_TABLE))).not.toContain(fieldSpec!.name);
            await awaitIndexReconcile();
            const after = await indexesOn(NUM_TABLE);
            expect(after.find((row) => row.name === fieldSpec!.name)?.valid).toBe(true);
        } finally {
            if (previous == null) delete process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
            else process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = previous;
        }
    });

    test.skipIf(process.env.USE_PGLITE === "true")(
        "an invalid bk_ index is rebuilt when the catalog says so",
        async () => {
        const specs = componentKeyIndexSpecs("IdxDdlNum", NUM_TABLE, "list");
        const fieldSpec = specs.find((item) => item.fields.length === 1 && item.fields[0] === "f");
        expect(fieldSpec).toBeDefined();
        try {
            await db.unsafe(
                `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${fieldSpec!.name}'::regclass`,
            );
        } catch {
            // Non-superuser test roles cannot mark an index invalid. The plan
            // test covers that decision; this assertion needs catalog write.
            return;
        }
        await reconcileKeyIndexes({
            components: [{ name: "IdxDdlNum", table: NUM_TABLE, strategy: "list" }],
            includeEntities: false,
        });
        const after = await indexesOn(NUM_TABLE);
        expect(after.find((row) => row.name === fieldSpec!.name)?.valid).toBe(true);
    });

    test.skipIf(process.env.USE_PGLITE === "true")(
        "numeric DESC sort uses the bk_ index backward",
        async () => {
            const specs = componentKeyIndexSpecs("IdxDdlNum", NUM_TABLE, "list");
            const fieldSpec = specs.find((item) => item.fields.length === 1 && item.fields[0] === "f");
            expect(fieldSpec).toBeDefined();
            const plan = await dbTransaction(async (trx) => {
                await trx.unsafe(`SET LOCAL enable_seqscan = off`);
                const rows = await trx.unsafe(
                    `EXPLAIN SELECT s.entity_id FROM ${NUM_TABLE} s
                     WHERE s.deleted_at IS NULL
                     ORDER BY bunsane_num_v1(s.data->>'f') DESC NULLS FIRST, s.entity_id DESC
                     LIMIT 5`,
                ) as Array<{ "QUERY PLAN": string }>;
                return rows.map((row) => row["QUERY PLAN"]).join("\n");
            }, { lane: "background", timeoutMs: 30_000 });
            expect(plan).toContain("Index Scan Backward");
            expect(plan).toContain(fieldSpec!.name);
        },
    );
});
