/**
 * The root package must export the authoring set, and importing it must not
 * open a database pool or construct Yoga. The check runs in a child process
 * so the test preload (tests/setup.ts) cannot open a connection first.
 *
 * The child uses dynamic import on purpose: the assertion is that evaluating
 * the barrel does not connect. A static import in this file would run under
 * the test preload, which opens a pool in beforeAll.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");

function runProbe(): Promise<{ code: number; stdout: string; stderr: string }> {
    const preload = path.join(repoRoot, "tests/public-api/yoga-probe-preload.ts");
    const script = `
        const g = globalThis;
        if (g.__bunsaneYogaProbe !== "installed") {
            console.error("PROBE_MISSING");
            process.exit(6);
        }
        const dbMod = await import("./database/index.ts");
        await Promise.resolve(dbMod.default);
        if (dbMod.isDatabaseInitialized()) {
            console.error("DB_ON_DATABASE_IMPORT");
            process.exit(2);
        }
        const barrel = await import("./index.ts");
        if (dbMod.isDatabaseInitialized()) {
            console.error("DB_ON_BARREL_IMPORT");
            process.exit(3);
        }
        if ((g.__bunsaneYogaConstructs ?? 0) !== 0) {
            console.error("YOGA_CONSTRUCTED " + g.__bunsaneYogaConstructs);
            process.exit(5);
        }
        const required = [
            "App", "Entity", "BaseComponent", "Component", "CompData", "CompositeIndex",
            "BaseArcheType", "ArcheType", "ArcheTypeField", "ArcheTypeFunction",
            "Query", "or", "FilterOp", "BaseService", "ServiceRegistry",
            "GraphQLOperation", "GraphQLSubscription", "t", "logger",
            "withLock", "ScheduledTask", "accessLog", "requestId",
            "securityHeaders", "rateLimit", "handleUpload", "UploadManager",
            "UploadHelper", "CacheManager",
        ];
        for (const name of required) {
            if (barrel[name] == null) {
                console.error("MISSING_" + name);
                process.exit(4);
            }
        }
        if (typeof barrel.FilterOp.EQ !== "string") {
            console.error("BAD_FILTEROP");
            process.exit(4);
        }
        if (typeof barrel.t.string !== "function") {
            console.error("BAD_T");
            process.exit(4);
        }
        const subpaths = [
            "bunsane/database",
            "bunsane/core/components",
            "bunsane/core/scheduler",
            "bunsane/query/Query",
            "bunsane/service",
            "bunsane/database/gateway",
            "bunsane/gql/schema",
        ];
        for (const spec of subpaths) {
            await import(spec);
        }
        const named = await import("bunsane");
        if (named.App !== barrel.App) {
            console.error("PACKAGE_NAME_MISMATCH");
            process.exit(7);
        }
        console.log("OK");
    `;

    const { promise, resolve, reject } = Promise.withResolvers<{
        code: number;
        stdout: string;
        stderr: string;
    }>();
    const child = spawn(
        process.execPath,
        ["--preload", preload, "-e", script],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                LOG_LEVEL: "error",
                LOG_PRETTY: "false",
                POSTGRES_HOST: "127.0.0.1",
                POSTGRES_PORT: "1",
                POSTGRES_USER: "probe",
                POSTGRES_PASSWORD: "probe",
                POSTGRES_DB: "probe",
                DB_CONNECTION_URL: "",
                USE_PGLITE: "",
            },
        },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
    });
    return promise;
}

describe("public barrel", () => {
    test("exports the authoring set without opening a database or constructing Yoga", async () => {
        const result = await runProbe();
        expect(result.stderr + result.stdout).not.toContain("Database connection URL");
        if (result.code !== 0) {
            throw new Error(
                `barrel probe exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
        }
        expect(result.stdout).toContain("OK");
    }, 20_000);
});
