import { describe, test, expect, beforeAll } from "bun:test";
import { SchemaGeneratorVisitor } from "../../../gql/visitors/SchemaGeneratorVisitor";
import { OperationNode, OperationType } from "../../../gql/graph/GraphNode";
import { TestUserArchetype } from "../../fixtures/archetypes/TestUserArchetype";
import { TestUser, TestProduct, TestOrder } from "../../fixtures/components";
import { ensureComponentsRegistered } from "../../utils";

function fieldFor(output: unknown, name = "getThing"): string {
    const visitor = new SchemaGeneratorVisitor();
    visitor.visitOperationNode(new OperationNode(
        name,
        name,
        OperationType.QUERY,
        name,
        undefined,
        undefined,
        { output },
    ));
    return visitor.getTypeDefs();
}

describe("extractOutputType", () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    test("throws at schema build for an unrecognised output and names the operation", () => {
        expect(() => fieldFor(12, "getPlayer")).toThrow(/Operation "getPlayer"/);
        expect(() => fieldFor(12, "getPlayer")).toThrow(/unrecognised output/);
        expect(() => fieldFor(12, "getPlayer")).toThrow(/Refusing to default to String/);
    });

    test("does not default an empty array or a non-archetype class to String or [Any]", () => {
        expect(() => fieldFor([], "listPlayers")).toThrow(/listPlayers/);
        expect(() => fieldFor(class NotAnArchetype {}, "getNope")).toThrow(/getNope/);
        expect(() => fieldFor([], "listPlayers")).not.toThrow(/\[Any\]/);
    });

    test("accepts an archetype constructor and an array of constructors", () => {
        const one = fieldFor(TestUserArchetype, "getPlayer");
        expect(one).toContain("getPlayer: TestUserArchetype");
        expect(one).not.toContain("getPlayer: String");

        const many = fieldFor([TestUserArchetype], "listPlayers");
        expect(many).toContain("listPlayers: [TestUserArchetype]");
        expect(many).not.toContain("[Any]");
    });

    test("still accepts an archetype instance and a type-name string", () => {
        const instance = fieldFor(new TestUserArchetype(), "getByInstance");
        expect(instance).toContain("getByInstance: TestUserArchetype");
        expect(fieldFor("ID!", "getId")).toContain("getId: ID!");
    });
});
