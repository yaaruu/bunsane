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

/** Multipart request arrived without a Content-Length (chunked / unknown size). */
export class LengthRequiredError extends Error {
    readonly status = 411;
    readonly limit: number;
    constructor(limit: number) {
        super(`Content-Length required for multipart body (limit ${limit} bytes)`);
        this.name = "LengthRequiredError";
        this.limit = limit;
    }
}

/**
 * Reject before any body read (formData/json).
 *
 * - multipart/form-data with no Content-Length → 411. Chunked multipart is not
 *   bounded by a declared size, so it is refused at the ingress instead of
 *   being streamed up to the Bun cap.
 * - Content-Length over the JSON or multipart cap → 413.
 * - Non-multipart with no Content-Length falls through. Chunked JSON stays
 *   capped by Bun.serve maxRequestBodySize.
 *
 * Returns null when the request may proceed. CORS is applied by the router.
 */
export function rejectOversizedBody(req: Request, limits: BodyLimits): Response | null {
    const method = req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

    // Media types are case-insensitive (RFC 9110 §8.3.1).
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const multipart = contentType.includes("multipart/form-data");
    const raw = req.headers.get("content-length");
    if (raw == null || raw === "") {
        if (!multipart) return null;
        return new Response(
            JSON.stringify({
                error: "Length Required",
                code: "LENGTH_REQUIRED",
                limit: limits.multipart,
            }),
            {
                status: 411,
                headers: { "Content-Type": "application/json" },
            },
        );
    }

    const length = Number(raw);
    if (!Number.isFinite(length) || length < 0) return null;

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

/**
 * Throw before formData() when the ingress policy would reject the request.
 * 411 and 413 stay distinct so a missing length is not reported as oversize.
 */
export function assertBodyWithinLimit(req: Request, limits: BodyLimits): void {
    const rejected = rejectOversizedBody(req, limits);
    if (!rejected) return;
    if (rejected.status === 411) {
        throw new LengthRequiredError(limits.multipart);
    }
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    throw new PayloadTooLargeError(contentType.includes("multipart/form-data") ? limits.multipart : limits.json);
}
