/**
 * SEC-17: top-level operation input names are asserted before SDL interpolation.
 */
import { describe, expect, test } from "bun:test";
import { t, type SchemaType } from "../../../gql/schema";
import { OperationNode, OperationType } from "../../../gql/graph/GraphNode";
import { SchemaGeneratorVisitor } from "../../../gql/visitors/SchemaGeneratorVisitor";

function emit(name: string, input: Record<string, SchemaType>): string {
    const visitor = new SchemaGeneratorVisitor();
    visitor.visitOperationNode(new OperationNode(
        name,
        name,
        OperationType.QUERY,
        `${name}: String`,
        undefined,
        undefined,
        { input, output: "String", scalarTypes: new Set<string>() },
    ));
    return visitor.getTypeDefs();
}

describe("operation input identifier allow-list", () => {
    test("rejects a hostile field key and keeps a plain operation input", () => {
        expect(() => emit("getUser", { "n}ame": t.string() })).toThrow(/getUser/);
        expect(() => emit("getUser", { "n}ame": t.string() })).toThrow(/"n}ame"/);
        expect(() => emit("bad name", { id: t.id() })).toThrow(/bad name/);

        const sdl = emit("getUser", { id: t.id().required(), name: t.string() });
        expect(sdl).toContain("input getUserInput {");
        expect(sdl).toContain("id: ID!");
        expect(sdl).toContain("name: String");
    });
});
