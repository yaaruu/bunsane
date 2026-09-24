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
    ctx?: { clientIp?: string },
): Promise<[Response, Response]> {
    const mw = rateLimit({ max: 1, windowMs: 60_000, ...opts });
    const next = async () => new Response('ok');
    return [await mw(r1, next, ctx), await mw(r2, next, ctx)];
}

describe('rate limit key trust', () => {
    test('trustProxy=false: spoofed headers do not create buckets and do not share one', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-real-ip': '9.9.9.9' }),
            requestWith({ 'x-real-ip': '8.8.8.8' }),
        );
        // No socket IP → fail open. Spoofed headers must not be the key.
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
    });

    test('trustProxy=false: spoofed XFF is ignored too', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-forwarded-for': '7.7.7.7' }),
            requestWith({ 'x-forwarded-for': '6.6.6.6' }),
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
    });

    test('socket IP keys the bucket; spoofed headers do not split it', async () => {
        const [r1, r2] = await runTwice(
            requestWith({ 'x-real-ip': '9.9.9.9' }),
            requestWith({ 'x-real-ip': '8.8.8.8' }),
            undefined,
            { clientIp: '203.0.113.10' },
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
    });

    test('different socket IPs do not share a bucket', async () => {
        const mw = rateLimit({ max: 1, windowMs: 60_000 });
        const next = async () => new Response('ok');
        const req = requestWith({ 'x-real-ip': '1.1.1.1' });
        expect((await mw(req, next, { clientIp: '203.0.113.1' })).status).toBe(200);
        expect((await mw(req, next, { clientIp: '203.0.113.2' })).status).toBe(200);
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
        const [, limited] = await runTwice(
            requestWith({}),
            requestWith({}),
            undefined,
            { clientIp: '203.0.113.50' },
        );
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBeDefined();
        expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
});
