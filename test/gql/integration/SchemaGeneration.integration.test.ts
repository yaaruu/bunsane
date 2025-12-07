import { describe, it, expect, beforeEach } from "bun:test";
import { generateGraphQLSchema, GraphQLOperation } from "../../../gql/Generator";
import { generateGraphQLSchemaV2 } from "../../../gql";
import { GraphQLSchema, printSchema } from "graphql";

// Mock services for testing
class MockUserService {
    @GraphQLOperation({ type: "Query" })
    async getUser(id: string) {
        return { id, name: "John Doe" };
    }

    @GraphQLOperation({ type: "Mutation" })
    async createUser(input: { name: string }) {
        return { id: "123", name: input.name };
    }
}

class MockProductService {
    @GraphQLOperation({ type: "Query" })
    async getProduct(id: string) {
        return { id, name: "Test Product" };
    }
}

describe("GraphQL Schema Generation Integration", () => {
    let services: any[];

    beforeEach(() => {
        services = [new MockUserService(), new MockProductService()];
    });

    describe("V1 vs V2 Compatibility", () => {
        it("should generate identical schemas with V1 and V2 implementations", () => {
            // Generate with V1
            const v1Result = generateGraphQLSchema(services, { enableArchetypeOperations: false });

            // Generate with V2
            const v2Result = generateGraphQLSchemaV2(services, { enableArchetypeOperations: false });

            // Both should succeed
            expect(v1Result.schema).toBeInstanceOf(GraphQLSchema);
            expect(v2Result.schema).toBeInstanceOf(GraphQLSchema);

            // Compare schema structure (basic check)
            expect(v1Result.schema!.getTypeMap().Query).toBeDefined();
            expect(v2Result.schema!.getTypeMap().Query).toBeDefined();

            // For now, just verify both generate valid schemas
            // TODO: Add more detailed schema comparison when V2 is feature-complete
        });

        it("should handle empty services array identically", () => {
            const v1Result = generateGraphQLSchema([], { enableArchetypeOperations: false });
            const v2Result = generateGraphQLSchemaV2([], { enableArchetypeOperations: false });

            expect(v1Result.schema).toBeNull();
            expect(v2Result.schema).toBeNull();
        });

        it("should handle services with operations", () => {
            const v1Result = generateGraphQLSchema(services, { enableArchetypeOperations: false });
            const v2Result = generateGraphQLSchemaV2(services, { enableArchetypeOperations: false });

            expect(v1Result.schema).toBeInstanceOf(GraphQLSchema);
            expect(v2Result.schema).toBeInstanceOf(GraphQLSchema);

            // Verify Query type exists in both
            expect(v1Result.schema!.getTypeMap().Query).toBeDefined();
            expect(v2Result.schema!.getTypeMap().Query).toBeDefined();

            // Verify Mutation type exists in both
            expect(v1Result.schema!.getTypeMap().Mutation).toBeDefined();
            expect(v2Result.schema!.getTypeMap().Mutation).toBeDefined();
        });
    });

    describe("Performance Comparison", () => {
        it("should complete schema generation within reasonable time", () => {
            const startTime = Date.now();

            const result = generateGraphQLSchemaV2(services, { enableArchetypeOperations: false });

            const endTime = Date.now();
            const duration = endTime - startTime;

            expect(result.schema).toBeInstanceOf(GraphQLSchema);
            expect(duration).toBeLessThan(1000); // Should complete within 1 second
        });
    });
});