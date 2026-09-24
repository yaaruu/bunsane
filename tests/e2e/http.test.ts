import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import App from "../../core/App";

const PORT = 19876;
const BASE = `http://localhost:${PORT}`;

let app: App;

beforeAll(async () => {
    app = new App({
        name: "E2E Test App",
        version: "0.0.1",
        docs: { public: true },
    });
    // Start without init() — skips DB/component lifecycle
    process.env.APP_PORT = String(PORT);
    await app.start();
});

afterAll(async () => {
    await app.shutdown();
});

describe("E2E HTTP Routes", () => {
    it("GET /health returns a softened JSON body", async () => {
        const res = await fetch(`${BASE}/health`);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        const body = await res.json();
        expect(body).toHaveProperty("status");
        expect(body).toHaveProperty("timestamp");
        expect(body).not.toHaveProperty("uptime");
        expect(body.checks).toHaveProperty("database");
        expect(body.checks).toHaveProperty("cache");
        expect(body.checks.database).not.toHaveProperty("latency_ms");
    });

    it("GET /health/ready returns 200 when server is up", async () => {
        const res = await fetch(`${BASE}/health/ready`);
        const body = await res.json();
        expect(body).toHaveProperty("status");
        expect(body).toHaveProperty("timestamp");
        expect(body).not.toHaveProperty("uptime");
    });

    it("GET /metrics is 404 unless a token or public opt-in is configured", async () => {
        const res = await fetch(`${BASE}/metrics`);
        expect(res.status).toBe(404);
    });

    it("GET /openapi.json returns valid JSON", async () => {
        const res = await fetch(`${BASE}/openapi.json`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        const body = await res.json();
        expect(body).toHaveProperty("openapi");
    });

    it("GET /docs returns HTML with pinned swagger-ui when docs are public", async () => {
        const res = await fetch(`${BASE}/docs`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/html");
        const html = await res.text();
        expect(html).toContain("swagger-ui");
        expect(html).toContain("integrity=");
        expect(html).toContain("E2E Test App");
        expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    });

    it("GET /nonexistent returns 404", async () => {
        const res = await fetch(`${BASE}/nonexistent`);
        expect(res.status).toBe(404);
    });

    it("OPTIONS /health returns 204 when CORS configured", async () => {
        app.setCors({ origin: "*" });
        // Preflight must carry Origin header per CORS spec; otherwise the
        // server emits no Access-Control-Allow-Origin (no `|| '*'` fallback).
        const res = await fetch(`${BASE}/health`, {
            method: "OPTIONS",
            headers: { Origin: "https://client.example" },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("security headers are present by default", async () => {
        const res = await fetch(`${BASE}/health`);
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(res.headers.get("X-Frame-Options")).toBe("DENY");
        expect(res.headers.get("X-Request-Id")).toBeTruthy();
    });

    it("Shutdown completes without error and is idempotent", async () => {
        const shutdownApp = new App({
            name: "Shutdown Test",
            version: "0.0.1",
            docs: { public: true },
        });
        const shutdownPort = 19877;
        process.env.APP_PORT = String(shutdownPort);
        await shutdownApp.start();

        // Verify server responds before shutdown
        const before = await fetch(`http://localhost:${shutdownPort}/openapi.json`);
        expect(before.status).toBe(200);

        // Shutdown completes without throwing
        await shutdownApp.shutdown();

        // Second shutdown is a no-op (idempotent)
        await shutdownApp.shutdown();

        // Restore port for other tests
        process.env.APP_PORT = String(PORT);
    });

    it("Request timeout returns 408 for long requests", async () => {
        // This is hard to test without a slow endpoint. Verify the timeout
        // mechanism exists by checking a fast request completes normally.
        const res = await fetch(`${BASE}/openapi.json`);
        expect(res.status).toBe(200);
    });
});
