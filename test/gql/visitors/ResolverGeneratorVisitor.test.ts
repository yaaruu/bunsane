import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ResolverGeneratorVisitor } from "../../../gql/visitors/ResolverGeneratorVisitor";
import { OperationNode, OperationType } from "../../../gql/graph/GraphNode";

describe("ResolverGeneratorVisitor", () => {
  let visitor: ResolverGeneratorVisitor;
  let mockService: any;

  beforeEach(() => {
    visitor = new ResolverGeneratorVisitor();
    mockService = {
      getUser: mock(() => Promise.resolve({ id: 1, name: "John" })),
      createUser: mock(() => Promise.resolve({ id: 2, name: "Jane" })),
      userCreated: mock(() => Promise.resolve({ id: 3, name: "New User" }))
    };
  });

  describe("visitOperationNode", () => {
    it("should add query resolver", () => {
      const queryNode = new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );

      // Add metadata that would be set by the scanner
      queryNode.metadata.service = mockService;
      queryNode.metadata.propertyKey = "getUser";
      queryNode.metadata.hasInput = false;

      visitor.visitOperationNode(queryNode);

      const resolvers = visitor.getResults();
      expect(resolvers.Query.getUser).toBeDefined();
      expect(typeof resolvers.Query.getUser).toBe("function");
    });

    it("should add mutation resolver with input", () => {
      const mutationNode = new OperationNode(
        "create-user-mutation",
        "createUser",
        OperationType.MUTATION,
        "createUser(input: CreateUserInput!): User"
      );

      mutationNode.metadata.service = mockService;
      mutationNode.metadata.propertyKey = "createUser";
      mutationNode.metadata.hasInput = true;

      visitor.visitOperationNode(mutationNode);

      const resolvers = visitor.getResults();
      expect(resolvers.Mutation.createUser).toBeDefined();
      expect(typeof resolvers.Mutation.createUser).toBe("function");
    });

    it("should add subscription resolver", () => {
      const subscriptionNode = new OperationNode(
        "user-created-sub",
        "userCreated",
        OperationType.SUBSCRIPTION,
        "userCreated: User"
      );

      subscriptionNode.metadata.service = mockService;
      subscriptionNode.metadata.propertyKey = "userCreated";
      subscriptionNode.metadata.hasInput = false;

      visitor.visitOperationNode(subscriptionNode);

      const resolvers = visitor.getResults();
      expect(resolvers.Subscription.userCreated).toBeDefined();
      expect(typeof resolvers.Subscription.userCreated).toBe("function");
    });
  });

  describe("visitTypeNode, visitFieldNode, visitInputNode, visitScalarNode", () => {
    it("should not create resolvers for non-operation nodes", () => {
      // These visits should not affect the resolvers
      const results = visitor.getResults();
      expect(Object.keys(results.Query).length).toBe(0);
      expect(Object.keys(results.Mutation).length).toBe(0);
      expect(Object.keys(results.Subscription).length).toBe(0);
    });
  });

  describe("getResolversForType", () => {
    it("should return resolvers for specific type", () => {
      const queryNode = new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );
      queryNode.metadata.service = mockService;
      queryNode.metadata.propertyKey = "getUser";

      const mutationNode = new OperationNode(
        "create-user-mutation",
        "createUser",
        OperationType.MUTATION,
        "createUser(input: CreateUserInput!): User"
      );
      mutationNode.metadata.service = mockService;
      mutationNode.metadata.propertyKey = "createUser";

      visitor.visitOperationNode(queryNode);
      visitor.visitOperationNode(mutationNode);

      const queryResolvers = visitor.getResolversForType("Query");
      const mutationResolvers = visitor.getResolversForType("Mutation");
      const subscriptionResolvers = visitor.getResolversForType("Subscription");

      expect(queryResolvers.getUser).toBeDefined();
      expect(mutationResolvers.createUser).toBeDefined();
      expect(subscriptionResolvers.userCreated).toBeUndefined();
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      const queryNode = new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );
      queryNode.metadata.service = mockService;
      queryNode.metadata.propertyKey = "getUser";

      const mutationNode = new OperationNode(
        "create-user-mutation",
        "createUser",
        OperationType.MUTATION,
        "createUser(input: CreateUserInput!): User"
      );
      mutationNode.metadata.service = mockService;
      mutationNode.metadata.propertyKey = "createUser";

      const subscriptionNode = new OperationNode(
        "user-created-sub",
        "userCreated",
        OperationType.SUBSCRIPTION,
        "userCreated: User"
      );
      subscriptionNode.metadata.service = mockService;
      subscriptionNode.metadata.propertyKey = "userCreated";

      visitor.visitOperationNode(queryNode);
      visitor.visitOperationNode(mutationNode);
      visitor.visitOperationNode(subscriptionNode);

      const stats = visitor.getStats();
      expect(stats.queries).toBe(1);
      expect(stats.mutations).toBe(1);
      expect(stats.subscriptions).toBe(1);
    });
  });

  describe("clear", () => {
    it("should clear all resolver data", () => {
      const queryNode = new OperationNode(
        "get-user-query",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );
      queryNode.metadata.service = mockService;
      queryNode.metadata.propertyKey = "getUser";

      visitor.visitOperationNode(queryNode);

      expect(visitor.getStats().queries).toBe(1);

      visitor.clear();

      expect(visitor.getStats().queries).toBe(0);
    });
  });
});