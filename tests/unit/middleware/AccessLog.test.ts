import { describe, test, expect, mock } from 'bun:test';
import { accessLog } from '../../../core/middleware/AccessLog';

const ok = async () => new Response('ok');

describe('accessLog middleware', () => {
    test('passes through and returns the response', async () => {
        const mw = accessLog();
        const res = await mw(new Request('http://localhost/test'), ok);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
    });

    test('skips configured paths', async () => {
        const mw = accessLog({ skip: ['/health'] });

        // Should still work, just not log
        const res = await mw(new Request('http://localhost/health'), ok);
        expect(res.status).toBe(200);
    });

    test('propagates errors from handler', async () => {
        const mw = accessLog();
        const failing = async () => { throw new Error('boom'); };

        expect(mw(new Request('http://localhost/'), failing)).rejects.toThrow('boom');
    });

    test('handles non-200 responses', async () => {
        const mw = accessLog();
        const notFound = async () => new Response('not found', { status: 404 });
        const res = await mw(new Request('http://localhost/missing'), notFound);

        expect(res.status).toBe(404);
    });
});
