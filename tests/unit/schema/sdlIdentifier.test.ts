/**
 * SEC-17: field, type, and enum names are asserted before SDL interpolation.
 */
import { describe, expect, test } from "bun:test";
import { t } from "../../../gql/schema";

describe("SDL identifier allow-list", () => {
    test("rejects hostile names and still emits a plain input", () => {
        expect(() => t.object({ name: t.string() }, "Bad Name")).toThrow(/"Bad Name"/);
        expect(() => t.object({ "n}ame": t.string() }, "Ok").toGraphQLTypeDef()).toThrow(/"n}ame"/);
        expect(() => t.enum(["A B"] as const, "Status")).toThrow(/"A B"/);
        expect(() => t.enum(["ACTIVE"] as const, "Bad-Name")).toThrow(/"Bad-Name"/);
        expect(() => t.ref("String } type Evil { x: String")).toThrow(/String } type Evil/);

        const sdl = t.object({
            id: t.id().required(),
            name: t.string(),
            tags: t.list(t.string().required()).required(),
        }, "UserInput").toGraphQLTypeDef();
        expect(sdl).toBe(
            "input UserInput {\n    id: ID!\n    name: String\n    tags: [String!]!\n}"
        );

        const enumSdl = t.enum(["ACTIVE", "INACTIVE"] as const, "Status").toGraphQLTypeDef();
        expect(enumSdl).toBe("enum Status {\n    ACTIVE\n    INACTIVE\n}");
    });
});
