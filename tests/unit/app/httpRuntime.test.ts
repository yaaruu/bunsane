import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import App from "../../../core/App";
import { handleRequest, type RequestHost } from "../../../core/app/requestRouter";
import { bindRequestTimeout } from "../../../core/app/requestTimeout";
import { resolveStudioDist } from "../../../core/app/studioAssets";
import { rejectOversizedBody } from "../../../core/app/bodyLimit";
import { handleHealth, resetHealthGateForTests, takeHealthPermit } from "../../../core/app/healthEndpoints";
import { OpenAPISpecGenerator } from "../../../swagger/generator";
import { CLOSED_INFO_ACCESS } from "../../../core/app/limits";
import { envSecurityWarnings, validateEnv } from "../../../core/validateEnv";

const TOKEN = "0123456789abcdef";

function internals(app: App) {
    return app as unknown as {
        server: unknown;
        requestTimeoutMs: number;
        staticAssets: Map<string, string>;
        studioEnabled: boolean;
        isShuttingDown: boolean;
    };
}

function host(overrides: Partial<RequestHost> = {}): RequestHost {
    return {
        config: {},
        name: "Test",
        openAPISpecGenerator: new OpenAPISpecGenerator("Test", "0"),
        studioEnabled: false,
        studioAssetsPath: null,
        studioIndexHtml: null,
        staticAssets: new Map(),
        restEndpointMap: new Map(),
        restEndpoints: [],
        yoga: null,
        isReady: true,
        isShuttingDown: false,
        requestTimeoutMs: 30_000,
        jsonBodyLimit: 1024,
        multipartBodyLimit: 4096,
        metricsAccess: { ...CLOSED_INFO_ACCESS },
        docsAccess: { ...CLOSED_INFO_ACCESS },
        collectMetrics: async () => ({ ok: true }),
        remote: null,
        ...overrides,
    };
}

describe("request timeout", () => {
    test("does not clone or arm a timer for /health, /health/ready, or timeout 0", () => {
        const req = new Request("http://localhost/health");
        const health = bindRequestTimeout(req, 30_000, "/health");
        const ready = bindRequestTimeout(req, 30_000, "/health/ready");
        const off = bindRequestTimeout(new Request("http://localhost/graphql"), 0, "/graphql");
        expect(health.attached).toBe(false);
        expect(health.req).toBe(req);
        expect(ready.attached).toBe(false);
        expect(off.attached).toBe(false);
        health.cancel();
        ready.cancel();
        off.cancel();
    });

    test("clones only when a timeout signal must be attached", () => {
        const req = new Request("http://localhost/graphql");
        const bound = bindRequestTimeout(req, 30_000, "/graphql");
        expect(bound.attached).toBe(true);
        expect(bound.req).not.toBe(req);
        bound.cancel();
    });

    test("setRequestTimeout(0) is accepted and a negative value throws", () => {
        const app = new App("Timeout", "0");
        app.setRequestTimeout(0);
        expect(internals(app).requestTimeoutMs).toBe(0);
        expect(() => app.setRequestTimeout(-1)).toThrow(/non-negative/);
    });
});

describe("App.start and middleware order", () => {
    const port = 19907;
    let app: App;

    afterEach(async () => {
        if (app) await app.shutdown();
    });

    test("second start() is a no-op and use() after start throws", async () => {
        app = new App("Idempotent", "0");
        app.setPort(port);
        await app.start();
        const server = internals(app).server;
        await app.start();
        expect(internals(app).server).toBe(server);
        expect(() => app.use(async (_req, next) => next())).toThrow(/after start/);
    });

    test("start after shutdown listens again and /health is not stuck shutting down", async () => {
        const restartPort = 19915;
        app = new App({ name: "Restart", version: "0", port: restartPort });
        await app.start();
        await app.shutdown();
        expect(internals(app).server).toBeNull();
        expect(internals(app).isShuttingDown).toBe(false);
        expect(() => app.use(async (_req, next) => next())).not.toThrow();
        await app.start();
        const res = await fetch(`http://127.0.0.1:${restartPort}/health`);
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
        const body = await res.json() as { status?: string };
        expect(body.status === "ok" || body.status === "degraded" || body.status === "unavailable").toBe(true);
        const ready = await fetch(`http://127.0.0.1:${restartPort}/health/ready`);
        const readyBody = await ready.json() as { checks?: { database?: { status?: string } } };
        expect(readyBody.checks?.database?.status).not.toBe("unknown");
    });

    test("security headers and request id are present by default and can be opted out", async () => {
        app = new App({ name: "Headers", version: "0", port, requestId: true });
        await app.start();
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(res.headers.get("X-Request-Id")).toMatch(/^[A-Za-z0-9-]{1,64}$/);
        await app.shutdown();

        const optedOut = new App({
            name: "NoHeaders",
            version: "0",
            port: port + 1,
            securityHeaders: false,
            requestId: false,
        });
        await optedOut.start();
        const bare = await fetch(`http://127.0.0.1:${port + 1}/health`);
        expect(bare.headers.get("X-Frame-Options")).toBeNull();
        expect(bare.headers.get("X-Request-Id")).toBeNull();
        await optedOut.shutdown();
    });
});

