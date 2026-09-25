/**
 * Decision logic for key-index reconcile. Catalog rows are inputs, not SQL text.
 */
import { describe, expect, test } from "bun:test";
import type { KeyIndexSpec } from "../../../database/keyIndexSpec";
import {
    boundIndexName,
    indexSyncMaxRows,
    legacyIndexNames,
    planKeyIndexReconcile,
    replacementAllowsDrop,
    tableIsSmall,
    type CatalogIndex,
} from "../../../database/indexReconciler";

function spec(name: string, table: string, fields: readonly string[] = ["f"]): KeyIndexSpec {
    return {
        name,
        table,
        fields,
        columnsSql: "(data->>'f'), entity_id",
        createSql(concurrently: boolean): string {
            return `CREATE INDEX${concurrently ? " CONCURRENTLY" : ""} IF NOT EXISTS ${name} ON ${table}`;
        },
    };
}

function plan(
    catalog: CatalogIndex[],
    desired = [spec("bk_ok_aaaaaaaa", "components_foo")],
    legacy: { table: string; name: string; replacedBy: string }[] = [],
    dropUndesired = false,
) {
    return planKeyIndexReconcile({
        desired,
        catalog,
        ownedTables: ["components_foo", "entities"],
        legacy,
        useConcurrently: () => false,
        dropUndesired,
    });
}

