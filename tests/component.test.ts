import { describe, test, expect, beforeAll } from "bun:test";
import { BaseComponent, CompData, Component } from "../core/Components";
import type { ComponentDataType } from "../core/Components";
import { Entity } from "../core/Entity";
import App from "../core/App";
import ComponentRegistry from "../core/ComponentRegistry";

// Test component with 'value' attribute (standard assumption)
@Component
class ValueComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

// Test component with different attribute name
@Component
class CustomAttributeComponent extends BaseComponent {
    @CompData()
    customData: string = "";
}

// Test component with multiple attributes
@Component
class MultiAttributeComponent extends BaseComponent {
    @CompData()
    title: string = "";
    @CompData()
    content: string = "";
    @CompData({ indexed: true })
    category: string = "";
}

// Test component with no data attributes
@Component
class NoDataComponent extends BaseComponent {
    // No @CompData properties
}

// Test component with numeric value
@Component
class NumericComponent extends BaseComponent {
    @CompData()
    count: number = 0;
}

// Test component with boolean value
@Component
class BooleanComponent extends BaseComponent {
    @CompData()
    enabled: boolean = false;
}

describe("Component Edge Cases and Attribute Handling", () => {
    describe("Component with standard 'value' attribute", () => {
        test("should correctly identify and return value property", () => {
            const comp = new ValueComponent();
            comp.value = "test value";

            const props = comp.properties();
            expect(props).toContain("value");
            expect(props).toHaveLength(1);

            const data = comp.data();
            expect(data.value).toBe("test value");
        });
    });

    describe("Component with custom attribute name", () => {
        test("should correctly identify and return custom property", () => {
            const comp = new CustomAttributeComponent();
            comp.customData = "custom data";

            const props = comp.properties();
            expect(props).toContain("customData");
            expect(props).toHaveLength(1);

            const data = comp.data();
            expect(data.customData).toBe("custom data");
        });
    });

    describe("Component with multiple attributes", () => {
        test("should correctly identify all data properties", () => {
            const comp = new MultiAttributeComponent();
            comp.title = "Test Title";
            comp.content = "Test Content";
            comp.category = "Test Category";

            const props = comp.properties();
            expect(props).toContain("title");
            expect(props).toContain("content");
            expect(props).toContain("category");
            expect(props).toHaveLength(3);

            const indexedProps = comp.indexedProperties();
            expect(indexedProps).toContain("category");
            expect(indexedProps).toHaveLength(1);
        });

        test("should return all data in data() method", () => {
            const comp = new MultiAttributeComponent();
            comp.title = "Title";
            comp.content = "Content";
            comp.category = "Category";

            const data = comp.data();
            expect(data.title).toBe("Title");
            expect(data.content).toBe("Content");
            expect(data.category).toBe("Category");
        });
    });

    describe("Component with no data attributes", () => {
        test("should have empty properties array", () => {
            const comp = new NoDataComponent();

            const props = comp.properties();
            expect(props).toHaveLength(0);

            const data = comp.data();
            expect(Object.keys(data)).toHaveLength(0);
        });
    });

    describe("Component with numeric attribute", () => {
        test("should handle numeric values correctly", () => {
            const comp = new NumericComponent();
            comp.count = 42;

            const data = comp.data();
            expect(data.count).toBe(42);
            expect(typeof data.count).toBe("number");
        });
    });

    describe("Component with boolean attribute", () => {
        test("should handle boolean values correctly", () => {
            const comp = new BooleanComponent();
            comp.enabled = true;

            const data = comp.data();
            expect(data.enabled).toBe(true);
            expect(typeof data.enabled).toBe("boolean");
        });
    });

    describe("Component update operations", () => {
        test("should handle partial updates for multi-attribute components", () => {
            const comp = new MultiAttributeComponent();
            comp.title = "Initial Title";
            comp.content = "Initial Content";
            comp.category = "Initial Category";

            // Simulate partial update
            comp.title = "Updated Title";

            const data = comp.data();
            expect(data.title).toBe("Updated Title");
            expect(data.content).toBe("Initial Content");
            expect(data.category).toBe("Initial Category");
        });
    });

    describe("Component type safety and data integrity", () => {
        test("should maintain type safety for ComponentDataType", () => {
            const comp = new ValueComponent();
            comp.value = "test";

            const data: ComponentDataType<ValueComponent> = comp.data();
            expect(data.value).toBe("test");
            // TypeScript should prevent accessing non-existent properties
            // This test ensures the type system works correctly
        });

        test("should exclude non-data properties from data()", () => {
            const comp = new ValueComponent();
            comp.value = "test";
            // id is not a data property
            comp.id = "some-id";

            const data = comp.data();
            expect(data.value).toBe("test");
            expect((data as any).id).toBeUndefined();
        });
    });

    describe("Component registry and type identification", () => {
        test("should generate unique type IDs for different components", () => {
            const comp1 = new ValueComponent();
            const comp2 = new CustomAttributeComponent();

            expect(comp1.getTypeID()).not.toBe(comp2.getTypeID());
        });
    });

    describe("Error handling for malformed components", () => {
        test("should handle components with undefined values gracefully", () => {
            const comp = new ValueComponent();
            // value is undefined initially

            const data = comp.data();
            expect(data.value).toBe(""); // Default value
        });
    });
});