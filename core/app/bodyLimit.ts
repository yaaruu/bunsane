import { DEFAULT_JSON_BODY_LIMIT, DEFAULT_MAX_REQUEST_BODY_SIZE } from "./limits";

export type BodyLimits = {
    json: number;
    multipart: number;
};

export const DEFAULT_BODY_LIMITS: BodyLimits = {
    json: DEFAULT_JSON_BODY_LIMIT,
    multipart: DEFAULT_MAX_REQUEST_BODY_SIZE,
};

export class PayloadTooLargeError extends Error {
    readonly status = 413;
    readonly limit: number;
    constructor(limit: number) {
        super(`Payload too large (limit ${limit} bytes)`);
        this.name = "PayloadTooLargeError";
        this.limit = limit;
    }
}

/**
 * SEC-14: reject by Content-Length before any body read (formData/json).
 * Missing Content-Length falls through; Bun.serve maxRequestBodySize is the
 * backstop for chunked bodies. Returns null when the request may proceed.
 */
export function rejectOversizedBody(req: Request, limits: BodyLimits): Response | null {
    const method = req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

    const raw = req.headers.get("content-length");
    if (raw == null || raw === "") return null;
    const length = Number(raw);
    if (!Number.isFinite(length) || length < 0) return null;

    const contentType = req.headers.get("content-type") ?? "";
    const multipart = contentType.includes("multipart/form-data");
    const limit = multipart ? limits.multipart : limits.json;
    if (length <= limit) return null;

    return new Response(
        JSON.stringify({
            error: "Payload too large",
            code: "PAYLOAD_TOO_LARGE",
            limit,
        }),
        {
            status: 413,
            headers: { "Content-Type": "application/json" },
        },
    );
}

/** Throw before formData() when Content-Length exceeds the multipart cap. */
export function assertBodyWithinLimit(req: Request, limits: BodyLimits): void {
    const rejected = rejectOversizedBody(req, limits);
    if (!rejected) return;
    const contentType = req.headers.get("content-type") ?? "";
    const multipart = contentType.includes("multipart/form-data");
    throw new PayloadTooLargeError(multipart ? limits.multipart : limits.json);
}
