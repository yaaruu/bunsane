import { describe, it, expect, beforeAll, mock } from "bun:test";
import Query from "../core/Query";
import { BaseComponent, CompData, Component } from "../core/Components";
import ComponentRegistry from "../core/ComponentRegistry";

// Define test components
@Component
class TestUserComponent extends BaseComponent {
    @CompData()
    name: string = "";

    @CompData()
    age: number = 0;

    @CompData()
    score: number = 0;
}

@Component
class TestPostComponent extends BaseComponent {
    @CompData()
    title: string = "";

    @CompData()
    createdAt: string = "";
}

describe("Query Sorting", () => {
    beforeAll(() => {
        // Mock ComponentRegistry for testing
        mock.restore();

        // Mock the getComponentId method to return predictable IDs
        (ComponentRegistry as any).getComponentId = mock((name: string) => {
            if (name === "TestUserComponent") return "test-user-type-id";
            if (name === "TestPostComponent") return "test-post-type-id";
            return undefined;
        });
    });

    it("should create a query with sortBy method", () => {
        const query = new Query();
        const result = query.with(TestUserComponent).sortBy(TestUserComponent, "age", "DESC");

        expect(result).toBeInstanceOf(Query);
        expect((result as any).sortOrders).toHaveLength(1);
        expect((result as any).sortOrders[0]).toEqual({
            component: "TestUserComponent",
            property: "age",
            direction: "DESC",
            nullsFirst: false
        });
    });

    it("should validate component is included in query before sorting", () => {
        const query = new Query();

        expect(() => {
            query.sortBy(TestUserComponent, "age");
        }).toThrow("Cannot sort by component TestUserComponent that is not included in the query");
    });

    it("should support orderBy with multiple sort orders", () => {
        const query = new Query();
        const sortOrders = [
            { component: "TestUserComponent", property: "age", direction: "DESC" as const },
            { component: "TestUserComponent", property: "name", direction: "ASC" as const }
        ];

        const result = query.with(TestUserComponent).orderBy(sortOrders);

        expect((result as any).sortOrders).toEqual(sortOrders);
    });

    it("should build correct ORDER BY clause for sorting", () => {
        const query = new Query();
        query.with(TestUserComponent).sortBy(TestUserComponent, "age", "DESC");

        const orderByClause = (query as any).buildOrderByClause(["test-user-type-id"]);

        expect(orderByClause).toContain("ORDER BY");
        expect(orderByClause).toContain("DESC");
        expect(orderByClause).toContain("ec.entity_id ASC");
    });

    it("should handle nulls first option", () => {
        const query = new Query();
        query.with(TestUserComponent).sortBy(TestUserComponent, "age", "ASC", true);

        expect((query as any).sortOrders[0].nullsFirst).toBe(true);
    });

    it("should build ORDER BY clause with nulls first", () => {
        const query = new Query();
        query.with(TestUserComponent).sortBy(TestUserComponent, "age", "ASC", true);

        const orderByClause = (query as any).buildOrderByClause(["test-user-type-id"]);

        expect(orderByClause).toContain("NULLS FIRST");
    });
});