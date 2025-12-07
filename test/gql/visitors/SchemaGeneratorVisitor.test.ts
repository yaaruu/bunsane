import { describe, it, expect, beforeEach } from "bun:test";
import { SchemaGeneratorVisitor } from "../../../gql/visitors/SchemaGeneratorVisitor";
import { TypeNode, OperationNode, InputNode, ScalarNode, GraphQLTypeKind, OperationType } from "../../../gql/graph/GraphNode";

describe("SchemaGeneratorVisitor", () => {
  let visitor: SchemaGeneratorVisitor;

  beforeEach(() => {
    visitor = new SchemaGeneratorVisitor();
  });

  describe("visitOperationNode", () => {
    it("should add query operations to typeDefBuilder", () => {
      const queryNode = new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );

      visitor.visitOperationNode(queryNode);

      const results = visitor.getResults();
      expect(results.typeDefs).toContain("type Query {");
      expect(results.typeDefs).toContain("getUser(id: ID!): User");
    });

    it("should add mutation operations to typeDefBuilder", () => {
      const mutationNode = new OperationNode(
        "create-user-mutation",
        "createUser",
        OperationType.MUTATION,
        "createUser(input: CreateUserInput!): User"
      );

      visitor.visitOperationNode(mutationNode);

      const results = visitor.getResults();
      expect(results.typeDefs).toContain("type Mutation {");
      expect(results.typeDefs).toContain("createUser(input: CreateUserInput!): User");
    });

    it("should add subscription operations to typeDefBuilder", () => {
      const subscriptionNode = new OperationNode(
        "user-created-sub",
        "userCreated",
        OperationType.SUBSCRIPTION,
        "userCreated: User"
      );

      visitor.visitOperationNode(subscriptionNode);

      const results = visitor.getResults();
      expect(results.typeDefs).toContain("type Subscription {");
      expect(results.typeDefs).toContain("userCreated: User");
    });
  });

  describe("visitInputNode", () => {
    it("should add input types to inputTypeBuilder", () => {
      const inputNode = new InputNode(
        "create-user-input",
        "CreateUserInput",
        "input CreateUserInput {\n  name: String!\n  email: String!\n}"
      );

      visitor.visitInputNode(inputNode);

      const results = visitor.getResults();
      expect(results.inputTypes).toContain("input CreateUserInput {");
      expect(results.inputTypes).toContain("name: String!");
      expect(results.inputTypes).toContain("email: String!");
    });
  });

  describe("visitScalarNode", () => {
    it("should collect scalar types", () => {
      const scalarNode = new ScalarNode("date-scalar", "Date");

      visitor.visitScalarNode(scalarNode);

      const results = visitor.getResults();
      expect(results.scalarTypes).toContain("Date");
    });
  });

  describe("visitTypeNode and visitFieldNode", () => {
    it("should not affect schema generation directly", () => {
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      visitor.visitTypeNode(typeNode);

      // Type nodes are handled separately (typically by archetypes)
      // So they shouldn't appear in the generated schema from this visitor
      const results = visitor.getResults();
      expect(results.typeDefs).toBe(""); // No operation types added
    });
  });

  describe("getSchemaTypeDefs", () => {
    it("should generate complete schema typeDefs", () => {
      // Add scalar
      visitor.visitScalarNode(new ScalarNode("date-scalar", "Date"));

      // Add input type
      visitor.visitInputNode(new InputNode(
        "create-user-input",
        "CreateUserInput",
        "input CreateUserInput {\n  name: String!\n}"
      ));

      // Add operations
      visitor.visitOperationNode(new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      ));

      visitor.visitOperationNode(new OperationNode(
        "create-user-mutation",
        "createUser",
        OperationType.MUTATION,
        "createUser(input: CreateUserInput!): User"
      ));

      const schema = visitor.getSchemaTypeDefs();
      expect(schema).toContain("scalar Date");
      expect(schema).toContain("input CreateUserInput {");
      expect(schema).toContain("type Query {");
      expect(schema).toContain("getUser(id: ID!): User");
      expect(schema).toContain("type Mutation {");
      expect(schema).toContain("createUser(input: CreateUserInput!): User");
    });
  });

  describe("parseInputFields", () => {
    it("should parse input type definition fields", () => {
      const typeDef = `input CreateUserInput {
  name: String!
  email: String!
  age: Int
}`;

      // Access private method through type assertion
      const visitorAny = visitor as any;
      const fields = visitorAny.parseInputFields(typeDef);

      expect(fields).toContain("name: String!");
      expect(fields).toContain("email: String!");
      expect(fields).toContain("age: Int");
      expect(fields.length).toBe(3);
    });
  });

  describe("clear", () => {
    it("should clear all builders and data", () => {
      visitor.visitScalarNode(new ScalarNode("date-scalar", "Date"));
      visitor.visitOperationNode(new OperationNode(
        "get-user-query",
        OperationType.QUERY,
        "getUser",
        "getUser(id: ID!): User"
      ));

      visitor.clear();

      const results = visitor.getResults();
      expect(results.scalarTypes.length).toBe(0);
      expect(results.typeDefs).toBe("");
      expect(results.inputTypes).toBe("");
    });
  });
});