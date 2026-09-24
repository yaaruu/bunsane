import { createHash, timingSafeEqual } from "crypto";

export function bearerToken(headerValue: string | null): string | null {
    if (!headerValue) return null;
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match ? match[1]! : null;
}

/** Constant-time compare over SHA-256 digests so length differences don't leak. */
export function tokensMatch(provided: string, expected: string): boolean {
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