describe("key index reconcile plan", () => {
    test("creates a missing bk_ index and leaves unrelated indexes alone", () => {
        const result = plan([
            { name: "idx_components_foo_custom", table: "components_foo", valid: true },
            { name: "bk_rm_cccccccc", table: "rm_orders", valid: true },
        ]);
        expect(result.create.map((item) => item.spec.name)).toEqual(["bk_ok_aaaaaaaa"]);
        expect(result.dropBeforeCreate).toHaveLength(0);
        expect(result.dropAfter).toHaveLength(0);
        expect(result.analyze).toEqual(["components_foo"]);
    });

    test("a valid desired index is a no-op", () => {
        const result = plan([{ name: "bk_ok_aaaaaaaa", table: "components_foo", valid: true }]);
        expect(result.create).toHaveLength(0);
        expect(result.dropBeforeCreate).toHaveLength(0);
        expect(result.dropAfter).toHaveLength(0);
    });

    test("an invalid bk_ index is dropped and recreated, then legacy names go", () => {
        const result = planKeyIndexReconcile({
            desired: [spec("bk_ok_aaaaaaaa", "components_foo")],
            catalog: [
                { name: "bk_ok_aaaaaaaa", table: "components_foo", valid: false },
                { name: "idx_components_foo_f_btree", table: "components_foo", valid: true },
                { name: "idx_components_foo_f_gin", table: "components_foo", valid: true },
            ],
            ownedTables: ["components_foo"],
            legacy: [
                { table: "components_foo", name: "idx_components_foo_f_btree", replacedBy: "bk_ok_aaaaaaaa" },
                { table: "components_foo", name: "idx_components_foo_f_gin", replacedBy: "bk_ok_aaaaaaaa" },
            ],
            useConcurrently: () => true,
        });
        expect(result.dropBeforeCreate.map((drop) => drop.reason)).toEqual(["invalid"]);
        expect(result.dropBeforeCreate[0]?.concurrently).toBe(true);
        expect(result.create).toHaveLength(1);
        expect(result.dropAfter.map((drop) => drop.name).sort()).toEqual([
            "idx_components_foo_f_btree",
            "idx_components_foo_f_gin",
        ]);
        expect(result.dropAfter.every((drop) => drop.reason === "legacy" && drop.replacedBy === "bk_ok_aaaaaaaa")).toBe(true);
    });

    test("full ownership drops undesired bk_ names and does not drop legacy without a replacement", () => {
        const result = plan(
            [
                { name: "bk_ok_aaaaaaaa", table: "components_foo", valid: true },
                { name: "bk_old_bbbbbbbb", table: "components_foo", valid: true },
                { name: "idx_components_foo_f_numeric", table: "components_foo", valid: true },
                { name: "idx_entities_deleted_null", table: "entities", valid: true },
            ],
            [spec("bk_ok_aaaaaaaa", "components_foo")],
            [{ table: "components_foo", name: "idx_components_foo_f_numeric", replacedBy: "bk_missing" }],
            true,
        );
        expect(result.dropAfter.map((drop) => drop.name)).toEqual(["bk_old_bbbbbbbb"]);
        expect(result.dropAfter[0]?.reason).toBe("obsolete");
    });

    test("HASH late-register does not drop another component's bk_ index", () => {
        const mine = spec("bk_components_f_aaaaaaaa", "components", ["f"]);
        const result = planKeyIndexReconcile({
            desired: [mine],
            catalog: [
                { name: "bk_components_f_aaaaaaaa", table: "components", valid: true },
                { name: "bk_components_f_bbbbbbbb", table: "components", valid: true },
                { name: "bk_components_total_cccccccc", table: "components", valid: true },
            ],
            ownedTables: ["components"],
            legacy: [],
            useConcurrently: () => false,
        });
        expect(result.dropAfter.map((drop) => drop.name)).toEqual(["bk_components_f_bbbbbbbb"]);
        expect(result.dropAfter[0]?.replacedBy).toBe("bk_components_f_aaaaaaaa");
    });

    test("legacy names are dropped once the replacement is already valid", () => {
        const result = plan(
            [
                { name: "bk_ok_aaaaaaaa", table: "components_foo", valid: true },
                { name: "idx_components_foo_f_btree_date", table: "components_foo", valid: true },
            ],
            [spec("bk_ok_aaaaaaaa", "components_foo")],
            [{ table: "components_foo", name: "idx_components_foo_f_btree_date", replacedBy: "bk_ok_aaaaaaaa" }],
        );
        expect(result.create).toHaveLength(0);
        expect(result.dropAfter.map((drop) => drop.reason)).toEqual(["legacy"]);
    });

    test("negative reltuples use relation size, not an automatic sync build", () => {
        expect(tableIsSmall(null, 100_000)).toBe(true);
        expect(tableIsSmall(-1, 100_000)).toBe(true);
        expect(tableIsSmall(-1, 100_000, 64 * 1024 * 1024)).toBe(true);
        expect(tableIsSmall(-1, 100_000, 64 * 1024 * 1024 + 1)).toBe(false);
        expect(tableIsSmall(0, 100_000)).toBe(true);
        expect(tableIsSmall(99_999, 100_000)).toBe(true);
        expect(tableIsSmall(100_000, 100_000)).toBe(false);
        expect(tableIsSmall(0, 0)).toBe(false);
        expect(replacementAllowsDrop("unknown", true)).toBe(false);
        expect(replacementAllowsDrop("failed", true)).toBe(false);
        expect(replacementAllowsDrop("created", false)).toBe(false);
        expect(replacementAllowsDrop("created", true)).toBe(true);
        expect(replacementAllowsDrop("existing", true)).toBe(true);
        expect(legacyIndexNames("components_foo", "note", false)).not.toContain("idx_components_foo_note_gin");
    });

    test("index names never exceed 63 bytes and short names are unchanged", () => {
        expect(boundIndexName("idx_short")).toBe("idx_short");
        const long = `idx_${"a".repeat(80)}`;
        const bounded = boundIndexName(long);
        expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(63);
        expect(boundIndexName(long)).toBe(bounded);
        expect(legacyIndexNames("components_foo", "MyField")).toEqual([
            "idx_components_foo_myfield_btree",
            "idx_components_foo_myfield_btree_date",
            "idx_components_foo_myfield_numeric",
            "idx_components_foo_myfield_gin",
        ]);
    });

    test("sync threshold reads BUNSANE_INDEX_SYNC_MAX_ROWS", () => {
        const previous = process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
        process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = "7";
        try {
            expect(indexSyncMaxRows()).toBe(7);
            expect(tableIsSmall(6)).toBe(true);
            expect(tableIsSmall(7)).toBe(false);
        } finally {
            if (previous == null) delete process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
            else process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = previous;
        }
    });
});
