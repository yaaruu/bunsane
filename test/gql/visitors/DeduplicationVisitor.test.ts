import { describe, it, expect, beforeEach } from "bun:test";
import { DeduplicationVisitor } from "../../../gql/visitors/DeduplicationVisitor";
import { TypeNode, InputNode, ScalarNode, GraphQLTypeKind } from "../../../gql/graph/GraphNode";

describe("DeduplicationVisitor", () => {
  let visitor: DeduplicationVisitor;

  beforeEach(() => {
    visitor = new DeduplicationVisitor();
  });

  describe("visitTypeNode", () => {
    it("should mark first occurrence as unique", () => {
      const typeNode = new TypeNode(
        "user-type-1",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      visitor.visitTypeNode(typeNode);

      expect(visitor.isDuplicate("user-type-1")).toBe(false);
      expect(visitor.getUniqueTypeNames()).toContain("User");
    });

    it("should mark duplicate type names", () => {
      const typeNode1 = new TypeNode(
        "user-type-1",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      const typeNode2 = new TypeNode(
        "user-type-2",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! name: String! }"
      );

      visitor.visitTypeNode(typeNode1);
      visitor.visitTypeNode(typeNode2);

      expect(visitor.isDuplicate("user-type-1")).toBe(false);
      expect(visitor.isDuplicate("user-type-2")).toBe(true);
      expect(visitor.getDuplicateNodeIds()).toContain("user-type-2");
    });
  });

  describe("visitInputNode", () => {
    it("should detect duplicate input type names", () => {
      const inputNode1 = new InputNode(
        "create-user-input-1",
        "CreateUserInput",
        "input CreateUserInput { name: String! }"
      );

      const inputNode2 = new InputNode(
        "create-user-input-2",
        "CreateUserInput",
        "input CreateUserInput { name: String! email: String! }"
      );

      visitor.visitInputNode(inputNode1);
      visitor.visitInputNode(inputNode2);

      expect(visitor.isDuplicate("create-user-input-1")).toBe(false);
      expect(visitor.isDuplicate("create-user-input-2")).toBe(true);
    });
  });

  describe("visitScalarNode", () => {
    it("should detect duplicate scalar names", () => {
      const scalarNode1 = new ScalarNode("date-scalar-1", "Date");
      const scalarNode2 = new ScalarNode("date-scalar-2", "Date");

      visitor.visitScalarNode(scalarNode1);
      visitor.visitScalarNode(scalarNode2);

      expect(visitor.isDuplicate("date-scalar-1")).toBe(false);
      expect(visitor.isDuplicate("date-scalar-2")).toBe(true);
    });
  });

  describe("visitOperationNode and visitFieldNode", () => {
    it("should not affect deduplication tracking", () => {
      // These node types don't define new types, so they shouldn't affect deduplication
      const results = visitor.getResults();
      expect(results.uniqueTypeNames.size).toBe(0);
      expect(results.duplicateNodeIds.size).toBe(0);
    });
  });

  describe("getResults", () => {
    it("should return correct results structure", () => {
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      visitor.visitTypeNode(typeNode);

      const results = visitor.getResults();
      expect(results.uniqueTypeNames).toContain("User");
      expect(results.duplicateNodeIds.size).toBe(0);
    });
  });

  describe("getDuplicateNodeIds", () => {
    it("should return array of duplicate node IDs", () => {
      const typeNode1 = new TypeNode("type-1", "User", GraphQLTypeKind.OBJECT, "type User {}");
      const typeNode2 = new TypeNode("type-2", "User", GraphQLTypeKind.OBJECT, "type User {}");

      visitor.visitTypeNode(typeNode1);
      visitor.visitTypeNode(typeNode2);

      const duplicates = visitor.getDuplicateNodeIds();
      expect(duplicates).toContain("type-2");
      expect(duplicates).not.toContain("type-1");
    });
  });

  describe("getUniqueTypeNames", () => {
    it("should return array of unique type names", () => {
      visitor.visitTypeNode(new TypeNode("type-1", "User", GraphQLTypeKind.OBJECT, "type User {}"));
      visitor.visitScalarNode(new ScalarNode("scalar-1", "Date"));

      const uniqueNames = visitor.getUniqueTypeNames();
      expect(uniqueNames).toContain("User");
      expect(uniqueNames).toContain("Date");
      expect(uniqueNames.length).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all tracking data", () => {
      visitor.visitTypeNode(new TypeNode("type-1", "User", GraphQLTypeKind.OBJECT, "type User {}"));
      visitor.visitTypeNode(new TypeNode("type-2", "User", GraphQLTypeKind.OBJECT, "type User {}"));

      expect(visitor.getUniqueTypeNames()).toContain("User");
      expect(visitor.getDuplicateNodeIds()).toContain("type-2");

      visitor.clear();

      expect(visitor.getUniqueTypeNames().length).toBe(0);
      expect(visitor.getDuplicateNodeIds().length).toBe(0);
    });
  });
});