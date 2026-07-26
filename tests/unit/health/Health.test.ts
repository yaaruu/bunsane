import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    deepHealthCheck,
    readinessCheck,
    type HealthDeps,
} from "../../../core/health";
import {
    getDbStats,
    poolSaturatedForMs,
    resetDbStats,
    setPoolMax,
    timedUnsafe,
} from "../../../database/instrumentedDb";

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

/**
 * Sustained pool saturation sheds traffic via READINESS. It must never fail
 * liveness: a full pool is also what a legitimate burst looks like, and
 * restarting mid-burst trades a slow minute for a cold start plus a reconnect
 * thundering herd. "Wedged" (write probe hangs) is the condition that restarts.
 */
describe("readiness under pool saturation", () => {
    const originalThreshold = process.env.DB_POOL_SATURATION_READY_MS;

    beforeEach(() => {
        dbUp = true;
        cacheUp = true;
        writeUp = true;
        resetDbStats();
        setPoolMax(0);
    });

    afterEach(() => {
        if (originalThreshold === undefined) delete process.env.DB_POOL_SATURATION_READY_MS;
        else process.env.DB_POOL_SATURATION_READY_MS = originalThreshold;
        resetDbStats();
        setPoolMax(0);
    });

    /**
     * Hold the (size-1) pool busy so saturation accrues, then release it and
     * WAIT for the call to unwind. Abandoning it instead would leave
     * `timedUnsafe`'s `finally` to decrement `inFlight` after `afterEach` had
     * already reset the counters, pushing the shared module-level `inFlight` to
     * -1 for every later test in the process.
     */
    async function whileSaturated<T>(sustainMs: number, fn: () => Promise<T>): Promise<T> {
        setPoolMax(1);
        let release: () => void = () => {};
        const gate = new Promise<any[]>((resolve) => { release = () => resolve([]); });
        const busy = timedUnsafe({ unsafe: () => gate } as any, "SELECT pg_sleep(1)", []);
        await Bun.sleep(sustainMs);
        try {
            return await fn();
        } finally {
            release();
            await busy;
        }
    }

    test("fails readiness once saturation outlasts the threshold", async () => {
        process.env.DB_POOL_SATURATION_READY_MS = "10";

        const { result, httpStatus } = await whileSaturated(40, () =>
            readinessCheck(true, false, makeDeps()),
        );

        expect(httpStatus).toBe(503);
        expect(result.status).toBe("unavailable");
        expect(result.checks.db_pool?.status).toBe("saturated");
        expect(result.checks.db_pool?.pool_max).toBe(1);
        expect(result.checks.db_pool?.in_flight).toBeGreaterThanOrEqual(1);
        expect(result.checks.db_pool?.saturated_for_ms).toBeGreaterThan(10);
    });

    test("a momentarily full pool does not flap readiness", async () => {
        process.env.DB_POOL_SATURATION_READY_MS = "5000";

        const { httpStatus, result } = await whileSaturated(20, () =>
            readinessCheck(true, false, makeDeps()),
        );

        expect(httpStatus).toBe(200);
        expect(result.checks.db_pool).toBeUndefined();
    });

    test("saturation never fails liveness — that stays the write probe's job", async () => {
        process.env.DB_POOL_SATURATION_READY_MS = "10";

        const { httpStatus, result } = await whileSaturated(40, () =>
            deepHealthCheck(makeDeps()),
        );

        expect(httpStatus).toBe(200);
        expect(result.status).toBe("ok");
        expect(result.checks.db_pool).toBeUndefined();
    });

    test("threshold 0 disables the check", async () => {
        process.env.DB_POOL_SATURATION_READY_MS = "0";

        const { httpStatus } = await whileSaturated(40, () =>
            readinessCheck(true, false, makeDeps()),
        );

        expect(httpStatus).toBe(200);
    });

    test("occupancy accounting balances — no leaked in-flight count", async () => {
        process.env.DB_POOL_SATURATION_READY_MS = "10";

        await whileSaturated(20, () => readinessCheck(true, false, makeDeps()));

        // `inFlight` is module-level state shared by every test in the process,
        // so an unbalanced increment/decrement here corrupts later suites.
        expect(getDbStats().inFlight).toBe(0);
        expect(poolSaturatedForMs()).toBe(0);
    });
});
