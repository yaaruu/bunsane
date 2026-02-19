import { describe, test, expect } from 'bun:test';
import { securityHeaders } from '../../../core/middleware/SecurityHeaders';

const ok = async () => new Response('ok');

describe('securityHeaders middleware', () => {
    test('adds default security headers', async () => {
        const mw = securityHeaders();
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('sets HSTS in production', async () => {
        const mw = securityHeaders({ hsts: true });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    });

    test('custom hstsMaxAge', async () => {
        const mw = securityHeaders({ hsts: true, hstsMaxAge: 86400 });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=86400; includeSubDomains');
    });

    test('frameOptions SAMEORIGIN', async () => {
        const mw = securityHeaders({ frameOptions: 'SAMEORIGIN' });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    });

    test('frameOptions disabled', async () => {
        const mw = securityHeaders({ frameOptions: false });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('X-Frame-Options')).toBeNull();
    });

    test('noSniff disabled', async () => {
        const mw = securityHeaders({ noSniff: false });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('X-Content-Type-Options')).toBeNull();
    });

    test('referrerPolicy disabled', async () => {
        const mw = securityHeaders({ referrerPolicy: false });
        const res = await mw(new Request('http://localhost/'), ok);

        expect(res.headers.get('Referrer-Policy')).toBeNull();
    });

    test('preserves original response body and status', async () => {
        const handler = async () => new Response('hello', { status: 201 });
        const mw = securityHeaders();
        const res = await mw(new Request('http://localhost/'), handler);

        expect(res.status).toBe(201);
        expect(await res.text()).toBe('hello');
    });
});
