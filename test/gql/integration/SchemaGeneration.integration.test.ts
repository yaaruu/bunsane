import { describe, it, expect, beforeEach } from "bun:test";
import { GraphQLOperation } from "../../../gql/Generator";
import { generateGraphQLSchemaV2 } from "../../../gql";
import { GraphQLSchema, printSchema } from "graphql";

// Mock services for testing
class MockUserService {
    @GraphQLOperation({ type: "Query", output: "String" })
    async getUser(id: string) {
        return { id, name: "John Doe" };
    }

    @GraphQLOperation({ type: "Mutation", output: "String" })
    async createUser(input: { name: string }) {
        return { id: "123", name: input.name };
    }
}

class MockProductService {
    @GraphQLOperation({ type: "Query", output: "String" })
    async getProduct(id: string) {
        return { id, name: "Test Product" };
    }
}

describe("GraphQL Schema Generation Integration", () => {
    let services: any[];

    beforeEach(() => {
        services = [new MockUserService(), new MockProductService()];
    });

    describe("V2 Schema Generation", () => {
        it("should generate valid schema with V2 implementation", () => {
            const result = generateGraphQLSchemaV2(services, { enableArchetypeOperations: false });

            expect(result.schema).toBeInstanceOf(GraphQLSchema);
            expect(result.schema!.getTypeMap().Query).toBeDefined();
        });

        it("should handle empty services array", () => {
            const result = generateGraphQLSchemaV2([], { enableArchetypeOperations: false });

            expect(result.schema).toBeNull();
        });

        it("should handle services with operations", () => {
            const result = generateGraphQLSchemaV2(services, { enableArchetypeOperations: false });

            expect(result.schema).toBeInstanceOf(GraphQLSchema);

            // Verify Query type exists
            expect(result.schema!.getTypeMap().Query).toBeDefined();

            // Verify Mutation type exists
            expect(result.schema!.getTypeMap().Mutation).toBeDefined();
        });
    });

    describe("Performance", () => {
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
