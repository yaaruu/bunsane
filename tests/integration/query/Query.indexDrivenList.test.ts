/**
 * List reads through Query (RFC D3/D4/D5): keyset, before, and offset pages
 * match a JS reference for numeric and text keys, including ties, NULLs,
 * missing keys, and a non-numeric string in a numeric field. Unsorted
 * two-component pages and count() match the same set INTERSECT used to return.
 */
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import type { SQL } from "bun";
import { Query, FilterOp, or } from "../../../query/Query";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import { ComponentRegistry } from "../../../core/components";
import { createTestContext, ensureComponentsRegistered } from "../../utils";
import { GenerateTableName } from "../../../database/DatabaseHelper";
import { componentKeyIndexSpecs } from "../../../database/keyIndexSpec";
import { NUMERIC_KEY_FN, NUMERIC_KEY_FN_DDL } from "../../../query/orderPlan";
import db from "../../../database";

@Component
class IdxList extends BaseComponent {
    @CompData({ indexed: true }) label: string = "";
    @CompData({ indexed: true }) score: number = 0;
    @CompData({ indexed: true }) name: string = "";
}

@Component
class IdxFlag extends BaseComponent {
    @CompData({ indexed: true }) bucket: string = "";
}

type Row = {
    id: string;
    score: number | null;
    name: string | null;
    flagged: boolean;
};

const SPEC: Array<{ score: number | string | null | undefined; name: string | null | undefined; flagged: boolean }> = [
    { score: 1, name: "b", flagged: true },
    { score: 1, name: "a", flagged: true },
    { score: 1, name: "a", flagged: false },
    { score: 2, name: "a", flagged: true },
    { score: 2, name: "a", flagged: true },
    { score: 10, name: "m", flagged: false },
    { score: 10, name: null, flagged: true },
    { score: null, name: "z", flagged: true },
    { score: undefined, name: "q", flagged: true },
    { score: "n/a", name: "n", flagged: true },
    { score: 0, name: "a", flagged: false },
    { score: 3.5, name: "b", flagged: true },
    { score: 3.5, name: "b", flagged: true },
];

function idCmp(a: Row, b: Row, dir: "ASC" | "DESC"): number {
    const sign = dir === "ASC" ? 1 : -1;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
}

function ordered(rows: Row[], kind: "numeric" | "text", dir: "ASC" | "DESC", nullsFirst: boolean): string[] {
    const sign = dir === "ASC" ? 1 : -1;
    const keyOf = (row: Row): number | string | null => (kind === "numeric" ? row.score : row.name);
    const nonNull = rows.filter((row) => keyOf(row) !== null).sort((a, b) => {
        const ka = keyOf(a)!;
        const kb = keyOf(b)!;
        if (ka !== kb) return (ka < kb ? -1 : 1) * sign;
        return idCmp(a, b, dir);
    });
    const nulls = rows.filter((row) => keyOf(row) === null).sort((a, b) => idCmp(a, b, dir));
    return (nullsFirst ? [...nulls, ...nonNull] : [...nonNull, ...nulls]).map((row) => row.id);
}

