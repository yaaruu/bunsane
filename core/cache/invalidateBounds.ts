/**
 * Bounds for pattern cache invalidation (SEC-13).
 * Shared by RedisCache (SCAN cap + prefix) and MemoryCache (glob cap).
 */

export const DEFAULT_CACHE_INVALIDATE_MAX = 10_000;

export class CacheInvalidateCapExceededError extends Error {
    readonly pattern: string;
    readonly max: number;

    constructor(pattern: string, max: number) {
        super(
            `invalidatePattern(${JSON.stringify(pattern)}) exceeded BUNSANE_CACHE_INVALIDATE_MAX (${max}); aborted without deleting`
        );
        this.name = 'CacheInvalidateCapExceededError';
        this.pattern = pattern;
        this.max = max;
    }
}

/** Keys collected before a pattern delete must stop. Read at call time so tests can override. */
export function cacheInvalidateMax(): number {
    const raw = process.env.BUNSANE_CACHE_INVALIDATE_MAX;
    if (raw === undefined || raw.trim() === '') return DEFAULT_CACHE_INVALIDATE_MAX;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_CACHE_INVALIDATE_MAX;
    return Math.floor(n);
}

/**
 * The effective Redis MATCH must have a literal prefix so SCAN cannot walk
 * an entire shared database. `*` / `?foo` / empty are rejected. A configured
 * key prefix applied before this check (`bunsane:*`) satisfies it.
 */
export function assertScopedInvalidatePattern(effectivePattern: string): void {
    const literal = effectivePattern.split(/[*?[\]]/)[0] ?? '';
    if (literal.length === 0) {
        throw new Error(
            `invalidatePattern requires a literal key prefix (pattern ${JSON.stringify(effectivePattern)} would scan the whole keyspace). ` +
            `Set a Redis keyPrefix or pass a prefixed pattern such as "component:entityId:*".`
        );
    }
}

/**
 * Linear glob match for `*` (any run) and `?` (one char). Other characters
 * are literal — never interpolated into a RegExp (SEC-13 ReDoS).
 */
export function matchGlob(pattern: string, text: string): boolean {
    let pi = 0;
    let ti = 0;
    let star = -1;
    let mark = 0;
    while (ti < text.length) {
        if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
            pi++;
            ti++;
        } else if (pi < pattern.length && pattern[pi] === '*') {
            star = pi;
            pi++;
            mark = ti;
        } else if (star !== -1) {
            pi = star + 1;
            ti = ++mark;
        } else {
            return false;
        }
    }
    while (pi < pattern.length && pattern[pi] === '*') pi++;
    return pi === pattern.length;
}

/** Yield so a SCAN/delete loop cannot pin the event loop for a full keyspace walk. */
export function yieldEventLoop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    return promise;
}

export type ScanPage = { cursor: string; keys: string[] };

/**
 * Walk SCAN pages until the cursor returns to 0. Throws without returning a
 * partial list when the match set exceeds `max`, so the caller can abort
 * before any delete.
 */
export async function collectScanKeys(
    scanPage: (cursor: string) => Promise<ScanPage>,
    max: number,
    pattern: string,
): Promise<string[]> {
    const keysToDelete: string[] = [];
    let cursor = '0';
    do {
        const page = await scanPage(cursor);
        cursor = page.cursor;
        for (const key of page.keys) {
            keysToDelete.push(key);
            if (keysToDelete.length > max) {
                throw new CacheInvalidateCapExceededError(pattern, max);
            }
        }
        await yieldEventLoop();
    } while (cursor !== '0');
    return keysToDelete;
}
