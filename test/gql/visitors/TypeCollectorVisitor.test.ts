import { describe, it, expect, beforeEach } from "bun:test";
import { TypeCollectorVisitor } from "../../../gql/visitors/TypeCollectorVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode, GraphQLTypeKind, OperationType } from "../../../gql/graph/GraphNode";

describe("TypeCollectorVisitor", () => {
  let visitor: TypeCollectorVisitor;

  beforeEach(() => {
    visitor = new TypeCollectorVisitor();
  });

  describe("visitTypeNode", () => {
    it("should collect type definitions", () => {
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User {\n  id: ID!\n  name: String!\n}"
      );

      visitor.visitTypeNode(typeNode);

      const results = visitor.getResults();
      expect(results.types.get("User")).toBe("type User {\n  id: ID!\n  name: String!\n}");
    });
  });

  describe("visitOperationNode", () => {
    it("should not collect anything for operation nodes", () => {
      const operationNode = new OperationNode(
        "get-user-op",
        OperationType.QUERY,
        "getUser",
        "getUser(id: ID!): User"
      );

      visitor.visitOperationNode(operationNode);

      const results = visitor.getResults();
      expect(results.types.size).toBe(0);
      expect(results.inputs.size).toBe(0);
      expect(results.scalars.size).toBe(0);
    });
  });

  describe("visitFieldNode", () => {
    it("should not collect anything for field nodes", () => {
      const fieldNode = new FieldNode(
        "user-name-field",
        "User",
        "name",
        "name: String!"
      );

      visitor.visitFieldNode(fieldNode);

      const results = visitor.getResults();
      expect(results.types.size).toBe(0);
    });
  });

  describe("visitInputNode", () => {
    it("should collect input type definitions", () => {
      const inputNode = new InputNode(
        "create-user-input",
        "CreateUserInput",
        "input CreateUserInput {\n  name: String!\n  email: String!\n}"
      );

      visitor.visitInputNode(inputNode);

      const results = visitor.getResults();
      expect(results.inputs.get("CreateUserInput")).toBe("input CreateUserInput {\n  name: String!\n  email: String!\n}");
    });
  });

  describe("visitScalarNode", () => {
    it("should collect scalar type names", () => {
      const scalarNode = new ScalarNode("date-scalar", "Date");

      visitor.visitScalarNode(scalarNode);

      const results = visitor.getResults();
      expect(results.scalars.has("Date")).toBe(true);
    });
  });

  describe("getTypeDefsString", () => {
    it("should generate complete typeDefs string", () => {
      // Add scalar
      visitor.visitScalarNode(new ScalarNode("date-scalar", "Date"));

      // Add input type
      visitor.visitInputNode(new InputNode(
        "create-user-input",
        "CreateUserInput",
        "input CreateUserInput {\n  name: String!\n}"
      ));

      // Add object type
      visitor.visitTypeNode(new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User {\n  id: ID!\n}"
      ));

      const typeDefs = visitor.getTypeDefsString();
      expect(typeDefs).toContain("scalar Date");
      expect(typeDefs).toContain("input CreateUserInput {");
      expect(typeDefs).toContain("type User {");
    });
  });

  describe("clear", () => {
    it("should clear all collected data", () => {
      visitor.visitTypeNode(new TypeNode("user-type", "User", GraphQLTypeKind.OBJECT, "type User {}"));
      visitor.visitScalarNode(new ScalarNode("date-scalar", "Date"));

      visitor.clear();

      const results = visitor.getResults();
      expect(results.types.size).toBe(0);
      expect(results.scalars.size).toBe(0);
    });
  });
});