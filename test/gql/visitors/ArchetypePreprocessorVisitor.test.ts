import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ArchetypePreprocessorVisitor } from "../../../gql/visitors/ArchetypePreprocessorVisitor";
import { TypeNode, GraphQLTypeKind } from "../../../gql/graph/GraphNode";

// Mock the archetype functions
const mockWeaveAllArchetypes = mock(() => "mocked-schema");
const mockGetAllArchetypeSchemas = mock(() => ["schema1", "schema2"]);

mock.module("../../../core/ArcheType", () => ({
  weaveAllArchetypes: mockWeaveAllArchetypes,
  getAllArchetypeSchemas: mockGetAllArchetypeSchemas
}));

describe("ArchetypePreprocessorVisitor", () => {
  let visitor: ArchetypePreprocessorVisitor;

  beforeEach(() => {
    visitor = new ArchetypePreprocessorVisitor();
  });

  describe("beforeVisit", () => {
    it("should call weaveAllArchetypes and get archetype schemas", () => {
      visitor.beforeVisit();

      const results = visitor.getResults();
      expect(results.archetypeSchemas).toEqual(["schema1", "schema2"]);
    });
  });

  describe("visitTypeNode", () => {
    it("should mark archetype types as processed", () => {
      const archetypeTypeNode = new TypeNode(
        "user-archetype",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! name: String! }",
        { isArchetype: true }
      );

      visitor.visitTypeNode(archetypeTypeNode);

      expect(visitor.isArchetypeProcessed("User")).toBe(true);
      expect(visitor.getProcessedArchetypes()).toContain("User");
    });

    it("should not mark non-archetype types as processed", () => {
      const regularTypeNode = new TypeNode(
        "custom-type",
        "CustomType",
        GraphQLTypeKind.OBJECT,
        "type CustomType { value: String! }"
      );

      visitor.visitTypeNode(regularTypeNode);

      expect(visitor.isArchetypeProcessed("CustomType")).toBe(false);
      expect(visitor.getProcessedArchetypes().length).toBe(0);
    });
  });

  describe("visitOperationNode, visitFieldNode, visitInputNode, visitScalarNode", () => {
    it("should not affect processing for non-type nodes", () => {
      // These visits should not change the state
      const results = visitor.getResults();
      expect(results.processedArchetypes.length).toBe(0);
      expect(results.archetypeSchemas.length).toBe(0);
    });
  });

  describe("getResults", () => {
    it("should return correct results structure", () => {
      visitor.beforeVisit();

      const archetypeTypeNode = new TypeNode(
        "user-archetype",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }",
        { isArchetype: true }
      );

      visitor.visitTypeNode(archetypeTypeNode);

      const results = visitor.getResults();
      expect(results.processedArchetypes).toContain("User");
      expect(results.archetypeSchemas).toEqual(["schema1", "schema2"]);
    });
  });

  describe("isArchetypeProcessed", () => {
    it("should return true for processed archetypes", () => {
      const archetypeTypeNode = new TypeNode(
        "product-archetype",
        "Product",
        GraphQLTypeKind.OBJECT,
        "type Product { id: ID! }",
        { isArchetype: true }
      );

      visitor.visitTypeNode(archetypeTypeNode);

      expect(visitor.isArchetypeProcessed("Product")).toBe(true);
      expect(visitor.isArchetypeProcessed("NonExistent")).toBe(false);
    });
  });

  describe("getProcessedArchetypes", () => {
    it("should return array of processed archetype names", () => {
      const archetype1 = new TypeNode(
        "user-archetype",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }",
        { isArchetype: true }
      );

      const archetype2 = new TypeNode(
        "product-archetype",
        "Product",
        GraphQLTypeKind.OBJECT,
        "type Product { id: ID! }",
        { isArchetype: true }
      );

      visitor.visitTypeNode(archetype1);
      visitor.visitTypeNode(archetype2);

      const processed = visitor.getProcessedArchetypes();
      expect(processed).toContain("User");
      expect(processed).toContain("Product");
      expect(processed.length).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all processed data", () => {
      visitor.beforeVisit();

      const archetypeTypeNode = new TypeNode(
        "user-archetype",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }",
        { isArchetype: true }
      );

      visitor.visitTypeNode(archetypeTypeNode);

      expect(visitor.getProcessedArchetypes().length).toBe(1);
      expect(visitor.getResults().archetypeSchemas.length).toBe(2);

      visitor.clear();

      expect(visitor.getProcessedArchetypes().length).toBe(0);
      expect(visitor.getResults().archetypeSchemas.length).toBe(0);
    });
  });
});