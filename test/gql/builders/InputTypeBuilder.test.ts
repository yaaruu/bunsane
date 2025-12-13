import { describe, it, expect, beforeEach } from "bun:test";
import { InputTypeBuilder } from "../../../gql/builders/InputTypeBuilder";

describe("InputTypeBuilder", () => {
  let builder: InputTypeBuilder;

  beforeEach(() => {
    builder = new InputTypeBuilder();
  });

  describe("addInputType", () => {
    it("should add a new input type", () => {
      const typeDef: any = {
        name: "CreateUserInput",
        fields: ["name: String!", "email: String!"]
      };

      builder.addInputType(typeDef);

      const result = builder.buildInputTypes();
      expect(result).toContain("input CreateUserInput {");
      expect(result).toContain("name: String!");
      expect(result).toContain("email: String!");
      expect(result).toContain("}");
    });

    it("should merge fields when adding existing type", () => {
      builder.addInputType({
        name: "CreateUserInput",
        fields: ["name: String!"]
      });

      builder.addInputType({
        name: "CreateUserInput",
        fields: ["email: String!", "name: String!"] // name is duplicate
      });

      const result = builder.buildInputTypes();
      expect(result).toContain("input CreateUserInput {");
      expect(result).toContain("email: String!");
      expect(result).toContain("name: String!");
      // Should only appear once due to Set deduplication
      expect(result.split("name: String!").length - 1).toBe(1);
    });

    it("should sort fields alphabetically", () => {
      builder.addInputType({
        name: "CreateUserInput",
        fields: ["zField: String", "aField: String", "mField: String"]
      });

      const result = builder.buildInputTypes();
      const lines = result.split('\n');
      expect(lines[1]).toContain("aField: String");
      expect(lines[2]).toContain("mField: String");
      expect(lines[3]).toContain("zField: String");
    });
  });

  describe("getDeduplicatedName", () => {
    it("should return original name when no conflict", () => {
      const name = builder.getDeduplicatedName("CreateUserInput");
      expect(name).toBe("CreateUserInput");
    });

    it("should deduplicate names when conflicts exist", () => {
      builder.addInputType({ name: "CreateUserInput", fields: [] });

      const name1 = builder.getDeduplicatedName("CreateUserInput");
      const name2 = builder.getDeduplicatedName("CreateUserInput");

      expect(name1).toBe("CreateUserInput1");
      expect(name2).toBe("CreateUserInput2");
    });
  });

  describe("buildInputTypes", () => {
    it("should return empty string when no types", () => {
      const result = builder.buildInputTypes();
      expect(result).toBe("");
    });

    it("should build multiple input types", () => {
      builder.addInputType({
        name: "CreateUserInput",
        fields: ["name: String!", "email: String!"]
      });

      builder.addInputType({
        name: "UpdateUserInput",
        fields: ["id: ID!", "name: String"]
      });

      const result = builder.buildInputTypes();
      expect(result).toContain("input CreateUserInput {");
      expect(result).toContain("name: String!");
      expect(result).toContain("email: String!");
      expect(result).toContain("input UpdateUserInput {");
      expect(result).toContain("id: ID!");
      expect(result).toContain("name: String");
    });
  });

  describe("hasInputType", () => {
    it("should return true for existing type", () => {
      builder.addInputType({ name: "CreateUserInput", fields: [] });
      expect(builder.hasInputType("CreateUserInput")).toBe(true);
    });

    it("should return false for non-existing type", () => {
      expect(builder.hasInputType("NonExistentInput")).toBe(false);
    });
  });

  describe("getInputTypeNames", () => {
    it("should return all input type names", () => {
      builder.addInputType({ name: "CreateUserInput", fields: [] });
      builder.addInputType({ name: "UpdateUserInput", fields: [] });

      const names = builder.getInputTypeNames();
      expect(names).toContain("CreateUserInput");
      expect(names).toContain("UpdateUserInput");
      expect(names.length).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all input types and deduplication map", () => {
      builder.addInputType({ name: "CreateUserInput", fields: ["name: String!"] });
      builder.getDeduplicatedName("CreateUserInput"); // This adds to deduplication map

      builder.clear();

      expect(builder.buildInputTypes()).toBe("");
      expect(builder.hasInputType("CreateUserInput")).toBe(false);
      // After clear, should get original name again
      expect(builder.getDeduplicatedName("CreateUserInput")).toBe("CreateUserInput");
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      builder.addInputType({
        name: "CreateUserInput",
        fields: ["name: String!", "email: String!"]
      });

      builder.addInputType({
        name: "UpdateUserInput",
        fields: ["id: ID!"]
      });

      const stats = builder.getStats();
      expect(stats.totalTypes).toBe(2);
      expect(stats.totalFields).toBe(3);
    });
  });
});