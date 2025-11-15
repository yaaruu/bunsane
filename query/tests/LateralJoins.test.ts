import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ComponentInclusionNode } from "../ComponentInclusionNode";
import { QueryContext } from "../QueryContext";
import { config } from "../../core/Config";

// Mock the config to control LATERAL join behavior
const originalShouldUseLateralJoins = config.shouldUseLateralJoins.bind(config);

describe("ComponentInclusionNode - LATERAL Joins", () => {
    let context: QueryContext;

    beforeEach(() => {
        context = new QueryContext();
        context.componentIds.add("test-component-1");
        context.componentFilters.set("test-component-1", [
            { field: "name", operator: "=", value: "test-value" }
        ]);
    });

    afterEach(() => {
        // Reset config mock
        config.shouldUseLateralJoins = originalShouldUseLateralJoins;
    });

    describe("LATERAL Join Generation", () => {
        it("should generate LATERAL joins when enabled", () => {
            // Mock config to return true for LATERAL joins
            config.shouldUseLateralJoins = mock(() => true);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("CROSS JOIN LATERAL");
            expect(result.sql).toContain("AS lat_test-com_name_0");
            expect(result.sql).toContain("lat_test-com_name_0 IS NOT NULL");
        });

        it("should generate EXISTS subqueries when LATERAL joins disabled", () => {
            // Mock config to return false for LATERAL joins
            config.shouldUseLateralJoins = mock(() => false);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("EXISTS (");
            expect(result.sql).not.toContain("CROSS JOIN LATERAL");
        });

        it("should handle multiple filters with LATERAL joins", () => {
            // Mock config to return true for LATERAL joins
            config.shouldUseLateralJoins = mock(() => true);

            context.componentFilters.set("test-component-1", [
                { field: "name", operator: "=", value: "test-value" },
                { field: "status", operator: "=", value: "active" }
            ]);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("CROSS JOIN LATERAL");
            expect(result.sql).toContain("AS lat_test-com_name_0");
            expect(result.sql).toContain("AS lat_test-com_status_1");
            expect(result.sql).toContain("lat_test-com_name_0 IS NOT NULL");
            expect(result.sql).toContain("lat_test-com_status_1 IS NOT NULL");
        });

        it("should handle nested JSON fields in LATERAL joins", () => {
            // Mock config to return true for LATERAL joins
            config.shouldUseLateralJoins = mock(() => true);

            context.componentFilters.set("test-component-1", [
                { field: "device.unique_id", operator: "=", value: "uuid-123" }
            ]);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("c.data->'device'->>'unique_id'");
            expect(result.sql).toContain("CROSS JOIN LATERAL");
        });

        it("should handle different operators in LATERAL joins", () => {
            // Mock config to return true for LATERAL joins
            config.shouldUseLateralJoins = mock(() => true);

            context.componentFilters.set("test-component-1", [
                { field: "name", operator: "LIKE", value: "%test%" },
                { field: "count", operator: ">", value: 5 },
                { field: "tags", operator: "IN", value: ["tag1", "tag2"] }
            ]);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("LIKE");
            expect(result.sql).toContain("::numeric >");
            expect(result.sql).toContain("IN");
            expect(result.sql).toContain("CROSS JOIN LATERAL");
        });
    });

    describe("Query Equivalence", () => {
        it("should produce equivalent results with EXISTS vs LATERAL joins", () => {
            const node = new ComponentInclusionNode();

            // Test EXISTS
            config.shouldUseLateralJoins = mock(() => false);
            const existsResult = node.execute(context.clone());

            // Test LATERAL
            config.shouldUseLateralJoins = mock(() => true);
            const lateralResult = node.execute(context.clone());

            expect(existsResult.sql).toContain("EXISTS");
            expect(lateralResult.sql).toContain("CROSS JOIN LATERAL");
            expect(existsResult.params.length).toBe(lateralResult.params.length);
        });
    });

    describe("Performance Characteristics", () => {
        it("should include LIMIT 1 in LATERAL join subqueries", () => {
            config.shouldUseLateralJoins = mock(() => true);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("LIMIT 1");
        });

        it("should properly join LATERAL results to main query", () => {
            config.shouldUseLateralJoins = mock(() => true);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            // Verify the LATERAL join is properly integrated
            expect(result.sql).toContain("CROSS JOIN LATERAL");
            expect(result.sql).toContain("AS lat_");
            expect(result.sql).toContain("FROM entity_components ec CROSS JOIN LATERAL");
            expect(result.sql).toContain("WHERE ec.type_id");
        });
    });

    describe("Error Handling", () => {
        it("should handle empty component filters gracefully", () => {
            config.shouldUseLateralJoins = mock(() => true);

            context.componentFilters.clear();
            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).not.toContain("CROSS JOIN LATERAL");
            expect(result.sql).toBeTruthy();
        });

        it("should handle special characters in field names", () => {
            config.shouldUseLateralJoins = mock(() => true);

            context.componentFilters.set("test-component-1", [
                { field: "field.with.dots", operator: "=", value: "value" }
            ]);

            const node = new ComponentInclusionNode();
            const result = node.execute(context);

            expect(result.sql).toContain("AS lat_test-com_field_with_dots_0");
        });
    });
});