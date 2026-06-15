import { describe, test, expect } from "bun:test";
import { deepHealthCheck } from "../../../core/health";

// Exercises the real default write probe (db.transaction + temp-table write)
// against the live test DB, verifying it reports "up" on a healthy write path.
describe("deepHealthCheck write probe (integration)", () => {
    test("database_write is up against a healthy DB", async () => {
        const { result, httpStatus } = await deepHealthCheck();

        expect(result.checks.database.status).toBe("up");
        expect(result.checks.database_write?.status).toBe("up");
        expect(typeof result.checks.database_write?.latency_ms).toBe("number");
        // cache may be memory-only in tests; assert DB-driven status only.
        expect(httpStatus).toBeLessThan(500);
    });
});
