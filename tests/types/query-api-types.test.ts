import { describe, expect, test } from "bun:test";
import { assertQueryTypes } from "./query-api-types";

describe("Query type contract", () => {
    test("type fixture module loads", () => {
        expect(typeof assertQueryTypes).toBe("function");
    });
});
