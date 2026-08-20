import "reflect-metadata";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import db from "../../database";
import { Entity } from "../../core/Entity";
import { BaseComponent } from "../../core/components/BaseComponent";
import { Component, CompData } from "../../core/components/Decorators";
import { graphql } from "graphql";
import { createSchema } from "graphql-yoga";
import {
    ReadModel,
    Project,
    ReadModelRegistry,
    buildReadModelGraphQLSDL,
    readModelMutationFields,
    readModelResolvers,
} from "../../core/readmodel";
import { ReadModelManager, readModelScanTable } from "../../database/readmodel";
import { createTestContext, ensureComponentsRegistered } from "../utils";

@Component
class M3InvComp extends BaseComponent {
    @CompData() total: number = 0;
    @CompData() status: string = "open";
    @CompData() customerId: string = "";
    @CompData() paidAt: Date = new Date(0);
}

@Component
class M3CustComp extends BaseComponent {
    @CompData() region: string = "";
}

@ReadModel({
    name: "M3InvoiceReport",
    from: [M3InvComp, M3CustComp],
    join: { on: "M3InvComp.customerId = M3CustComp.id" },
    refresh: "sync",
    rebuildable: true,
})
class M3InvoiceReport {
    @Project(M3InvComp, "total") total!: number;
    @Project(M3CustComp, "region") region!: string;
    @Project(M3InvComp, "status") status!: string;
    @Project(M3InvComp, "paidAt") paidAt!: Date;
}

