import { describe, test, expect } from 'bun:test';
import { composeMiddleware, type Middleware } from '../../../core/Middleware';

describe('composeMiddleware', () => {
    test('calls final handler when no middleware', async () => {
        const handler = async (req: Request) => new Response('ok');
        const composed = composeMiddleware([], handler);
        const res = await composed(new Request('http://localhost/'));
        expect(await res.text()).toBe('ok');
    });

    test('executes middleware in order (onion model)', async () => {
        const order: string[] = [];

        const mw1: Middleware = async (req, next) => {
            order.push('mw1-before');
            const res = await next();
            order.push('mw1-after');
            return res;
        };

        const mw2: Middleware = async (req, next) => {
            order.push('mw2-before');
            const res = await next();
            order.push('mw2-after');
            return res;
        };

        const handler = async (req: Request) => {
            order.push('handler');
            return new Response('ok');
        };

        const composed = composeMiddleware([mw1, mw2], handler);
        await composed(new Request('http://localhost/'));

        expect(order).toEqual([
            'mw1-before',
            'mw2-before',
            'handler',
            'mw2-after',
            'mw1-after',
        ]);
    });

    test('middleware can short-circuit (skip next)', async () => {
        const mw: Middleware = async (req, next) => {
            return new Response('blocked', { status: 403 });
        };

        const handler = async (req: Request) => new Response('ok');
        const composed = composeMiddleware([mw], handler);
        const res = await composed(new Request('http://localhost/'));
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('blocked');
    });

    test('middleware can modify the response', async () => {
        const mw: Middleware = async (req, next) => {
            const res = await next();
            const headers = new Headers(res.headers);
            headers.set('X-Custom', 'test');
            return new Response(res.body, {
                status: res.status,
                headers,
            });
        };

        const handler = async (req: Request) => new Response('ok');
        const composed = composeMiddleware([mw], handler);
        const res = await composed(new Request('http://localhost/'));
        expect(res.headers.get('X-Custom')).toBe('test');
    });

    test('errors propagate through middleware chain', async () => {
        const mw: Middleware = async (req, next) => {
            return next();
        };

        const handler = async (req: Request) => {
            throw new Error('boom');
        };

        const composed = composeMiddleware([mw], handler);
        expect(composed(new Request('http://localhost/'))).rejects.toThrow('boom');
    });

    test('rejects if next() called multiple times', async () => {
        const mw: Middleware = async (req, next) => {
            await next();
            return next(); // second call should reject
        };

        const handler = async (req: Request) => new Response('ok');
        const composed = composeMiddleware([mw], handler);
        expect(composed(new Request('http://localhost/'))).rejects.toThrow('next() called multiple times');
    });
});
