/**
 * Canonical list order (RFC_INDEX_DRIVEN_LISTS D3): for every (kind, direction,
 * NULLS placement, indexed/unindexed) combination, walking pages forward with a
 * keyset cursor, backward with 'before', and by OFFSET must reproduce the
 * reference order exactly — non-null keys by (key D, id D), NULL keys by id D,
 * groups by NULLS placement. Data has heavy ties, NULLs, a missing key, and a
 * non-numeric string in a numeric field (which must sort as NULL, not raise).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import db from "../../../database";
import {
    NUMERIC_KEY_FN,
    NUMERIC_KEY_FN_DDL,
    buildOrderedIdSelect,
    fetchOrder,
    jsonFieldKey,
    type FieldKeyKind,
    type SortDirection,
} from "../../../query/orderPlan";

const TABLE = "order_plan_probe";

interface ProbeRow {
    id: string;
    rating: number | string | null | undefined;
    name: string | null | undefined;
}

function uuidFor(i: number): string {
    // Non-sequential so id order differs from insertion order.
    const n = ((i * 7919) % 1000).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${n}`;
}

const ROWS: ProbeRow[] = Array.from({ length: 53 }, (_, i) => {
    const rating = i % 11 === 0 ? null : i % 13 === 0 ? undefined : i === 17 ? "n/a" : [1, 2, 2, 3.5, 10][i % 5]!;
    const name = i % 9 === 0 ? null : i % 14 === 0 ? undefined : `n${String(i % 6).padStart(2, "0")}`;
    return { id: uuidFor(i), rating, name };
});

function keyOf(row: ProbeRow, kind: FieldKeyKind): number | string | null {
    const raw = kind === "numeric" ? row.rating : row.name;
    if (raw === null || raw === undefined) return null;
    if (kind === "numeric") return typeof raw === "number" ? raw : null;
    return String(raw);
}

function field(kind: FieldKeyKind): string {
    return kind === "numeric" ? "rating" : "name";
}

function reference(kind: FieldKeyKind, dir: SortDirection, nullsFirst: boolean): string[] {
    const sign = dir === "ASC" ? 1 : -1;
    const cmpId = (a: ProbeRow, b: ProbeRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
    const nonNull = ROWS.filter((r) => keyOf(r, kind) !== null).sort((a, b) => {
        const ka = keyOf(a, kind)!;
        const kb = keyOf(b, kind)!;
        if (ka !== kb) return (ka < kb ? -1 : 1) * sign;
        return cmpId(a, b);
    });
    const nulls = ROWS.filter((r) => keyOf(r, kind) === null).sort(cmpId);
    const ordered = nullsFirst ? [...nulls, ...nonNull] : [...nonNull, ...nulls];
    return ordered.map((r) => r.id);
}

function cursorValue(id: string, kind: FieldKeyKind): string | null {
    const row = ROWS.find((r) => r.id === id)!;
    const k = keyOf(row, kind);
    return k === null ? null : String(k);
}

async function page(opts: {
    kind: FieldKeyKind;
    dir: SortDirection;
    nullsFirst: boolean;
    indexed: boolean;
    cursor: { id: string; before: boolean } | null;
    limit: number;
    offset?: number;
}): Promise<string[]> {
    const params: unknown[] = [];
    const isBefore = opts.cursor?.before ?? false;
    const order = fetchOrder(opts.dir, opts.nullsFirst, isBefore);
    const sql = buildOrderedIdSelect({
        idExpr: "s.entity_id",
        fromSql: `${TABLE} s`,
        where: ["s.deleted_at IS NULL"],
        key: { expr: jsonFieldKey("s", field(opts.kind), opts.kind), kind: opts.kind, ...order },
        cursor: opts.cursor ? { id: opts.cursor.id, value: cursorValue(opts.cursor.id, opts.kind) } : null,
        limit: opts.limit,
        offset: opts.offset ?? 0,
        addParam: (value) => params.push(value),
        indexed: opts.indexed,
    });
    const rows = (await db.unsafe(sql, params)) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    return isBefore ? ids.reverse() : ids;
}

const PAGE = 7;
const combos: Array<{ kind: FieldKeyKind; dir: SortDirection; nullsFirst: boolean; indexed: boolean }> = [];
for (const kind of ["numeric", "text"] as const) {
    for (const dir of ["ASC", "DESC"] as const) {
        for (const nullsFirst of [false, true]) {
            for (const indexed of [true, false]) combos.push({ kind, dir, nullsFirst, indexed });
        }
    }
}

describe("canonical ordered id-select", () => {
    beforeAll(async () => {
        const exists = (await db.unsafe(`SELECT 1 FROM pg_proc WHERE proname = '${NUMERIC_KEY_FN}'`)) as unknown[];
        if (exists.length === 0) await db.unsafe(NUMERIC_KEY_FN_DDL);
        await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
        await db.unsafe(`CREATE TABLE ${TABLE} (entity_id uuid PRIMARY KEY, data jsonb NOT NULL, deleted_at timestamptz)`);
        for (const row of ROWS) {
            const data: Record<string, unknown> = {};
            if (row.rating !== undefined) data.rating = row.rating;
            if (row.name !== undefined) data.name = row.name;
            await db.unsafe(`INSERT INTO ${TABLE} (entity_id, data) VALUES ($1::uuid, $2)`, [row.id, data]);
        }
        // A soft-deleted row that must never appear.
        await db.unsafe(`INSERT INTO ${TABLE} (entity_id, data, deleted_at) VALUES ($1::uuid, $2, now())`, [
            "00000000-0000-4000-8000-ffffffffffff",
            { rating: 999, name: "n99" },
        ]);
        for (const kind of ["numeric", "text"] as const) {
            await db.unsafe(
                `CREATE INDEX ${TABLE}_${kind} ON ${TABLE} ((${jsonFieldKey(null, field(kind), kind)}), entity_id) WHERE deleted_at IS NULL`,
            );
        }
    });

    afterAll(async () => {
        await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    });

    test("non-numeric text in a numeric key is NULL, not an error", async () => {
        const rows = (await db.unsafe(`SELECT ${NUMERIC_KEY_FN}('n/a') AS a, ${NUMERIC_KEY_FN}('12.5') AS b, ${NUMERIC_KEY_FN}(NULL) AS c`)) as Array<{
            a: string | null;
            b: string | null;
            c: string | null;
        }>;
        expect(rows[0]!.a).toBeNull();
        expect(Number(rows[0]!.b)).toBe(12.5);
        expect(rows[0]!.c).toBeNull();
    });

    for (const combo of combos) {
        const label = `${combo.kind} ${combo.dir} NULLS ${combo.nullsFirst ? "FIRST" : "LAST"} ${combo.indexed ? "split" : "single"}`;

        test(`${label}: keyset forward, keyset 'before', and OFFSET all match the reference`, async () => {
            const expected = reference(combo.kind, combo.dir, combo.nullsFirst);

            const forward: string[] = [];
            let cursor: { id: string; before: boolean } | null = null;
            for (let guard = 0; guard < 20; guard++) {
                const ids = await page({ ...combo, cursor, limit: PAGE });
                forward.push(...ids);
                if (ids.length < PAGE) break;
                cursor = { id: ids[ids.length - 1]!, before: false };
            }
            expect(forward).toEqual(expected);

            const backward: string[] = [];
            let before: { id: string; before: boolean } = { id: expected[expected.length - 1]!, before: true };
            for (let guard = 0; guard < 20; guard++) {
                const ids = await page({ ...combo, cursor: before, limit: PAGE });
                backward.unshift(...ids);
                if (ids.length < PAGE) break;
                before = { id: ids[0]!, before: true };
            }
            expect(backward).toEqual(expected.slice(0, -1));

            const byOffset: string[] = [];
            for (let offset = 0; offset < expected.length; offset += PAGE) {
                byOffset.push(...(await page({ ...combo, cursor: null, limit: PAGE, offset })));
            }
            expect(byOffset).toEqual(expected);
        });
    }
});
