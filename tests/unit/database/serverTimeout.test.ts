/**
 * Server-side deadline enforcement (`SET LOCAL statement_timeout`).
 *
 * A client-side abort does not stop the server — `query.cancel()` sends no
 * CancelRequest on Bun 1.4.0-canary.1 — so the only thing that actually returns
 * a pool slot is a server-side bound. These tests cover the DECISION rules and
 * the error translation, which are engine-independent.
 *
 * The positive path (a statement genuinely killed by the server, slot reusable
 * afterwards) cannot be faked: it lives in
 * `tests/integration/db-server-timeout.test.ts` and runs on real Postgres only.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    dbExec,
    dbTransaction,
    resetGateway,
    armGateway,
    isServerStatementTimeout,
    DbStatementTimeoutError,
} from '../../../database/gateway';
import { resetDbStats, setPoolMax } from '../../../database/instrumentedDb';

/** A server-side kill, as Postgres reports it (SQLSTATE 57014). */
function serverTimeoutError() {
    return Object.assign(
        new Error('ERR_POSTGRES_SERVER_ERROR: canceling statement due to statement timeout'),
        { code: 'ERR_POSTGRES_SERVER_ERROR' },
    );
}

/** Records every statement issued, and offers a transaction handle like Bun's. */
function recordingConn() {
    const statements: string[] = [];
    const conn: any = {
        unsafe: (sql: string) => { statements.push(sql); return Promise.resolve([]); },
        transaction: (fn: (trx: any) => Promise<any>) => fn(conn),
    };
    return { statements, conn };
}

beforeEach(() => {
    resetDbStats();
    setPoolMax(3);
    resetGateway();
    armGateway();
});

afterEach(() => {
    resetGateway();
    setPoolMax(0);
});

describe('server statement-timeout classification', () => {
    test('recognises the server kill by SQLSTATE and by message', () => {
        expect(isServerStatementTimeout(serverTimeoutError())).toBe(true);
        expect(isServerStatementTimeout({ code: '57014' })).toBe(true);
        expect(isServerStatementTimeout({ errno: '57014' })).toBe(true);
    });

    test('does not mistake a client cancel or an unrelated error for it', () => {
        // The distinction matters: a client cancel means the caller gave up and
        // the server is STILL RUNNING the statement; a server kill means the
        // work actually stopped and the slot came back. Conflating them would
        // reinstate exactly the false reassurance that made B8 unreadable.
        expect(isServerStatementTimeout(Object.assign(new Error('Query cancelled'), { name: 'AbortError' }))).toBe(false);
        expect(isServerStatementTimeout(new Error('duplicate key value violates unique constraint'))).toBe(false);
        expect(isServerStatementTimeout(undefined)).toBe(false);
    });
});

describe('translation of a server kill', () => {
    test('dbRun reports lane, label and budget instead of the raw PG message', async () => {
        const conn = { unsafe: () => Promise.reject(serverTimeoutError()) };

        const err = await dbExec('SELECT pg_sleep(9)', [], {
            conn,
            lane: 'background',
            label: 'slow.thing',
            timeoutMs: 1_000,
        }).catch((e) => e);

        // Without the translation the caller sees "canceling statement due to
        // statement timeout" — true, but silent about WHICH budget was
        // exceeded, which is the whole reason DbStatementTimeoutError exists.
        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(err.lane).toBe('background');
        expect(err.label).toBe('slow.thing');
        expect((err as any).cause?.message).toContain('canceling statement');
    });

    test('dbTransaction translates a kill raised on the raw trx handle', async () => {
        // saveEntity's writes go through `trx` directly, never through dbRun, so
        // the transaction wrapper is the only place they can be translated.
        const conn: any = {
            unsafe: () => Promise.resolve([]),
            transaction: (fn: (trx: any) => Promise<any>) => fn({
                unsafe: () => Promise.reject(serverTimeoutError()),
            }),
        };

        const err = await dbTransaction(
            async (trx: any) => { await trx.unsafe('UPDATE components SET data = data'); },
            { conn, lane: 'request', label: 'entity.save', timeoutMs: 1_000 },
        ).catch((e) => e);

        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(err.label).toBe('entity.save');
    });

    test('leaves an ordinary query failure alone', async () => {
        const conn = { unsafe: () => Promise.reject(new Error('relation "nope" does not exist')) };
        const err = await dbExec('SELECT 1', [], { conn, timeoutMs: 1_000 }).catch((e) => e);
        expect(err).not.toBeInstanceOf(DbStatementTimeoutError);
        expect(err.message).toContain('does not exist');
    });
});

describe('when the bound is deliberately NOT emitted', () => {
    test('not on a caller-supplied connection — SET LOCAL would outlive the savepoint', async () => {
        // `SET LOCAL` is transaction-scoped, not savepoint-scoped: releasing the
        // savepoint does not restore the previous value. Emitting here would
        // silently reset the statement_timeout of the consumer transaction we
        // are nested inside, for the rest of ITS lifetime.
        const { statements, conn } = recordingConn();

        await dbTransaction(async (trx: any) => { await trx.unsafe('SELECT 1'); }, {
            conn,
            timeoutMs: 5_000,
        });

        expect(statements.some((s) => s.includes('statement_timeout'))).toBe(false);
        expect(statements).toEqual(['SELECT 1']);
    });

    test('not when the caller owns the connection', async () => {
        const { statements, conn } = recordingConn();

        await dbTransaction(async (trx: any) => { await trx.unsafe('SELECT 1'); }, {
            conn,
            callerOwnsConn: true,
            timeoutMs: 5_000,
        });

        expect(statements.some((s) => s.includes('statement_timeout'))).toBe(false);
    });

    test('dbExec does not wrap a bare statement unless asked', async () => {
        // Wrapping a bare statement costs +0.95 ms / 3.7x on real PG (measured,
        // median of 300); the guard inside an existing transaction costs one
        // round trip, +0.40 ms on a 3.0 ms save.
        // On a read path issuing thousands of statements per request that is a
        // regression, not a safeguard — hence opt-in.
        const { statements, conn } = recordingConn();
        await dbExec('SELECT 1', [], { conn, timeoutMs: 5_000 });
        expect(statements).toEqual(['SELECT 1']);
    });

    test('serverTimeout on a caller-supplied conn stays a plain statement', async () => {
        // The statement is already inside the caller's transaction, which owns
        // the bound; opening a nested one here buys nothing and leaks the
        // setting past our savepoint.
        const { statements, conn } = recordingConn();
        await dbExec('SELECT 1', [], { conn, serverTimeout: true, timeoutMs: 5_000 });
        expect(statements).toEqual(['SELECT 1']);
    });
});

// The remaining rule — an already-spent budget must FAIL rather than emit
// `statement_timeout = 0` (which disables the timeout in Postgres) — is only
// reachable against a real pool, since emission is skipped whenever `conn` is
// supplied. It is asserted in tests/integration/db-server-timeout.test.ts.
