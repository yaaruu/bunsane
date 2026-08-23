/**
 * SEC-05: rate-limit key extraction must not trust client-supplied headers
 * unless a trusted proxy is declared.
 */
import { describe, test, expect } from 'bun:test';
import { rateLimit } from '../../../core/middleware/RateLimit';

function requestWith(headers: Record<string, string>): Request {
    return new Request('https://srv.test/thing', { headers });
}

/** One limiter per test: buckets live in the closure, so share the instance. */
async function runTwice(
    r1: Request,
    r2: Request,
    opts?: Parameters<typeof rateLimit>[0],
): Promise<[Response, Response]> {
    const mw = rateLimit({ max: 1, windowMs: 60_000, ...opts });
    const next = async () => new Response('ok');
    return [await mw(r1, next), await mw(r2, next)];
}

describe('rate limit key trust', () => {
    test('trustProxy=false: spoofed X-Real-IP does not create per-client buckets', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-real-ip': '9.9.9.9' }),
            requestWith({ 'x-real-ip': '8.8.8.8' }),
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
    });

    test('trustProxy=false: spoofed XFF is ignored too', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-forwarded-for': '7.7.7.7' }),
            requestWith({ 'x-forwarded-for': '6.6.6.6' }),
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
    });

    test('trustProxy=true: XFF leftmost hop keys the bucket', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-forwarded-for': '5.5.5.5, 10.0.0.1' }),
            requestWith({ 'x-forwarded-for': '5.5.5.5, 10.0.0.1' }),
            { trustProxy: true },
        );
        // Same client IP → same bucket → second is limited.
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
    });

    test('trustProxy=true falls back to X-Real-IP when no XFF', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-real-ip': '3.3.3.3' }),
            requestWith({ 'x-real-ip': '3.3.3.3' }),
            { trustProxy: true },
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
    });

    test('custom keyExtractor overrides everything', async () => {
        const keyExtractor = (req: Request) =>
            req.headers.get('x-api-key') ?? 'none';
        const mw = rateLimit({ max: 1, windowMs: 60_000, keyExtractor });
        const next = async () => new Response('ok');
        expect((await mw(requestWith({ 'x-api-key': 'k1' }), next)).status).toBe(200);
        expect((await mw(requestWith({ 'x-api-key': 'k2' }), next)).status).toBe(200);
    });

    test('limit response carries retry metadata', async () => {
        const [, limited] = await runTwice(requestWith({}), requestWith({}));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBeDefined();
        expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
});