describe("body limits and info gates", () => {
    test("rejects oversize JSON by Content-Length before a handler runs", async () => {
        let handled = false;
        const res = await handleRequest(host({
            restEndpointMap: new Map([[
                "POST:/items",
                { method: "POST", path: "/items", handler: async () => { handled = true; return { ok: true }; } },
            ]]),
        }), new Request("http://localhost/items", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": "2048",
            },
        }));
        expect(res.status).toBe(413);
        expect(handled).toBe(false);
        const body = await res.json();
        expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    });

    test("multipart uses the explicit multipart cap", () => {
        const res = rejectOversizedBody(new Request("http://localhost/upload", {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=x",
                "content-length": "2048",
            },
        }), { json: 100, multipart: 4096 });
        expect(res).toBeNull();
    });

    test("/metrics is 404 without a token, 401 on mismatch, 200 with the token", async () => {
        const closed = await handleRequest(host(), new Request("http://localhost/metrics"));
        expect(closed.status).toBe(404);

        const gated = host({ metricsAccess: { token: TOKEN, public: false } });
        const denied = await handleRequest(gated, new Request("http://localhost/metrics"));
        expect(denied.status).toBe(401);
        const allowed = await handleRequest(gated, new Request("http://localhost/metrics", {
            headers: { authorization: `Bearer ${TOKEN}` },
        }));
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ ok: true });
    });

    test("/docs is 404 unless opted in", async () => {
        const hidden = await handleRequest(host(), new Request("http://localhost/docs"));
        expect(hidden.status).toBe(404);
        const open = await handleRequest(host({
            docsAccess: { token: null, public: true },
        }), new Request("http://localhost/openapi.json"));
        expect(open.status).toBe(200);
    });
});

describe("studio dist", () => {
    test("missing dist does not register assets", () => {
        const missing = mkdtempSync(join(tmpdir(), "bunsane-studio-"));
        expect(resolveStudioDist(missing)).toBeNull();
        const app = new App({
            name: "Studio",
            version: "0",
            studio: { token: TOKEN, assetsPath: missing },
        });
        expect(internals(app).staticAssets.has("/studio")).toBe(false);
        expect(internals(app).studioEnabled).toBe(true);
    });
});

describe("GraphQL limit setters", () => {
    test("rejects depth below 15 and complexity below 1", () => {
        const app = new App("Limits", "0");
        expect(app.graphqlMaxDepth).toBe(15);
        expect(() => app.setGraphQLMaxDepth(0)).toThrow(/15/);
        expect(() => app.setGraphQLMaxDepth(10)).toThrow(/15/);
        app.setGraphQLMaxDepth(20);
        expect(app.graphqlMaxDepth).toBe(20);
        expect(() => app.setGraphQLMaxComplexity(0)).toThrow(/1/);
        app.setGraphQLMaxComplexity(50);
        expect(app.graphqlMaxComplexity).toBe(50);
    });
});

describe("health gate", () => {
    beforeEach(() => {
        process.env.BUNSANE_HEALTH_MAX_RPS = "1";
        resetHealthGateForTests();
    });
    afterEach(() => {
        delete process.env.BUNSANE_HEALTH_MAX_RPS;
        resetHealthGateForTests();
    });

    test("sheds a flood with 429 before another probe", async () => {
        expect(takeHealthPermit()).toBe(true);
        expect(takeHealthPermit()).toBe(false);
        const res = await handleHealth({});
        expect(res.status).toBe(429);
    });
});

describe("validateEnv security warnings", () => {
    let saved: NodeJS.ProcessEnv;
    beforeEach(() => {
        saved = { ...process.env };
    });
    afterEach(() => {
        process.env = saved;
    });

    test("unset NODE_ENV warns and STRICT_ENV fails boot", () => {
        delete process.env.NODE_ENV;
        delete process.env.BUNSANE_STRICT_ENV;
        const warnings = envSecurityWarnings({
            ...process.env,
            NODE_ENV: undefined,
            CACHE_PROVIDER: undefined,
            REDIS_TLS: undefined,
        });
        expect(warnings.join("\n")).toContain("NODE_ENV is not set");

        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        delete process.env.NODE_ENV;
        process.env.BUNSANE_STRICT_ENV = "on";
        expect(() => validateEnv()).toThrow(/BUNSANE_STRICT_ENV/);
    });

    test("production redis without a password on a public host warns", () => {
        const warnings = envSecurityWarnings({
            NODE_ENV: "production",
            CACHE_PROVIDER: "redis",
            REDIS_HOST: "redis.internal",
            REDIS_PASSWORD: "",
        });
        expect(warnings.join("\n")).toContain("REDIS_PASSWORD");
    });
});
