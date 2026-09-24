/**
 * In-memory dedupe of successfully processed `(sourceApp, correlationId)` pairs.
 *
 * Outbox publish is at-least-once: a crash after XADD and before `published_at`
 * republishes the same logical event under a new Redis id. The envelope's
 * `correlationId` (outbox row id for events, RPC correlation id for calls) is
 * stable across that republish. This cache drops the duplicate inside the
 * retention window. It does not survive process restart — handlers that must
 * be exactly-once across restarts need their own store.
 *
 * Failed deliveries are not recorded, so PEL redelivery still retries them.
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const seen = new Map<string, number>();

function keyOf(sourceApp: string, correlationId: string): string {
    return `${sourceApp}\0${correlationId}`;
}

function prune(now: number): void {
    if (seen.size < MAX_ENTRIES && seen.size % 64 !== 0) return;
    for (const [key, expiresAt] of seen) {
        if (expiresAt <= now) seen.delete(key);
    }
    while (seen.size >= MAX_ENTRIES) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
    }
}

export function alreadyProcessed(sourceApp: string, correlationId: string, now = Date.now()): boolean {
    const exp = seen.get(keyOf(sourceApp, correlationId));
    if (exp == null) return false;
    if (exp <= now) {
        seen.delete(keyOf(sourceApp, correlationId));
        return false;
    }
    return true;
}

export function rememberProcessed(
    sourceApp: string,
    correlationId: string,
    now = Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
): void {
    prune(now);
    seen.set(keyOf(sourceApp, correlationId), now + windowMs);
}

export function resetIdempotencyCache(): void {
    seen.clear();
}