describe("RFC M3 read model (cross-entity join)", () => {
    const ctx = createTestContext();
    const desc = ReadModelRegistry.requireByCtor(M3InvoiceReport);
    const table = desc.tableName;

    beforeAll(async () => {
        await ensureComponentsRegistered(M3InvComp, M3CustComp);
        await db.unsafe(`CREATE TABLE IF NOT EXISTS m3_readmodel_state (
            name text PRIMARY KEY,
            shape_hash text NOT NULL,
            status text NOT NULL DEFAULT 'READY',
            shape_version int NOT NULL DEFAULT 1,
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await db.unsafe(`DROP TABLE IF EXISTS ${table}`);
        await db.unsafe(`DELETE FROM m3_readmodel_state WHERE name = $1`, [desc.name]);
        ReadModelManager.reset();
        await ReadModelManager.instance.initialize();
    });

    afterAll(async () => {
        ReadModelManager.reset();
        await db.unsafe(`DROP TABLE IF EXISTS ${table}`);
        await db.unsafe(`DELETE FROM m3_readmodel_state WHERE name = $1`, [desc.name]);
    });

    test("derived GraphQL type has no Mutation fields", () => {
        expect(readModelMutationFields()).toEqual([]);
        const sdl = buildReadModelGraphQLSDL();
        expect(sdl).toContain("type M3InvoiceReport");
        expect(sdl).toMatch(/type Query/);
        expect(sdl).not.toMatch(/type Mutation/);
        expect(sdl).not.toMatch(/createM3InvoiceReport|updateM3InvoiceReport|deleteM3InvoiceReport/i);
    });

    test("save of two related entities writes the joined row; groupBy+sum is SQL", async () => {
        const westA = 10;
        const westB = 20;
        const eastA = 5;

        const cWest = ctx.tracker.create();
        cWest.add(M3CustComp, { region: "west" });
        await cWest.save();
        const cEast = ctx.tracker.create();
        cEast.add(M3CustComp, { region: "east" });
        await cEast.save();

        const i1 = ctx.tracker.create();
        i1.add(M3InvComp, { total: westA, status: "paid", customerId: cWest.id });
        await i1.save();
        const i2 = ctx.tracker.create();
        i2.add(M3InvComp, { total: westB, status: "paid", customerId: cWest.id });
        await i2.save();
        const i3 = ctx.tracker.create();
        i3.add(M3InvComp, { total: eastA, status: "paid", customerId: cEast.id });
        await i3.save();

        const joined = await db.unsafe(
            `SELECT left_entity_id, right_entity_id, total, region, status FROM ${table} WHERE deleted_at IS NULL ORDER BY total`
        );
        expect(joined.length).toBe(3);
        expect(joined.map((r: any) => Number(r.total)).sort((a: number, b: number) => a - b)).toEqual(
            [eastA, westA, westB]
        );
        expect(joined.every((r: any) => r.right_entity_id === cWest.id || r.right_entity_id === cEast.id)).toBe(true);

        const grouped = await ReadModel(M3InvoiceReport).where("status", "paid").groupBy("region").sum("total");
        expect(Array.isArray(grouped)).toBe(true);
        const byRegion = Object.fromEntries(
            (grouped as Array<Record<string, unknown>>).map((r) => [String(r.region), Number(r.total)])
        );
        expect(byRegion.west).toBe(westA + westB);
        expect(byRegion.east).toBe(eastA);

        const newWestB = 50;
        await i2.set(M3InvComp, { total: newWestB });
        await i2.save();
        const afterUpdate = await ReadModel(M3InvoiceReport).where("status", "paid").groupBy("region").sum("total");
        const byRegion2 = Object.fromEntries(
            (afterUpdate as Array<Record<string, unknown>>).map((r) => [String(r.region), Number(r.total)])
        );
        expect(byRegion2.west).toBe(westA + newWestB);

        await i3.delete(true);
        const afterDelete = await ReadModel(M3InvoiceReport).where("status", "paid").groupBy("region").sum("total");
        const byRegion3 = Object.fromEntries(
            (afterDelete as Array<Record<string, unknown>>).map((r) => [String(r.region), Number(r.total)])
        );
        expect(byRegion3.east).toBeUndefined();
        expect(byRegion3.west).toBe(westA + newWestB);

        // Rebuild-from-JSONB matches live rows even if dual-write was off.
        ReadModelManager.instance.dualWrite = false;
        const extra = 7;
        const i4 = ctx.tracker.create();
        i4.add(M3InvComp, { total: extra, status: "paid", customerId: cWest.id });
        await i4.save();
        const beforeRebuild = await db.unsafe(
            `SELECT COUNT(*)::int AS n FROM ${table} WHERE left_entity_id = $1 AND deleted_at IS NULL`,
            [i4.id]
        );
        expect(Number(beforeRebuild[0].n)).toBe(0);

        ReadModelManager.instance.dualWrite = true;
        await ReadModelManager.instance.rebuild(desc);
        const rebuilt = await ReadModel(M3InvoiceReport).where("status", "paid").groupBy("region").sum("total");
        const byRegion4 = Object.fromEntries(
            (rebuilt as Array<Record<string, unknown>>).map((r) => [String(r.region), Number(r.total)])
        );
        expect(byRegion4.west).toBe(westA + newWestB + extra);
    });

    test("range, IN, count, avg are SQL; covering indexes exist; GraphQL resolvers run", async () => {
        const start = new Date("2026-08-01T00:00:00.000Z");
        const mid = new Date("2026-08-10T00:00:00.000Z");
        const end = new Date("2026-08-20T00:00:00.000Z");
        const after = new Date("2026-08-25T00:00:00.000Z");

        const cust = ctx.tracker.create();
        cust.add(M3CustComp, { region: "north" });
        await cust.save();

        const a = ctx.tracker.create();
        a.add(M3InvComp, { total: 10, status: "ranged", customerId: cust.id, paidAt: start });
        await a.save();
        const b = ctx.tracker.create();
        b.add(M3InvComp, { total: 30, status: "ranged", customerId: cust.id, paidAt: mid });
        await b.save();
        const c = ctx.tracker.create();
        c.add(M3InvComp, { total: 50, status: "voided", customerId: cust.id, paidAt: after });
        await c.save();

        const ranged = await ReadModel(M3InvoiceReport)
            .where("status", "ranged")
            .where("paidAt", "gte", start)
            .where("paidAt", "lte", end)
            .sum("total");
        expect(ranged).toBe(40);

        const inSum = await ReadModel(M3InvoiceReport).whereIn("status", ["ranged", "voided"]).sum("total");
        expect(inSum).toBe(90);

        expect(await ReadModel(M3InvoiceReport).whereIn("status", []).count()).toBe(0);
        expect(await ReadModel(M3InvoiceReport).where("status", "ranged").count()).toBe(2);
        expect(await ReadModel(M3InvoiceReport).where("status", "ranged").avg("total")).toBe(20);

        const byDay = (await ReadModel(M3InvoiceReport)
            .where("status", "ranged")
            .timeBucket("paidAt", "day", 0)
            .sum("total")) as Array<Record<string, unknown>>;
        const dayMap = Object.fromEntries(byDay.map((r) => [String(r.bucket), Number(r.total)]));
        expect(dayMap["2026-08-01"]).toBe(10);
        expect(dayMap["2026-08-10"]).toBe(30);

        const scan = readModelScanTable("M3InvComp");
        expect(scan === "components_m3invcomp" || scan === "components").toBe(true);

        const indexes = await db.unsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
            [table]
        );
        const names = (indexes as Array<{ indexname: string }>).map((r) => r.indexname);
        expect(names.some((n) => n.includes("__cover"))).toBe(true);
        expect(names.some((n) => n.includes("__right"))).toBe(true);
        expect(names.some((n) => n.includes("paidat"))).toBe(true);

        const schema = createSchema({
            typeDefs: buildReadModelGraphQLSDL(),
            resolvers: {
                Date: {
                    serialize: (value: unknown) =>
                        value instanceof Date ? value.toISOString() : value,
                },
                ...readModelResolvers(),
            },
        });
        const gql = await graphql({
            schema,
            source: `query {
                m3InvoiceReportCount(where: [{ field: "status", op: "eq", value: "ranged" }])
                m3InvoiceReportSum(
                    metric: "total"
                    groupBy: "region"
                    where: [
                        { field: "status", value: "ranged" }
                        { field: "paidAt", op: "gte", value: "2026-08-01T00:00:00.000Z" }
                        { field: "paidAt", op: "lte", value: "2026-08-20T00:00:00.000Z" }
                    ]
                ) { region total }
            }`,
        });
        expect(gql.errors).toBeUndefined();
        const data = gql.data as any;
        expect(data.m3InvoiceReportCount).toBe(2);
        expect(Number(data.m3InvoiceReportSum[0].total)).toBe(40);
        expect(data.m3InvoiceReportSum[0].region).toBe("north");
    });

    test("soft-delete of the right entity is not resurrected by a later left save", async () => {
        const cust = ctx.tracker.create();
        cust.add(M3CustComp, { region: "ghost" });
        await cust.save();
        const inv = ctx.tracker.create();
        inv.add(M3InvComp, {
            total: 7,
            status: "right-del",
            customerId: cust.id,
            paidAt: new Date("2026-08-05T00:00:00.000Z"),
        });
        await inv.save();
        expect(await ReadModel(M3InvoiceReport).where("status", "right-del").count()).toBe(1);

        await cust.delete();
        expect(await ReadModel(M3InvoiceReport).where("status", "right-del").count()).toBe(0);

        await inv.set(M3InvComp, { total: 99 });
        await inv.save();
        expect(await ReadModel(M3InvoiceReport).where("status", "right-del").count()).toBe(0);
    });
});
