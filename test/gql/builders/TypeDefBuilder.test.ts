import { describe, it, expect, beforeEach } from "bun:test";
import { TypeDefBuilder } from "../../../gql/builders/TypeDefBuilder";

describe("TypeDefBuilder", () => {
  let builder: TypeDefBuilder;

  beforeEach(() => {
    builder = new TypeDefBuilder();
  });

  describe("addQueryField", () => {
    it("should add a query field", () => {
      const field = { name: "getUser", fieldDef: "getUser(id: ID!): User" };
      builder.addQueryField(field);

      const typeDef = builder.buildQueryType();
      expect(typeDef).toContain("type Query {");
      expect(typeDef).toContain("getUser(id: ID!): User");
      expect(typeDef).toContain("}");
    });

    it("should sort query fields alphabetically", () => {
      builder.addQueryField({ name: "zField", fieldDef: "zField: String" });
      builder.addQueryField({ name: "aField", fieldDef: "aField: String" });
      builder.addQueryField({ name: "mField", fieldDef: "mField: String" });

      const typeDef = builder.buildQueryType();
      const lines = typeDef.split('\n');
      expect(lines[1]).toContain("aField: String");
      expect(lines[2]).toContain("mField: String");
      expect(lines[3]).toContain("zField: String");
    });
  });

  describe("addMutationField", () => {
    it("should add a mutation field", () => {
      const field = { name: "createUser", fieldDef: "createUser(input: CreateUserInput!): User" };
      builder.addMutationField(field);

      const typeDef = builder.buildMutationType();
      expect(typeDef).toContain("type Mutation {");
      expect(typeDef).toContain("createUser(input: CreateUserInput!): User");
      expect(typeDef).toContain("}");
    });

    it("should sort mutation fields alphabetically", () => {
      builder.addMutationField({ name: "zField", fieldDef: "zField: String" });
      builder.addMutationField({ name: "aField", fieldDef: "aField: String" });

      const typeDef = builder.buildMutationType();
      const lines = typeDef.split('\n');
      expect(lines[1]).toContain("aField: String");
      expect(lines[2]).toContain("zField: String");
    });
  });

  describe("addSubscriptionField", () => {
    it("should add a subscription field", () => {
      const field = { name: "userCreated", fieldDef: "userCreated: User" };
      builder.addSubscriptionField(field);

      const typeDef = builder.buildSubscriptionType();
      expect(typeDef).toContain("type Subscription {");
      expect(typeDef).toContain("userCreated: User");
      expect(typeDef).toContain("}");
    });

    it("should sort subscription fields alphabetically", () => {
      builder.addSubscriptionField({ name: "zField", fieldDef: "zField: String" });
      builder.addSubscriptionField({ name: "aField", fieldDef: "aField: String" });

      const typeDef = builder.buildSubscriptionType();
      const lines = typeDef.split('\n');
      expect(lines[1]).toContain("aField: String");
      expect(lines[2]).toContain("zField: String");
    });
  });

  describe("buildQueryType", () => {
    it("should return empty string when no query fields", () => {
      const typeDef = builder.buildQueryType();
      expect(typeDef).toBe("");
    });

    it("should build query type with multiple fields", () => {
      builder.addQueryField({ name: "getUser", fieldDef: "getUser(id: ID!): User" });
      builder.addQueryField({ name: "getUsers", fieldDef: "getUsers: [User]" });

      const typeDef = builder.buildQueryType();
      expect(typeDef).toContain("type Query {");
      expect(typeDef).toContain("getUser(id: ID!): User");
      expect(typeDef).toContain("getUsers: [User]");
      expect(typeDef).toContain("}");
    });
  });

  describe("buildMutationType", () => {
    it("should return empty string when no mutation fields", () => {
      const typeDef = builder.buildMutationType();
      expect(typeDef).toBe("");
    });

    it("should build mutation type with multiple fields", () => {
      builder.addMutationField({ name: "createUser", fieldDef: "createUser(input: CreateUserInput!): User" });
      builder.addMutationField({ name: "updateUser", fieldDef: "updateUser(id: ID!, input: UpdateUserInput!): User" });

      const typeDef = builder.buildMutationType();
      expect(typeDef).toContain("type Mutation {");
      expect(typeDef).toContain("createUser(input: CreateUserInput!): User");
      expect(typeDef).toContain("updateUser(id: ID!, input: UpdateUserInput!): User");
      expect(typeDef).toContain("}");
    });
  });

  describe("buildSubscriptionType", () => {
    it("should return empty string when no subscription fields", () => {
      const typeDef = builder.buildSubscriptionType();
      expect(typeDef).toBe("");
    });

    it("should build subscription type with multiple fields", () => {
      builder.addSubscriptionField({ name: "userCreated", fieldDef: "userCreated: User" });
      builder.addSubscriptionField({ name: "userUpdated", fieldDef: "userUpdated: User" });

      const typeDef = builder.buildSubscriptionType();
      expect(typeDef).toContain("type Subscription {");
      expect(typeDef).toContain("userCreated: User");
      expect(typeDef).toContain("userUpdated: User");
      expect(typeDef).toContain("}");
    });
  });

  describe("buildAllOperationTypes", () => {
    it("should build all operation types", () => {
      builder.addQueryField({ name: "getUser", fieldDef: "getUser(id: ID!): User" });
      builder.addMutationField({ name: "createUser", fieldDef: "createUser(input: CreateUserInput!): User" });
      builder.addSubscriptionField({ name: "userCreated", fieldDef: "userCreated: User" });

      const typeDefs = builder.buildAllOperationTypes();
      expect(typeDefs).toContain("type Query {");
      expect(typeDefs).toContain("getUser(id: ID!): User");
      expect(typeDefs).toContain("type Mutation {");
      expect(typeDefs).toContain("createUser(input: CreateUserInput!): User");
      expect(typeDefs).toContain("type Subscription {");
      expect(typeDefs).toContain("userCreated: User");
    });
  });

  describe("clear", () => {
    it("should clear all fields", () => {
      builder.addQueryField({ name: "getUser", fieldDef: "getUser(id: ID!): User" });
      builder.addMutationField({ name: "createUser", fieldDef: "createUser(input: CreateUserInput!): User" });

      builder.clear();

      expect(builder.buildQueryType()).toBe("");
      expect(builder.buildMutationType()).toBe("");
      expect(builder.buildSubscriptionType()).toBe("");
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      builder.addQueryField({ name: "getUser", fieldDef: "getUser(id: ID!): User" });
      builder.addQueryField({ name: "getUsers", fieldDef: "getUsers: [User]" });
      builder.addMutationField({ name: "createUser", fieldDef: "createUser(input: CreateUserInput!): User" });
      builder.addSubscriptionField({ name: "userCreated", fieldDef: "userCreated: User" });

      const stats = builder.getStats();
      expect(stats.queries).toBe(2);
      expect(stats.mutations).toBe(1);
      expect(stats.subscriptions).toBe(1);
    });
  });
});