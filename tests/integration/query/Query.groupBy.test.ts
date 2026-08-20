import { describe, test, expect, beforeAll } from "bun:test";
import { Query } from "../../../query/Query";
import { TestOrder, TestProduct } from "../../fixtures/components";
import { createTestContext, ensureComponentsRegistered } from "../../utils";

describe("Query.groupBy / countBy / sumBy", () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestProduct, TestOrder);
    });

    test("countBy and sumBy group without hydrating", async () => {
        const a = ctx.tracker.create();
        a.add(TestProduct, { sku: "gb-a", name: "Widget", price: 10, inStock: true });
        await a.save();
        const b = ctx.tracker.create();
        b.add(TestProduct, { sku: "gb-b", name: "Widget", price: 15, inStock: true });
        await b.save();
        const c = ctx.tracker.create();
        c.add(TestProduct, { sku: "gb-c", name: "Gadget", price: 40, inStock: true });
        await c.save();

        const counts = await new Query()
            .with(TestProduct, {
                filters: [Query.filter("sku", Query.filterOp.LIKE, "gb-%")],
            })
            .groupBy(TestProduct, "name")
            .countBy();
        const byName = Object.fromEntries(counts.map((r) => [String(r.name), Number(r.count)]));
        expect(byName.Widget).toBe(2);
        expect(byName.Gadget).toBe(1);

        const sums = await new Query()
            .with(TestProduct, {
                filters: [Query.filter("sku", Query.filterOp.LIKE, "gb-%")],
            })
            .groupBy(TestProduct, "name")
            .sumBy(TestProduct, "price");
        const sumByName = Object.fromEntries(sums.map((r) => [String(r.name), Number(r.price)]));
        expect(sumByName.Widget).toBe(25);
        expect(sumByName.Gadget).toBe(40);
    });

    test("maxBy/minBy numeric group without hydrating", async () => {
        const a = ctx.tracker.create();
        a.add(TestProduct, { sku: "mm-a", name: "Alpha", price: 10, inStock: true });
        await a.save();
        const b = ctx.tracker.create();
        b.add(TestProduct, { sku: "mm-b", name: "Alpha", price: 40, inStock: true });
        await b.save();
        const c = ctx.tracker.create();
        c.add(TestProduct, { sku: "mm-c", name: "Beta", price: 7, inStock: true });
        await c.save();

        const maxes = await new Query()
            .with(TestProduct, {
                filters: [Query.filter("sku", Query.filterOp.LIKE, "mm-%")],
            })
            .groupBy(TestProduct, "name")
            .maxBy(TestProduct, "price", { cast: "numeric" });
        const maxByName = Object.fromEntries(maxes.map((r) => [String(r.name), Number(r.price)]));
        expect(maxByName.Alpha).toBe(40);
        expect(maxByName.Beta).toBe(7);

        const mins = await new Query()
            .with(TestProduct, {
                filters: [Query.filter("sku", Query.filterOp.LIKE, "mm-%")],
            })
            .groupBy(TestProduct, "name")
            .minBy(TestProduct, "price", { cast: "numeric" });
        const minByName = Object.fromEntries(mins.map((r) => [String(r.name), Number(r.price)]));
        expect(minByName.Alpha).toBe(10);
        expect(minByName.Beta).toBe(7);
    });

    test("maxBy timestamptz + avgIntervalMinutesBy + IS_NULL", async () => {
        const t0 = new Date("2026-07-10T10:00:00.000Z");
        const t60 = new Date("2026-07-10T11:00:00.000Z");
        const tLate = new Date("2026-07-12T08:00:00.000Z");
        const tLateDone = new Date("2026-07-12T08:30:00.000Z");

        const doneA = ctx.tracker.create();
        doneA.add(TestOrder, {
            orderNumber: "gb-ord-a",
            total: 10,
            status: "done",
            createdAt: t0,
            completedAt: t60,
        });
        await doneA.save();
        const doneB = ctx.tracker.create();
        doneB.add(TestOrder, {
            orderNumber: "gb-ord-b",
            total: 20,
            status: "done",
            createdAt: tLate,
            completedAt: tLateDone,
        });
        await doneB.save();
        const open = ctx.tracker.create();
        open.add(TestOrder, {
            orderNumber: "gb-ord-c",
            total: 5,
            status: "open",
            createdAt: t0,
            completedAt: null,
        });
        await open.save();

        const last = await new Query()
            .with(TestOrder, {
                filters: [Query.filter("orderNumber", Query.filterOp.LIKE, "gb-ord-%")],
            })
            .groupBy(TestOrder, "status")
            .maxBy(TestOrder, "createdAt");
        const lastBy = Object.fromEntries(last.map((r) => [String(r.status), r.createdAt]));
        expect((lastBy.done as Date).toISOString()).toBe(tLate.toISOString());
        expect((lastBy.open as Date).toISOString()).toBe(t0.toISOString());

        const avgs = await new Query()
            .with(TestOrder, {
                filters: [
                    Query.filter("orderNumber", Query.filterOp.LIKE, "gb-ord-%"),
                    Query.filter("completedAt", Query.filterOp.IS_NOT_NULL, null),
                ],
            })
            .groupBy(TestOrder, "status")
            .avgIntervalMinutesBy(TestOrder, "createdAt", "completedAt");
        expect(avgs).toHaveLength(1);
        expect(String(avgs[0]!.status)).toBe("done");
        expect(Number(avgs[0]!.avgIntervalMinutes)).toBe(45);

        const openCount = await new Query()
            .with(TestOrder, {
                filters: [
                    Query.filter("orderNumber", Query.filterOp.LIKE, "gb-ord-%"),
                    Query.filter("completedAt", Query.filterOp.IS_NULL, null),
                ],
            })
            .count();
        expect(openCount).toBe(1);
    });
});
