/**
 * Default-cap truncation flag and entity-column sort pages.
 *
 * sortByCreatedAt must return created_at order for .take() pages (including
 * a 'before' keyset page) without depending on a materialized id subquery.
 */
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Query, FilterOp } from "../../../query/Query";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import { createTestContext, ensureComponentsRegistered } from "../../utils";

@Component
class CapSortProbe extends BaseComponent {
    @CompData({ indexed: true }) label: string = "";
    @CompData() idx: number = 0;
}

describe("Query default cap and createdAt pages", () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(CapSortProbe);
    });

    test("unbounded exec sets truncatedByDefaultLimit when the cap binds", async () => {
        const prevLimit = process.env.BUNSANE_DEFAULT_QUERY_LIMIT;
        const prevEnv = process.env.NODE_ENV;
        process.env.BUNSANE_DEFAULT_QUERY_LIMIT = "2";
        delete process.env.NODE_ENV;
        const prefix = `cap-${Date.now().toString(36)}`;
        try {
            for (let i = 0; i < 3; i++) {
                const entity = ctx.tracker.create();
                entity.add(CapSortProbe, { label: prefix, idx: i });
                await entity.save();
            }
            const q = new Query().with(CapSortProbe, {
                filters: [Query.filter("label", FilterOp.EQ, prefix)],
            });
            const rows = await q.exec();
            expect(rows.length).toBe(2);
            expect(q.getLastRouteInfo().truncatedByDefaultLimit).toBe(true);

            const paged = new Query()
                .with(CapSortProbe, { filters: [Query.filter("label", FilterOp.EQ, prefix)] })
                .take(2);
            const page = await paged.exec();
            expect(page.length).toBe(2);
            expect(paged.getLastRouteInfo().truncatedByDefaultLimit).toBeUndefined();

            process.env.NODE_ENV = "development";
            const dev = new Query().with(CapSortProbe, {
                filters: [Query.filter("label", FilterOp.EQ, prefix)],
            });
            await expect(dev.exec()).rejects.toThrow("framework default cap");
            expect(dev.getLastRouteInfo().truncatedByDefaultLimit).toBe(true);
        } finally {
            if (prevLimit === undefined) delete process.env.BUNSANE_DEFAULT_QUERY_LIMIT;
            else process.env.BUNSANE_DEFAULT_QUERY_LIMIT = prevLimit;
            if (prevEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prevEnv;
        }
    });

    test("sortByCreatedAt take returns created_at order and before walks back", async () => {
        const prefix = `espage-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const entity = ctx.tracker.create();
            entity.add(CapSortProbe, { label: prefix, idx: i });
            await entity.save();
            ids.push(entity.id);
        }
        for (let i = 0; i < ids.length; i++) {
            const created = new Date(Date.UTC(2024, 3, 1, 0, 0, i)).toISOString();
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [created, ids[i]],
            );
        }

        const scoped = () => new Query().with(CapSortProbe, {
            filters: [Query.filter("label", FilterOp.EQ, prefix)],
        });

        const page1 = await scoped().sortByCreatedAt("ASC").take(2).exec();
        const page2 = await scoped().sortByCreatedAt("ASC").take(2).offset(2).exec();
        expect(page1.map((e) => e.id)).toEqual(ids.slice(0, 2));
        expect(page2.map((e) => e.id)).toEqual(ids.slice(2, 4));

        const cursorRow = page2[0]!;
        const createdAt = await ctx.db.unsafe<{ created_at: Date }[]>(
            `SELECT created_at FROM entities WHERE id = $1`,
            [cursorRow.id],
        );
        const token = Query.encodeSortedCursor(createdAt[0]!.created_at, cursorRow.id);
        const before = await scoped().sortByCreatedAt("ASC").sortedCursor(token, "before").take(2).exec();
        expect(before.map((e) => e.id)).toEqual(ids.slice(0, 2));
    });
});