describe("index-driven component lists", () => {
    const ctx = createTestContext();
    let prefix = "";
    let rows: Row[] = [];
    let listTypeId = "";

    beforeAll(async () => {
        await ensureComponentsRegistered(IdxList, IdxFlag);
        listTypeId = ComponentRegistry.getComponentId(IdxList.name)!;
        const exists = (await db.unsafe(`SELECT 1 FROM pg_proc WHERE proname = '${NUMERIC_KEY_FN}'`)) as unknown[];
        if (exists.length === 0) await db.unsafe(NUMERIC_KEY_FN_DDL);
    });

    beforeEach(async () => {
        prefix = `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        rows = [];
        for (const spec of SPEC) {
            const entity = ctx.tracker.create();
            const data: { label: string; score?: number; name?: string } = { label: prefix };
            if (typeof spec.score === "number") data.score = spec.score;
            if (typeof spec.name === "string") data.name = spec.name;
            entity.add(IdxList, data);
            if (spec.flagged) entity.add(IdxFlag, { bucket: prefix });
            await entity.save();
            if (spec.score === "n/a") {
                await db.unsafe(
                    `UPDATE components SET data = jsonb_set(data, '{score}', '"n/a"') WHERE entity_id = $1::uuid AND type_id = $2`,
                    [entity.id, listTypeId],
                );
            } else if (spec.score == null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'score' WHERE entity_id = $1::uuid AND type_id = $2`,
                    [entity.id, listTypeId],
                );
            }
            if (spec.name == null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'name' WHERE entity_id = $1::uuid AND type_id = $2`,
                    [entity.id, listTypeId],
                );
            }
            rows.push({
                id: entity.id,
                score: typeof spec.score === "number" ? spec.score : null,
                name: spec.name ?? null,
                flagged: spec.flagged,
            });
        }
    });

    function base() {
        return new Query().with(IdxList, { filters: [Query.filter("label", FilterOp.EQ, prefix)] });
    }

    async function assertPages<Q extends {
        take(n: number): Q;
        exec(): Promise<Array<{ id: string }>>;
        sortedCursor(token: string, direction?: "after" | "before"): Q;
        offset(n: number): Q;
    }>(
        make: () => Q,
        expected: string[],
        cursorOf: (id: string) => string | number | null | Array<string | number | null>,
    ): Promise<void> {
        const all = await make().take(100).exec();
        expect(all.map((entity) => entity.id)).toEqual(expected);

        const forward: string[] = [];
        let token: string | undefined;
        for (let guard = 0; guard < expected.length + 2; guard++) {
            let query = make().take(3);
            if (token) query = query.sortedCursor(token);
            const page = await query.exec();
            if (page.length === 0) break;
            forward.push(...page.map((entity) => entity.id));
            const last = page[page.length - 1]!;
            token = Query.encodeSortedCursor(cursorOf(last.id), last.id);
            if (page.length < 3) break;
        }
        expect(forward).toEqual(expected);

        for (let offset = 0; offset < expected.length; offset += 4) {
            const page = await make().take(4).offset(offset).exec();
            expect(page.map((entity) => entity.id)).toEqual(expected.slice(offset, offset + 4));
        }

        if (expected.length > 4) {
            const at = expected[4]!;
            const back = await make().sortedCursor(Query.encodeSortedCursor(cursorOf(at), at), "before").take(3).exec();
            expect(back.map((entity) => entity.id)).toEqual(expected.slice(1, 4));
        }
    }

    test("numeric and text sorts walk after, before, and offset pages", async () => {
        for (const kind of ["numeric", "text"] as const) {
            for (const dir of ["ASC", "DESC"] as const) {
                for (const nullsFirst of [false, true]) {
                    const expected = ordered(rows, kind, dir, nullsFirst);
                    const field = kind === "numeric" ? "score" : "name";
                    await assertPages(
                        () => base().sortBy(IdxList, field, dir, nullsFirst),
                        expected,
                        (id) => rows.find((row) => row.id === id)![kind === "numeric" ? "score" : "name"],
                    );
                }
            }
        }
    });

    test("sort with a second component and a filter matches the flagged subset", async () => {
        const flagged = rows.filter((row) => row.flagged);
        const expected = ordered(flagged, "numeric", "DESC", false);
        await assertPages(
            () => base().with(IdxFlag).sortBy(IdxList, "score", "DESC"),
            expected,
            (id) => rows.find((row) => row.id === id)!.score,
        );
    });

    test("multi-key sort breaks ties by the last key's direction", async () => {
        const sign = -1;
        const expected = [...rows].sort((a, b) => {
            const as = a.score;
            const bs = b.score;
            if (as === null && bs !== null) return 1;
            if (as !== null && bs === null) return -1;
            if (as !== null && bs !== null && as !== bs) return as < bs ? -1 : 1;
            const an = a.name;
            const bn = b.name;
            if (an === null && bn !== null) return -1;
            if (an !== null && bn === null) return 1;
            if (an !== null && bn !== null && an !== bn) return (an < bn ? -1 : 1) * sign;
            return idCmp(a, b, "DESC");
        }).map((row) => row.id);
        await assertPages(
            () => base().sortBy(IdxList, "score", "ASC").sortBy(IdxList, "name", "DESC", true),
            expected,
            (id) => {
                const row = rows.find((item) => item.id === id)!;
                return [row.score, row.name];
            },
        );
    });

    test("OR + sort, including NULLS FIRST, matches the reference", async () => {
        const expected = ordered(rows, "numeric", "ASC", true);
        const make = () => new Query()
            .with(IdxList)
            .with(or([
                { component: IdxList, filters: [Query.filter("label", FilterOp.EQ, prefix)] },
            ]))
            .sortBy(IdxList, "score", "ASC", true);
        await assertPages(make, expected, (id) => rows.find((row) => row.id === id)!.score);
    });

    test("unsorted two-component pages and count match the membership intersection", async () => {
        const expected = rows.filter((row) => row.flagged).map((row) => row.id).sort();
        const make = () => new Query()
            .with(IdxFlag, { filters: [Query.filter("bucket", FilterOp.EQ, prefix)] })
            .with(IdxList);
        const all = await make().take(100).exec();
        expect(all.map((entity) => entity.id).sort()).toEqual(expected);
        expect(await make().count()).toBe(expected.length);

        const page = await make().take(3).exec();
        expect(page.map((entity) => entity.id)).toEqual(expected.slice(0, 3));
        if (expected.length > 3) {
            const next = await make().cursor(page[page.length - 1]!.id).take(10).exec();
            expect(next.map((entity) => entity.id)).toEqual(expected.slice(3));
        }
    });

    const realPg = process.env.USE_PGLITE !== "true";
    (realPg ? test : test.skip)("indexed sort and two-component page do not seq-scan the leaf", async () => {
        const table = GenerateTableName(IdxList.name);
        const flagTable = GenerateTableName(IdxFlag.name);
        for (const [name, leaf] of [[IdxList.name, table], [IdxFlag.name, flagTable]] as const) {
            for (const spec of componentKeyIndexSpecs(name, leaf, "list")) {
                await db.unsafe(spec.createSql(false));
            }
        }
        await db.unsafe(`ANALYZE ${table}`);
        await db.unsafe(`ANALYZE ${flagTable}`);
        const scoreIndex = componentKeyIndexSpecs(IdxList.name, table, "list").find((spec) => spec.fields.join() === "score");
        expect(scoreIndex).toBeTruthy();

        await db.transaction(async (tx: SQL) => {
            await tx.unsafe("SET LOCAL enable_seqscan = off");
            const plan = await new Query(tx)
                .with(IdxList)
                .sortBy(IdxList, "score", "DESC")
                .take(5)
                .explainAnalyze(false);
            expect(plan).toContain(scoreIndex!.name);
            expect(plan).not.toMatch(new RegExp(`Seq Scan on ${table}`, "i"));
        });

        await db.transaction(async (tx: SQL) => {
            await tx.unsafe("SET LOCAL enable_seqscan = off");
            const plan = await new Query(tx)
                .with(IdxList, { filters: [Query.filter("label", FilterOp.EQ, prefix)] })
                .with(IdxFlag)
                .take(5)
                .explainAnalyze(false);
            expect(plan).not.toMatch(new RegExp(`Seq Scan on ${table}\\b`, "i"));
            expect(plan).not.toMatch(new RegExp(`Seq Scan on ${flagTable}\\b`, "i"));
        });
    }, 60_000);
});
