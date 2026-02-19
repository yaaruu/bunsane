import { describe, test, expect } from 'bun:test';
import { requestId, getRequestId, requestStore } from '../../../core/middleware/RequestId';

const ok = async () => new Response('ok');

describe('requestId middleware', () => {
    test('generates a UUID and sets X-Request-Id header', async () => {
        const mw = requestId();
        const res = await mw(new Request('http://localhost/'), ok);

        const id = res.headers.get('X-Request-Id');
        expect(id).toBeTruthy();
        // UUID format check
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('respects incoming X-Request-Id header', async () => {
        const mw = requestId();
        const req = new Request('http://localhost/', {
            headers: { 'X-Request-Id': 'custom-id-123' },
        });
        const res = await mw(req, ok);

        expect(res.headers.get('X-Request-Id')).toBe('custom-id-123');
    });

    test('getRequestId() returns current request ID within middleware', async () => {
        const mw = requestId();
        let capturedId: string | undefined;

        const handler = async () => {
            capturedId = getRequestId();
            return new Response('ok');
        };

        const res = await mw(new Request('http://localhost/'), handler);
        const headerId = res.headers.get('X-Request-Id')!;

        expect(capturedId).toBe(headerId);
    });

    test('getRequestId() returns undefined outside request context', () => {
        expect(getRequestId()).toBeUndefined();
    });

    test('preserves original response body and status', async () => {
        const handler = async () => new Response('hello', { status: 201 });
        const mw = requestId();
        const res = await mw(new Request('http://localhost/'), handler);

        expect(res.status).toBe(201);
        expect(await res.text()).toBe('hello');
    });
});
