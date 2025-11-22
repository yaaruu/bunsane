/**
 * Unit tests for FilterBuilderRegistry
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { FilterBuilderRegistry } from "../FilterBuilderRegistry";
import type { FilterBuilder, FilterResult } from "../FilterBuilder";
import { QueryContext } from "../QueryContext";

// Mock filter builder for testing
const mockFilterBuilder: FilterBuilder = (filter, alias, context) => {
    return {
        sql: `${alias}.data->>'${filter.field}' = $${context.addParam(filter.value)}`,
        addedParams: 1
    };
};

describe("FilterBuilderRegistry", () => {
    beforeEach(() => {
        // Clear registry before each test
        FilterBuilderRegistry.clear();
    });

    describe("register()", () => {
        it("should register a new filter builder", () => {
            FilterBuilderRegistry.register("test_operator", mockFilterBuilder);

            expect(FilterBuilderRegistry.has("test_operator")).toBe(true);
            expect(FilterBuilderRegistry.get("test_operator")).toBe(mockFilterBuilder);
        });

        it("should register with options and plugin name", () => {
            const options = { supportsLateral: true, requiresIndex: false };
            FilterBuilderRegistry.register("test_operator", mockFilterBuilder, options, "TestPlugin");

            expect(FilterBuilderRegistry.has("test_operator")).toBe(true);
            expect(FilterBuilderRegistry.getOptions("test_operator")).toEqual(options);
        });

        it("should throw error when registering duplicate operator", () => {
            FilterBuilderRegistry.register("duplicate_op", mockFilterBuilder);

            expect(() => {
                FilterBuilderRegistry.register("duplicate_op", mockFilterBuilder);
            }).toThrow("Filter operator 'duplicate_op' is already registered");
        });

        it("should be thread-safe (basic test)", () => {
            // This is a basic test - in a real scenario, you'd test with actual concurrency
            FilterBuilderRegistry.register("thread_test", mockFilterBuilder);
            expect(FilterBuilderRegistry.has("thread_test")).toBe(true);
        });
    });

    describe("has()", () => {
        it("should return true for registered operators", () => {
            FilterBuilderRegistry.register("exists_test", mockFilterBuilder);
            expect(FilterBuilderRegistry.has("exists_test")).toBe(true);
        });

        it("should return false for unregistered operators", () => {
            expect(FilterBuilderRegistry.has("nonexistent")).toBe(false);
        });
    });

    describe("get()", () => {
        it("should return the registered builder function", () => {
            FilterBuilderRegistry.register("get_test", mockFilterBuilder);
            expect(FilterBuilderRegistry.get("get_test")).toBe(mockFilterBuilder);
        });

        it("should return undefined for unregistered operators", () => {
            expect(FilterBuilderRegistry.get("nonexistent")).toBeUndefined();
        });
    });

    describe("getOptions()", () => {
        it("should return options for registered operators", () => {
            const options = { complexityScore: 5 };
            FilterBuilderRegistry.register("options_test", mockFilterBuilder, options);

            expect(FilterBuilderRegistry.getOptions("options_test")).toEqual(options);
        });

        it("should return undefined for operators without options", () => {
            FilterBuilderRegistry.register("no_options", mockFilterBuilder);
            expect(FilterBuilderRegistry.getOptions("no_options")).toBeUndefined();
        });
    });

    describe("unregister()", () => {
        it("should remove registered operators", () => {
            FilterBuilderRegistry.register("unregister_test", mockFilterBuilder);
            expect(FilterBuilderRegistry.has("unregister_test")).toBe(true);

            const removed = FilterBuilderRegistry.unregister("unregister_test");
            expect(removed).toBe(true);
            expect(FilterBuilderRegistry.has("unregister_test")).toBe(false);
        });

        it("should return false for unregistered operators", () => {
            const removed = FilterBuilderRegistry.unregister("nonexistent");
            expect(removed).toBe(false);
        });
    });

    describe("listRegistered()", () => {
        it("should return empty array when no operators registered", () => {
            const list = FilterBuilderRegistry.listRegistered();
            expect(list).toEqual([]);
        });

        it("should return registered operators with metadata", () => {
            const options = { supportsLateral: true };
            FilterBuilderRegistry.register("list_test1", mockFilterBuilder, options, "Plugin1");
            FilterBuilderRegistry.register("list_test2", mockFilterBuilder, undefined, "Plugin2");

            const list = FilterBuilderRegistry.listRegistered();

            expect(list).toHaveLength(2);
            expect(list).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        operator: "list_test1",
                        options,
                        registeredBy: "Plugin1",
                        registeredAt: expect.any(Date)
                    }),
                    expect.objectContaining({
                        operator: "list_test2",
                        options: undefined,
                        registeredBy: "Plugin2",
                        registeredAt: expect.any(Date)
                    })
                ])
            );
        });
    });

    describe("clear()", () => {
        it("should remove all registered operators", () => {
            FilterBuilderRegistry.register("clear_test1", mockFilterBuilder);
            FilterBuilderRegistry.register("clear_test2", mockFilterBuilder);

            expect(FilterBuilderRegistry.has("clear_test1")).toBe(true);
            expect(FilterBuilderRegistry.has("clear_test2")).toBe(true);

            FilterBuilderRegistry.clear();

            expect(FilterBuilderRegistry.has("clear_test1")).toBe(false);
            expect(FilterBuilderRegistry.has("clear_test2")).toBe(false);
        });
    });

    describe("integration with QueryContext", () => {
        it("should work with QueryContext parameter management", () => {
            const context = new QueryContext();
            const initialParamCount = context.params.length;

            FilterBuilderRegistry.register("context_test", mockFilterBuilder);

            const filter = { field: "test_field", operator: "context_test", value: "test_value" };
            const result = FilterBuilderRegistry.get("context_test")!(filter, "c", context);

            expect(result.addedParams).toBe(1);
            expect(context.params.length).toBe(initialParamCount + 1);
            expect(context.params[context.params.length - 1]).toBe("test_value");
        });
    });
});