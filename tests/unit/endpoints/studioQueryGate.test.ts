/**
 * SEC-02: request gating for the Studio ad-hoc query runner.
 *
 * The old gate enabled the console whenever NODE_ENV !== 'production' — i.e.
 * by default in any container that never set it. These pin the explicit
 * opt-in flag and the guard-driven rejections.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { handleStudioQueryRequest } from '../../../endpoints/query';

const originalFlag = process.env.BUNSANE_STUDIO_QUERY;

beforeEach(() => {
    delete process.env.BUNSANE_STUDIO_QUERY;
});

afterEach(() => {
    if (originalFlag === undefined) delete process.env.BUNSANE_STUDIO_QUERY;
    else process.env.BUNSANE_STUDIO_QUERY = originalFlag;
});

describe('ad-hoc runner gating', () => {
    test('disabled by default — even with NODE_ENV unset', async () => {
        delete process.env.NODE_ENV;
        const res = await handleStudioQueryRequest({ sql: 'SELECT 1' });
        expect(res.status).toBe(404);
    });

    test('NODE_ENV=development alone does NOT enable it', async () => {
        process.env.NODE_ENV = 'development';
        const res = await handleStudioQueryRequest({ sql: 'SELECT 1' });
        expect(res.status).toBe(404);
    });

    test('BUNSANE_STUDIO_QUERY=on enables it', async () => {
        process.env.BUNSANE_STUDIO_QUERY = 'on';
        process.env.NODE_ENV = 'production';
        // Production + on → passes the gate; the DB layer may fail but the
        // response must not be the 404 "off" answer.
        const res = await handleStudioQueryRequest({ sql: 'SELECT 1' });
        expect(res.status).not.toBe(404);
    });
});

describe('ad-hoc runner vetting', () => {
    beforeEach(() => {
        process.env.BUNSANE_STUDIO_QUERY = 'on';
    });

    test('empty/missing sql rejected', async () => {
        expect((await handleStudioQueryRequest({ sql: '' })).status).toBe(400);
        expect((await handleStudioQueryRequest({ sql: '   ' })).status).toBe(400);
    });

    test('multi-statement payload rejected before execution', async () => {
        const res = await handleStudioQueryRequest({
            sql: 'SELECT 1; SELECT 2',
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('single SQL statement');
    });

    test('keyword-hidden-in-comment still executes (comments are inert)', async () => {
        process.env.BUNSANE_STUDIO_QUERY = 'on';
        const res = await handleStudioQueryRequest({
            sql: "/* DROP TABLE users */ SELECT 'hello' AS greeting",
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows[0].greeting).toBe('hello');
    });
});
