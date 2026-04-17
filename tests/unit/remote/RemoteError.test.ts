import { describe, test, expect } from "bun:test";
import { RemoteError } from "../../../core/remote/types";

describe("RemoteError", () => {
    test("carries message + code", () => {
        const err = new RemoteError("boom", { code: "X" });
        expect(err.message).toBe("boom");
        expect(err.code).toBe("X");
    });

    test("default name is RemoteError", () => {
        const err = new RemoteError("m", { code: "X" });
        expect(err.name).toBe("RemoteError");
    });

    test("is instanceof Error", () => {
        const err = new RemoteError("m", { code: "X" });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(RemoteError);
    });

    test("sourceApp + extensions are optional", () => {
        const err = new RemoteError("m", { code: "X" });
        expect(err.sourceApp).toBeUndefined();
        expect(err.extensions).toBeUndefined();
    });

    test("sourceApp + extensions propagate", () => {
        const err = new RemoteError("m", {
            code: "FORBIDDEN",
            sourceApp: "orders",
            extensions: { userId: "u1", reason: "not-owner" },
        });
        expect(err.sourceApp).toBe("orders");
        expect(err.extensions).toEqual({ userId: "u1", reason: "not-owner" });
    });

    test("can be thrown + caught with instanceof narrowing", () => {
        try {
            throw new RemoteError("nope", { code: "NOT_FOUND" });
        } catch (e) {
            if (e instanceof RemoteError) {
                expect(e.code).toBe("NOT_FOUND");
                return;
            }
            throw new Error("did not narrow");
        }
    });

    test("stack trace is preserved", () => {
        const err = new RemoteError("m", { code: "X" });
        expect(err.stack).toBeDefined();
        expect(typeof err.stack).toBe("string");
    });
});
