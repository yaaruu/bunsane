/**
 * RPC/outbox envelope signing (SEC-12).
 *
 * When `BUNSANE_RPC_SECRET` is unset, envelopes are unsigned and accepted
 * (legacy). Redis must still be authenticated and network-isolated — signing
 * is the bar for a shared/multi-tenant Redis, not a substitute for it.
 *
 * When the secret is set, producers attach `sig` (HMAC-SHA256 over canonical
 * JSON of every other field) and consumers reject unsigned or tampered
 * envelopes (fail-closed).
 */
import { createHmac, timingSafeEqual } from "crypto";

export const RPC_SECRET_ENV = "BUNSANE_RPC_SECRET";

/** Response XADD targets must live under this prefix. Instance id follows. */
export const RPC_RESPONSE_STREAM_PREFIX = "rpc:responses:";

let warnedUnset = false;

export function readRpcSecret(): string | undefined {
    const raw = process.env[RPC_SECRET_ENV];
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    return raw;
}

export function warnIfRpcSecretUnset(log: { warn: (obj: object, msg?: string) => void }): void {
    if (warnedUnset || readRpcSecret()) return;
    warnedUnset = true;
    log.warn(
        { env: RPC_SECRET_ENV },
        "BUNSANE_RPC_SECRET is unset — RPC/outbox envelopes are unsigned. Redis MUST be authenticated and network-isolated. Set the secret to require HMAC signatures (fail-closed)."
    );
}

function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === "object") {
        const src = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(src).sort()) {
            out[key] = sortValue(src[key]);
        }
        return out;
    }
    return value;
}

/**
 * HMAC input is the JSON wire shape (`Date` / `toJSON` already applied),
 * with only the top-level `sig` removed. Nested `sig` fields stay in the
 * signed body so they cannot be swapped after signing.
 */
function canonicalJson(value: unknown): string {
    const wire = JSON.parse(JSON.stringify(value ?? null)) as unknown;
    if (wire && typeof wire === "object" && !Array.isArray(wire)) {
        delete (wire as Record<string, unknown>).sig;
    }
    return JSON.stringify(sortValue(wire));
}

export function signCanonical(envelope: object, secret: string): string {
    return createHmac("sha256", secret).update(canonicalJson(envelope)).digest("hex");
}

function signaturesMatch(provided: string, expected: string): boolean {
    if (provided.length !== expected.length || provided.length === 0) return false;
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0 || a.length * 2 !== provided.length) return false;
    return timingSafeEqual(a, b);
}

export function verifyEnvelopeSignature(envelope: object, secret: string): boolean {
    if (!envelope || typeof envelope !== "object") return false;
    const sig = (envelope as { sig?: unknown }).sig;
    if (typeof sig !== "string") return false;
    return signaturesMatch(sig, signCanonical(envelope, secret));
}

/** JSON-encode an envelope, attaching `sig` when a secret is configured. */
export function encodeEnvelope(envelope: Record<string, unknown>): string {
    const secret = readRpcSecret();
    if (!secret) return JSON.stringify(envelope);
    return JSON.stringify({ ...envelope, sig: signCanonical(envelope, secret) });
}

/**
 * `replyTo` must be `rpc:responses:<instanceId>`. Anything else can redirect
 * RPC results into an arbitrary stream.
 */
export function isAllowedReplyTo(replyTo: unknown): replyTo is string {
    if (typeof replyTo !== "string") return false;
    if (!replyTo.startsWith(RPC_RESPONSE_STREAM_PREFIX)) return false;
    const rest = replyTo.slice(RPC_RESPONSE_STREAM_PREFIX.length);
    return rest.length > 0 && rest.length <= 128 && /^[A-Za-z0-9._-]+$/.test(rest);
}
