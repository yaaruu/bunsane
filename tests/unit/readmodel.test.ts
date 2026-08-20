import { describe, test, expect } from "bun:test";
import { InvalidIdentifierError } from "../../query/SqlIdentifier";
import {
    parseJoinOn,
    m3TableName,
    assertM3TableName,
    ReadModel,
    Project,
    ReadModelRegistry,
    readModelMutationFields,
    buildReadModelGraphQLSDL,
    readModelResolvers,
    clampReadModelListLimit,
} from "../../core/readmodel";
import { BaseComponent } from "../../core/components/BaseComponent";
import { Component, CompData } from "../../core/components/Decorators";

describe("M3 join + table naming", () => {
    test("parses Left.fk = Right.id", () => {
        expect(parseJoinOn("Invoice.customerId = Customer.id")).toEqual({
            leftComponent: "Invoice",
            leftField: "customerId",
            rightComponent: "Customer",
        });
    });

    test("rejects SQL-shaped join strings", () => {
        expect(() => parseJoinOn("Invoice.customerId = Customer.id; DROP TABLE x")).toThrow();
        expect(() => parseJoinOn("1 = 1")).toThrow();
        expect(() => parseJoinOn("Invoice.customerId = Customer.region")).toThrow();
    });

    test("m3_ prefix cannot collide with QSP rm_", () => {
        expect(m3TableName("InvoiceReport")).toBe("m3_invoicereport");
        expect(assertM3TableName("m3_invoicereport")).toBe("m3_invoicereport");
        expect(() => assertM3TableName("rm_orderlist")).toThrow(InvalidIdentifierError);
        expect(() => assertM3TableName("components_invoice")).toThrow();
    });
});

@Component
class M3UnitInv extends BaseComponent {
    @CompData() total: number = 0;
    @CompData() status: string = "open";
    @CompData() customerId: string = "";
}

@Component
class M3UnitCust extends BaseComponent {
    @CompData() region: string = "";
}

@ReadModel({
    name: "M3UnitReport",
    from: [M3UnitInv, M3UnitCust],
    join: { on: "M3UnitInv.customerId = M3UnitCust.id" },
})
class M3UnitReport {
    @Project(M3UnitInv, "total") total!: number;
    @Project(M3UnitCust, "region") region!: string;
    @Project(M3UnitInv, "status") status!: string;
}

describe("M3 GraphQL is query-only", () => {
    test("shipped SDL has the type, live query fields, and no Mutation", () => {
        expect(ReadModelRegistry.getByName("M3UnitReport")).toBeDefined();
        expect(readModelMutationFields()).toEqual([]);
        const sdl = buildReadModelGraphQLSDL();
        expect(sdl).toContain("type M3UnitReport");
        expect(sdl).toContain("input ReadModelWhere");
        expect(sdl).toContain("type Query");
        expect(sdl).not.toMatch(/type Mutation/);
        expect(sdl).not.toMatch(/createM3UnitReport|updateM3UnitReport|deleteM3UnitReport/i);
        expect(sdl).toContain("m3UnitReports");
        expect(sdl).toContain("m3UnitReportCount");
        expect(sdl).toContain("m3UnitReportSum");
        expect(sdl).toContain("m3UnitReportAvg");
        const resolvers = readModelResolvers();
        expect(typeof resolvers.Query.m3UnitReports).toBe("function");
        expect(typeof resolvers.Query.m3UnitReportCount).toBe("function");
        expect(typeof resolvers.Query.m3UnitReportSum).toBe("function");
        expect(typeof resolvers.Query.m3UnitReportAvg).toBe("function");
    });
});

describe("M3 query API", () => {
    test("rejects unknown where ops and empty-in is a predicate not a throw", () => {
        expect(() => ReadModel(M3UnitReport).where("status", "like" as any, "paid")).toThrow(
            /Unknown ReadModel where op/
        );
        expect(() => ReadModel(M3UnitReport).where("nope", "x")).toThrow(/Unknown ReadModel field/);
        expect(() => ReadModel(M3UnitReport).whereIn("status", [])).not.toThrow();
    });

    test("list limit clamp", () => {
        expect(clampReadModelListLimit(undefined)).toBe(1000);
        expect(clampReadModelListLimit(25)).toBe(25);
        expect(clampReadModelListLimit(999999)).toBe(10000);
        expect(() => clampReadModelListLimit(-1)).toThrow();
    });
});
