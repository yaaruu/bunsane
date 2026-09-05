/**
 * SEC-01: Studio deny-by-default + token auth.
 *
 * Boots a real HTTP server without init() (no DB) — the same pattern as
 * http.test.ts. Asserts the routing gate states, not handler success:
 * reaching a handler without 401/404 proves the token gate passed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import App from "../../core/App";

const TOKEN = "sec01-test-token-0123456789";

async function bootApp(enableStudio: boolean): Promise<{ app: App; base: string }> {
    const port = enableStudio ? 19881 : 19880;
    const app = new App("SEC01 Test", "0.0.0");
    if (enableStudio) {
        expect(app.enableStudio({ token: TOKEN })).toBe(true);
    }
    process.env.APP_PORT = String(port);
    await app.start();
    return { app, base: `http://localhost:${port}` };
}

describe("Studio gating (studio never enabled)", () => {
    let app: App;
    let base: string;

    beforeAll(async () => {
        ({ app, base } = await bootApp(false));
    });

    afterAll(async () => {
        await app.shutdown();
    });

    it("GET /studio/api/tables returns explicit 404", async () => {
        const res = await fetch(`${base}/studio/api/tables`);
        expect(res.status).toBe(404);
    });

    it("POST /studio/api/query returns 404", async () => {
        const res = await fetch(`${base}/studio/api/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql: "SELECT 1" }),
        });
        expect(res.status).toBe(404);
    });

    it("DELETE /studio/api/table/x returns 404", async () => {
        const res = await fetch(`${base}/studio/api/table/entities`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: ["x"] }),
        });
        expect(res.status).toBe(404);
    });

    it("GET /studio (UI shell) returns 404", async () => {
        const res = await fetch(`${base}/studio`);
        expect(res.status).toBe(404);
    });
});

describe("Studio gating (enabled with token)", () => {
    let app: App;
    let base: string;

    beforeAll(async () => {
        ({ app, base } = await bootApp(true));
    });

    afterAll(async () => {
        await app.shutdown();
    });

    it("missing credentials → 401", async () => {
        const res = await fetch(`${base}/studio/api/tables`);
        expect(res.status).toBe(401);
    });

    it("wrong bearer token → 401", async () => {
        const res = await fetch(`${base}/studio/api/tables`, {
            headers: { Authorization: "Bearer wrong-token-wrong-token" },
        });
        expect(res.status).toBe(401);
    });

    it("wrong x-studio-token header → 401", async () => {
        const res = await fetch(`${base}/studio/api/tables`, {
            headers: { "x-studio-token": "not-the-right-token-at-all" },
        });
        expect(res.status).toBe(401);
    });

    it("correct bearer token passes the gate (handler reached, not 401/404)", async () => {
        const res = await fetch(`${base}/studio/api/tables`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        // No init()/DB in this harness, so the handler itself will error —
        // but the AUTH GATE must have passed: anything except 401/404.
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(404);
    });

    it("correct x-studio-token header passes the gate", async () => {
        const res = await fetch(`${base}/studio/api/tables`, {
            headers: { "x-studio-token": TOKEN },
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(404);
    });

    it("enableStudio() refuses without a token", async () => {
        delete process.env.BUNSANE_STUDIO_TOKEN;
        const fresh = new App("SEC01 Refused", "0.0.0");
        expect(fresh.enableStudio()).toBe(false);
    });

    it("enableStudio() refuses with env token shorter than 16 chars", async () => {
        process.env.BUNSANE_STUDIO_TOKEN = "short";
        const fresh = new App("SEC01 ShortToken", "0.0.0");
        expect(fresh.enableStudio()).toBe(false);
        delete process.env.BUNSANE_STUDIO_TOKEN;
    });
});
