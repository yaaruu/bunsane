import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ResolverBuilder } from "../../../gql/builders/ResolverBuilder";
import { GraphQLError } from "graphql";
import * as z from "zod";

describe("ResolverBuilder", () => {
  let builder: ResolverBuilder;
  let mockService: any;

  beforeEach(() => {
    builder = new ResolverBuilder();
    mockService = {
      getUser: mock(() => Promise.resolve({ id: 1, name: "John" })),
      createUser: mock(() => Promise.resolve({ id: 2, name: "Jane" })),
      updateUser: mock(() => Promise.resolve({ id: 1, name: "Updated John" })),
      deleteUser: mock(() => Promise.resolve(true)),
      userCreated: mock(() => Promise.resolve({ id: 3, name: "New User" }))
    };
  });

  describe("addResolver", () => {
    it("should add a query resolver without input", () => {
      const definition = {
        name: "getUser",
        type: "Query" as const,
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      };

      builder.addResolver(definition);

      const resolvers = builder.getResolvers();
      expect(resolvers.Query.getUser).toBeDefined();
      expect(typeof resolvers.Query.getUser).toBe("function");
    });

    it("should add a mutation resolver with input", () => {
      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      };

      builder.addResolver(definition);

      const resolvers = builder.getResolvers();
      expect(resolvers.Mutation.createUser).toBeDefined();
      expect(typeof resolvers.Mutation.createUser).toBe("function");
    });

    it("should add a subscription resolver", () => {
      const definition = {
        name: "userCreated",
        type: "Subscription" as const,
        service: mockService,
        propertyKey: "userCreated",
        hasInput: false
      };

      builder.addResolver(definition);

      const resolvers = builder.getResolvers();
      expect(resolvers.Subscription.userCreated).toBeDefined();
      expect(typeof resolvers.Subscription.userCreated).toBe("object");
      expect(resolvers.Subscription.userCreated).toHaveProperty("subscribe");
      expect(typeof resolvers.Subscription.userCreated.subscribe).toBe("function");
    });
  });

  describe("resolver execution without input", () => {
    it("should execute resolver and return result", async () => {
      const definition = {
        name: "getUser",
        type: "Query" as const,
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Query.getUser;

      const result = await resolver(null, {}, { context: true }, { info: true });

      expect(result).toEqual({ id: 1, name: "John" });
      expect(mockService.getUser).toHaveBeenCalledWith({}, { context: true }, { info: true });
    });

    it("should handle errors and throw GraphQLError", async () => {
      const errorService = {
        failingMethod: mock(() => Promise.reject(new Error("Service error")))
      };

      const definition = {
        name: "failingQuery",
        type: "Query" as const,
        service: errorService,
        propertyKey: "failingMethod",
        hasInput: false
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Query.failingQuery;

      await expect(resolver(null, {}, {}, {})).rejects.toThrow(GraphQLError);
      expect(errorService.failingMethod).toHaveBeenCalledWith({}, {}, {});
    });

    it("should re-throw existing GraphQLError", async () => {
      const gqlError = new GraphQLError("Custom error");
      const errorService = {
        failingMethod: mock(() => Promise.reject(gqlError))
      };

      const definition = {
        name: "failingQuery",
        type: "Query" as const,
        service: errorService,
        propertyKey: "failingMethod",
        hasInput: false
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Query.failingQuery;

      await expect(resolver(null, {}, {}, {})).rejects.toThrow(gqlError);
    });
  });

  describe("resolver execution with input", () => {
    it("should execute resolver with input args", async () => {
      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Mutation.createUser;

      const input = { name: "Jane", email: "jane@example.com" };
      const result = await resolver(null, { input }, { context: true }, { info: true });

      expect(result).toEqual({ id: 2, name: "Jane" });
      expect(mockService.createUser).toHaveBeenCalledWith(input, { context: true }, { info: true });
    });

    it("should handle input in args.input format", async () => {
      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Mutation.createUser;

      const input = { name: "Jane" };
      const result = await resolver(null, { input }, {}, {});

      expect(mockService.createUser).toHaveBeenCalledWith(input, {}, {});
    });

    it("should handle input in direct args format", async () => {
      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Mutation.createUser;

      const input = { name: "Jane" };
      const result = await resolver(null, input, {}, {});

      expect(mockService.createUser).toHaveBeenCalledWith(input, {}, {});
    });
  });

  describe("resolver with Zod validation", () => {
    it("should validate input with Zod schema", async () => {
      const zodSchema = {
        parse: mock((input: any) => {
          if (!input.name) throw new Error("Name required");
          return input;
        })
      };

      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        zodSchema: zodSchema as any,
        hasInput: true
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Mutation.createUser;

      const input = { name: "Jane" };
      const result = await resolver(null, { input }, {}, {});

      expect(zodSchema.parse).toHaveBeenCalledWith(input);
      expect(mockService.createUser).toHaveBeenCalledWith(input, {}, {});
    });

    it("should handle Zod validation errors", async () => {
      const zodError = new z.ZodError([{ code: 'invalid_type', expected: 'string', received: 'undefined', path: ['name'], message: 'Required' }]);

      const zodSchema = {
        parse: mock(() => {
          throw zodError;
        })
      };

      const definition = {
        name: "createUser",
        type: "Mutation" as const,
        service: mockService,
        propertyKey: "createUser",
        zodSchema: zodSchema as any,
        hasInput: true
      };

      builder.addResolver(definition);
      const resolver = builder.getResolvers().Mutation.createUser;

      // Note: The error handler will convert ZodError to GraphQLError
      await expect(resolver(null, { input: {} }, {}, {})).rejects.toThrow(GraphQLError);
      expect(zodSchema.parse).toHaveBeenCalled();
      expect(mockService.createUser).not.toHaveBeenCalled();
    });
  });

  describe("getResolversForType", () => {
    it("should return resolvers for specific type", () => {
      builder.addResolver({
        name: "getUser",
        type: "Query",
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      });

      builder.addResolver({
        name: "createUser",
        type: "Mutation",
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      });

      const queryResolvers = builder.getResolversForType("Query");
      const mutationResolvers = builder.getResolversForType("Mutation");

      expect(queryResolvers.getUser).toBeDefined();
      expect(mutationResolvers.createUser).toBeDefined();
      expect(queryResolvers.createUser).toBeUndefined();
      expect(mutationResolvers.getUser).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("should clear all resolvers", () => {
      builder.addResolver({
        name: "getUser",
        type: "Query",
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      });

      builder.clear();

      const resolvers = builder.getResolvers();
      expect(Object.keys(resolvers.Query)).toHaveLength(0);
      expect(Object.keys(resolvers.Mutation)).toHaveLength(0);
      expect(Object.keys(resolvers.Subscription)).toHaveLength(0);
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      builder.addResolver({
        name: "getUser",
        type: "Query",
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      });

      builder.addResolver({
        name: "getUsers",
        type: "Query",
        service: mockService,
        propertyKey: "getUser",
        hasInput: false
      });

      builder.addResolver({
        name: "createUser",
        type: "Mutation",
        service: mockService,
        propertyKey: "createUser",
        hasInput: true
      });

      builder.addResolver({
        name: "userCreated",
        type: "Subscription",
        service: mockService,
        propertyKey: "userCreated",
        hasInput: false
      });

      const stats = builder.getStats();
      expect(stats.queries).toBe(2);
      expect(stats.mutations).toBe(1);
      expect(stats.subscriptions).toBe(1);
    });
  });
});