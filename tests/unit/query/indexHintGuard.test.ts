/**
 * SEC-17: index hints are embedded in a SQL comment and must not break out of it.
 */
import { describe, expect, test } from "bun:test";
import { withIndexHint, type FilterBuilder } from "../../../query/FilterBuilder";

const passthrough: FilterBuilder = () => ({ sql: "c.data->>'x' = $1", addedParams: 1 });

describe("withIndexHint allow-list", () => {
    test("rejects a comment breakout and keeps a plain index name", () => {
        expect(() => withIndexHint(passthrough, "idx */ ; DROP TABLE entities; /*")).toThrow(
            /idx \*\/ ; DROP TABLE entities; \/\*/
        );

        const hinted = withIndexHint(passthrough, "idx_spatial_location");
        const result = hinted({ field: "x", operator: "=", value: 1 }, "c", {} as never);
        expect(result.sql).toBe("/* INDEX: idx_spatial_location */ c.data->>'x' = $1");
        expect(result.addedParams).toBe(1);
    });
});
