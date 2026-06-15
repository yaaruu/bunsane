import { describe, test, expect, beforeEach } from "bun:test";
import {
    deepHealthCheck,
    readinessCheck,
    type HealthDeps,
} from "../../../core/health";

let dbUp: boolean;
let cacheUp: boolean;
let writeUp: boolean;

function makeDeps(): HealthDeps {
    return {
        pingDb: async () => {
            if (!dbUp) throw new Error("connection refused");
            return true;
        },
        pingCache: async () => cacheUp,
        pingDbWrite: async () => {
            if (!writeUp) throw new Error("write path wedged");
            return true;
        },
    };
}

describe("deepHealthCheck", () => {
    beforeEach(() => {
        dbUp = true;
        cacheUp = true;
        writeUp = true;
    });

    test("returns ok when DB and cache are up", async () => {
        const { result, httpStatus } = await deepHealthCheck(makeDeps());

        expect(httpStatus).toBe(200);
        expect(result.status).toBe("ok");
        expect(result.checks.database.status).toBe("up");
        expect(result.checks.cache.status).toBe("up");
        expect(result.checks.database_write?.status).toBe("up");
        expect(typeof result.checks.database.latency_ms).toBe("number");
        expect(typeof result.checks.cache.latency_ms).toBe("number");
        expect(typeof result.timestamp).toBe("string");
        expect(typeof result.uptime).toBe("number");
    });

    test("returns unavailable (503) when write path is wedged but reads are up", async () => {
        writeUp = false;

        const { result, httpStatus } = await deepHealthCheck(makeDeps());

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
        expect(result.checks.database.status).toBe("up");
        expect(result.checks.database_write?.status).toBe("down");
    });

    test("omits database_write when no write probe is supplied", async () => {
        const { result, httpStatus } = await deepHealthCheck({
            pingDb: async () => true,
            pingCache: async () => true,
        });

        expect(httpStatus).toBe(200);
        expect(result.status).toBe("ok");
        expect(result.checks.database_write).toBeUndefined();
    });

    test("returns degraded when DB is up but cache is down", async () => {
        cacheUp = false;

        const { result, httpStatus } = await deepHealthCheck(makeDeps());

        expect(httpStatus).toBe(200);
        expect(result.status).toBe("degraded");
        expect(result.checks.database.status).toBe("up");
        expect(result.checks.cache.status).toBe("down");
    });

    test("returns unavailable (503) when DB is down", async () => {
        dbUp = false;

        const { result, httpStatus } = await deepHealthCheck(makeDeps());

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
        expect(result.checks.database.status).toBe("down");
    });

    test("returns unavailable (503) when both DB and cache are down", async () => {
        dbUp = false;
        cacheUp = false;

        const { result, httpStatus } = await deepHealthCheck(makeDeps());

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
        expect(result.checks.database.status).toBe("down");
        expect(result.checks.cache.status).toBe("down");
    });
});

describe("readinessCheck", () => {
    beforeEach(() => {
        dbUp = true;
        cacheUp = true;
    });

    test("returns 503 when isReady is false", async () => {
        const { result, httpStatus } = await readinessCheck(
            false,
            false,
            makeDeps(),
        );

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
        expect(result.checks.database.status).toBe("unknown");
        expect(result.checks.cache.status).toBe("unknown");
    });

    test("returns 503 when isShuttingDown is true", async () => {
        const { result, httpStatus } = await readinessCheck(
            true,
            true,
            makeDeps(),
        );

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
    });

    test("delegates to deepHealthCheck when ready", async () => {
        const { result, httpStatus } = await readinessCheck(
            true,
            false,
            makeDeps(),
        );

        expect(httpStatus).toBe(200);
        expect(result.status).toBe("ok");
        expect(result.checks.database.status).toBe("up");
        expect(result.checks.cache.status).toBe("up");
    });

    test("returns 503 when ready but DB is down", async () => {
        dbUp = false;

        const { result, httpStatus } = await readinessCheck(
            true,
            false,
            makeDeps(),
        );

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
    });
});
