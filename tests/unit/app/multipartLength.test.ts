/**
 * Multipart ingress: missing Content-Length is 411 before any body read.
 * REST routes and /graphql share rejectOversizedBody in the request router.
 */
import { describe, expect, test, spyOn } from "bun:test";
import { handleRequest, type RequestHost } from "../../../core/app/requestRouter";
import { CLOSED_INFO_ACCESS } from "../../../core/app/limits";
import {
    LengthRequiredError,
    assertBodyWithinLimit,
} from "../../../core/app/bodyLimit";
import { parseFormData } from "../../../upload/RestUpload";

const MULTIPART_LIMIT = 4096;

function host(overrides: Partial<RequestHost> = {}): RequestHost {
    return {
        config: {
            cors: { origin: "https://app.example.com" },
        },
        name: "Test",
        openAPISpecGenerator: null,
        studioEnabled: false,
        studioAssetsPath: null,
        studioIndexHtml: null,
        staticAssets: new Map(),
        restEndpointMap: new Map(),
        restEndpoints: [],
        yoga: null,
        isReady: true,
        isShuttingDown: false,
        requestTimeoutMs: 0,
        jsonBodyLimit: 1024,
        multipartBodyLimit: MULTIPART_LIMIT,
        metricsAccess: { ...CLOSED_INFO_ACCESS },
        docsAccess: { ...CLOSED_INFO_ACCESS },
        collectMetrics: async () => ({ ok: true }),
        remote: null,
        ...overrides,
    };
}

const BODY_READERS = ["formData", "text", "json", "arrayBuffer", "blob"] as const;

function spyBodyReaders(): { expectUnread: () => void; restore: () => void } {
    const spies = BODY_READERS.map((name) => spyOn(Request.prototype, name));
    return {
        expectUnread() {
            for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        },
        restore() {
            for (const spy of spies) spy.mockRestore();
        },
    };
}

function multipartRequest(url: string, contentLength?: string): Request {
    const headers: Record<string, string> = {
        "content-type": "multipart/form-data; boundary=x",
        origin: "https://app.example.com",
    };
    if (contentLength !== undefined) headers["content-length"] = contentLength;
    return new Request(url, { method: "POST", headers });
}

async function expectLengthRequired(res: Response): Promise<void> {
    expect(res.status).toBe(411);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(await res.json()).toEqual({
        error: "Length Required",
        code: "LENGTH_REQUIRED",
        limit: MULTIPART_LIMIT,
    });
}

describe("multipart Content-Length ingress", () => {
    test("REST multipart without Content-Length is 411 before the handler or body is read", async () => {
        let handled = false;
        const reads = spyBodyReaders();
        try {
            const res = await handleRequest(host({
                restEndpointMap: new Map([[
                    "POST:/upload",
                    {
                        method: "POST",
                        path: "/upload",
                        handler: async () => {
                            handled = true;
                            return { ok: true };
                        },
                    },
                ]]),
            }), multipartRequest("http://localhost/upload"));

            await expectLengthRequired(res);
            expect(handled).toBe(false);
            reads.expectUnread();
        } finally {
            reads.restore();
        }
    });

    test("GraphQL multipart without Content-Length is 411 before yoga reads the body", async () => {
        let yogaCalled = false;
        const reads = spyBodyReaders();
        try {
            const res = await handleRequest(host({
                yoga: async () => {
                    yogaCalled = true;
                    return new Response("ok");
                },
            }), multipartRequest("http://localhost/graphql"));

            await expectLengthRequired(res);
            expect(yogaCalled).toBe(false);
            reads.expectUnread();
        } finally {
            reads.restore();
        }
    });

    test("multipart with Content-Length under the cap reaches REST and GraphQL", async () => {
        let handled = false;
        const rest = await handleRequest(host({
            restEndpointMap: new Map([[
                "POST:/upload",
                {
                    method: "POST",
                    path: "/upload",
                    handler: async () => {
                        handled = true;
                        return { ok: true };
                    },
                },
            ]]),
        }), multipartRequest("http://localhost/upload", "128"));
        expect(rest.status).toBe(200);
        expect(handled).toBe(true);
        expect(await rest.json()).toEqual({ ok: true });

        let yogaCalled = false;
        const gql = await handleRequest(host({
            yoga: async () => {
                yogaCalled = true;
                return new Response(JSON.stringify({ data: { ok: true } }), {
                    headers: { "Content-Type": "application/json" },
                });
            },
        }), multipartRequest("http://localhost/graphql", "128"));
        expect(gql.status).toBe(200);
        expect(yogaCalled).toBe(true);
    });

    test("multipart over the cap is still 413 and does not run the handler", async () => {
        let handled = false;
        let yogaCalled = false;
        const rest = await handleRequest(host({
            restEndpointMap: new Map([[
                "POST:/upload",
                {
                    method: "POST",
                    path: "/upload",
                    handler: async () => {
                        handled = true;
                        return { ok: true };
                    },
                },
            ]]),
            yoga: async () => {
                yogaCalled = true;
                return new Response("yoga");
            },
        }), multipartRequest("http://localhost/upload", "5000"));

        expect(rest.status).toBe(413);
        expect(handled).toBe(false);
        expect(yogaCalled).toBe(false);
        expect(rest.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(await rest.json()).toEqual({
            error: "Payload too large",
            code: "PAYLOAD_TOO_LARGE",
            limit: MULTIPART_LIMIT,
        });

        const gql = await handleRequest(host({
            yoga: async () => {
                yogaCalled = true;
                return new Response("yoga");
            },
        }), multipartRequest("http://localhost/graphql", "5000"));
        expect(gql.status).toBe(413);
        expect(yogaCalled).toBe(false);
        expect(await gql.json()).toEqual({
            error: "Payload too large",
            code: "PAYLOAD_TOO_LARGE",
            limit: MULTIPART_LIMIT,
        });
    });

    test("chunked JSON without Content-Length is not 411", async () => {
        let handled = false;
        const res = await handleRequest(host({
            restEndpointMap: new Map([[
                "POST:/items",
                {
                    method: "POST",
                    path: "/items",
                    handler: async () => {
                        handled = true;
                        return { ok: true };
                    },
                },
            ]]),
        }), new Request("http://localhost/items", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: "https://app.example.com",
            },
        }));
        expect(res.status).toBe(200);
        expect(handled).toBe(true);
    });

    test("parseFormData throws Length Required before reading a chunked multipart body", async () => {
        const reads = spyBodyReaders();
        try {
            const req = multipartRequest("http://localhost/upload");
            await expect(parseFormData(req)).rejects.toBeInstanceOf(LengthRequiredError);
            reads.expectUnread();
            expect(() => assertBodyWithinLimit(req, { json: 1024, multipart: MULTIPART_LIMIT }))
                .toThrow(LengthRequiredError);
        } finally {
            reads.restore();
        }
    });

    test("upper-case multipart media type without Content-Length is still 411", async () => {
        const req = new Request("http://localhost/upload", {
            method: "POST",
            headers: {
                "content-type": "Multipart/Form-Data; boundary=x",
                origin: "https://app.example.com",
            },
        });
        await expectLengthRequired(await handleRequest(host(), req));
    });
});
