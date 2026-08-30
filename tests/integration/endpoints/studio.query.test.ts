/**
 * SEC-02 integration: server-side row bounds + error masking for the
 * Studio ad-hoc runner. Requires BUNSANE_STUDIO_QUERY=on.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { handleStudioQueryRequest } from '../../../endpoints/query';
import db from '../../../database/index';

const originalFlag = process.env.BUNSANE_STUDIO_QUERY;

beforeEach(() => {
    process.env.BUNSANE_STUDIO_QUERY = 'on';
});

afterEach(() => {
    if (originalFlag === undefined) delete process.env.BUNSANE_STUDIO_QUERY;
    else process.env.BUNSANE_STUDIO_QUERY = originalFlag;
});

describe('ad-hoc runner row bound', () => {
    test('large result set is bounded server-side to MAX_ROWS', async () => {
        const res = await handleStudioQueryRequest({
            sql: 'SELECT generate_series(1, 1000) AS g',
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rowCount).toBeLessThanOrEqual(500);
        expect(body.rows.length).toBeLessThanOrEqual(500);
    });

    test('a comment containing LIMIT can no longer bypass the row bound', async () => {
        const res = await handleStudioQueryRequest({
            sql: '/* LIMIT 99999999 */ SELECT generate_series(1, 600) AS g',
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Old behaviour fetched all 600; wrapping bounds it server-side.
        expect(body.rowCount).toBe(500);
    });

    test('string-literal keyword is harmless and executes', async () => {
        const res = await handleStudioQueryRequest({
            sql: "SELECT 'DROP TABLE users' AS note",
        });
        expect(res.status).toBe(200);
        expect((await res.json()).rows[0].note).toBe('DROP TABLE users');
    });
});

describe('ad-hoc runner is read-only (SEC-02)', () => {
    // A sequence advance (`nextval`) is a genuine write that the sqlGuard does
    // NOT block (no forbidden keyword) — exactly the function-side-effect vector
    // keyword blacklisting misses. Postgres refuses it inside a read-only
    // transaction; without SET LOCAL transaction_read_only it returns a number.
    //
    // Real PG only: PGlite (WASM PG) does not enforce transaction_read_only, the
    // same real-PG-only class the repo documents PGlite as masking. The read-only
    // wrap is proven harmless under PGlite by the plain-SELECT test, which runs
    // everywhere.
    const onRealPg = process.env.USE_PGLITE === 'true' ? test.skip : test;

    beforeAll(async () => {
        if (process.env.USE_PGLITE === 'true') return;
        await (db as any).unsafe('CREATE SEQUENCE IF NOT EXISTS sec02_ro_seq');
    });
    afterAll(async () => {
        if (process.env.USE_PGLITE === 'true') return;
        try { await (db as any).unsafe('DROP SEQUENCE IF EXISTS sec02_ro_seq'); } catch { /* cleanup */ }
    });

    onRealPg('a write via nextval() is refused by the read-only transaction', async () => {
        const res = await handleStudioQueryRequest({ sql: "SELECT nextval('sec02_ro_seq')" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('Query failed');
        expect(JSON.stringify(body)).not.toContain('read-only'); // detail stays masked
    });

    test('a plain SELECT still returns rows through the read-only path', async () => {
        const res = await handleStudioQueryRequest({ sql: 'SELECT 1 AS one, 2 AS two' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows.length).toBe(1);
        expect(body.rows[0].one).toBe(1);
        expect(body.rows[0].two).toBe(2);
    });
});

describe('ad-hoc runner error masking', () => {
    test('PG internals are not echoed to the client', async () => {
        const res = await handleStudioQueryRequest({
            sql: 'SELECT * FROM table_that_does_not_exist_zz',
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('Relation or column does not exist');
        expect(JSON.stringify(body)).not.toContain('table_that_does_not_exist_zz');
        expect(JSON.stringify(body).toLowerCase()).not.toContain('relation "');
    });

    test('syntax errors classify without raw positions detail', async () => {
        const res = await handleStudioQueryRequest({
            sql: 'SELEC 1',
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('Syntax error in SQL statement');
    });
});
