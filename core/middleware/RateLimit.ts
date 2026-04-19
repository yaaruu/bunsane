import type { Middleware } from '../Middleware';
import { logger as MainLogger } from '../Logger';

const logger = MainLogger.child({ scope: 'RateLimit' });

export type RateLimitOptions = {
    /** Maximum requests in the window. Default: 100 */
    max?: number;
    /** Window length in milliseconds. Default: 60_000 (1 min) */
    windowMs?: number;
    /** Only apply to paths matching this prefix list. Default: all */
    pathPrefixes?: string[];
    /** Extract client key (override default: X-Forwarded-For → remote). */
    keyExtractor?: (req: Request) => string;
    /** Response status for rejection. Default: 429 */
    status?: number;
    /** Trust X-Forwarded-For header. Default: false */
    trustProxy?: boolean;
};

type Bucket = {
    count: number;
    resetAt: number;
};

/**
 * In-memory token-bucket rate limiter. Per-instance only — for multi-instance
 * deployments use a shared Redis-backed limiter. Sweeps expired buckets on
 * each increment to keep memory bounded.
 */
export function rateLimit(options: RateLimitOptions = {}): Middleware {
    const max = options.max ?? 100;
    const windowMs = options.windowMs ?? 60_000;
    const pathPrefixes = options.pathPrefixes;
    const status = options.status ?? 429;
    const trustProxy = options.trustProxy ?? false;
    const keyExtractor = options.keyExtractor ?? ((req: Request) => {
        if (trustProxy) {
            const xff = req.headers.get('x-forwarded-for');
            if (xff) return xff.split(',')[0]!.trim();
        }
        const realIp = req.headers.get('x-real-ip');
        if (realIp) return realIp;
        return 'anonymous';
    });

    const buckets = new Map<string, Bucket>();
    let lastSweep = Date.now();

    return async (req, next) => {
        if (pathPrefixes && pathPrefixes.length > 0) {
            const url = new URL(req.url);
            const match = pathPrefixes.some((p) => url.pathname.startsWith(p));
            if (!match) return next();
        }

        const now = Date.now();
        const key = keyExtractor(req);

        if (now - lastSweep > windowMs) {
            for (const [k, v] of buckets) {
                if (v.resetAt <= now) buckets.delete(k);
            }
            lastSweep = now;
        }

        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count++;
        const remaining = Math.max(0, max - bucket.count);
        const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);

        if (bucket.count > max) {
            logger.warn({ key, path: new URL(req.url).pathname, count: bucket.count, max }, 'rate limit exceeded');
            return new Response(
                JSON.stringify({ error: 'Too many requests', retryAfter: retryAfterSec }),
                {
                    status,
                    headers: {
                        'Content-Type': 'application/json',
                        'Retry-After': String(retryAfterSec),
                        'X-RateLimit-Limit': String(max),
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': String(Math.floor(bucket.resetAt / 1000)),
                    },
                },
            );
        }

        const response = await next();
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-RateLimit-Limit', String(max));
        newHeaders.set('X-RateLimit-Remaining', String(remaining));
        newHeaders.set('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    };
}
