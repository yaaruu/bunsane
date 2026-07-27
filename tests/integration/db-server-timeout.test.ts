/**
 * The bound that actually stops work — real Postgres only.
 *
 * B8a: `query.cancel()` sends no CancelRequest on Bun 1.4.0-canary.1, so an
 * abandoned statement runs to completion and holds its pool slot for its real
 * duration. Identical direct and through PgBouncer — a driver property, not a
 * pooling one. Every client-side timeout in the framework therefore bounds the
 * CALLER only.
 *
 * `SET LOCAL statement_timeout` is what bounds the SERVER, and the property
 * that matters is not just "the caller got an error quickly" — a client abort
 * does that too, while the slot stays pinned. It is "the caller got an error
 * AND the slot came back". These tests assert both.
 *
 * PGlite is excluded deliberately, not incidentally: it is a single-connection
 * in-process engine where the pool-pinning failure cannot occur, and emission
 * is skipped there (same precedent as `DB_STATEMENT_TIMEOUT`).
 */
import { describe, test, expect } from 'bun:test';
import db from '../../database';
import { dbExec, dbTransaction, DbStatementTimeoutError } from '../../database/gateway';
import { probeCancelEffectiveness } from '../../database/connectionProbe';
const isPGlite = process.env.USE_PGLITE === 'true';

/**
 * NOT covered here: `entity.save()` blowing its own budget.
 *
 * `saveEntity`'s client backstop now fires `SAVE_CLIENT_BACKSTOP_MS` after the
 * deadline it hands the gateway, so the server's `DbStatementTimeoutError` wins
 * the race instead of a plain `Error` — but forcing a save to exceed its budget
 * needs `QUERY_TIMEOUT_MS` small at import, and that budget applies to the
 * harness too: `DB_QUERY_TIMEOUT=15` was not tight enough (a save takes ~3 ms)
 * and `=3` failed the file during boot. The error-type property is covered by
 * the transaction tests below, which take the same path.
 */

describe.skipIf(isPGlite)('server-side statement timeout', () => {
    test('dbTransaction kills a statement that outlives its budget', async () => {
        const t0 = performance.now();
        const err = await dbTransaction(
            async (trx: any) => { await trx.unsafe('SELECT pg_sleep(6)'); },
            { lane: 'background', label: 'test.sleep', timeoutMs: 800 },
        ).catch((e) => e);
        const elapsed = performance.now() - t0;

        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(err.label).toBe('test.sleep');
        // Well under the statement's own 6 s: proof the SERVER stopped it, since
        // dbTransaction has no client-side timer of its own.
        expect(elapsed).toBeLessThan(3_000);
    });

    test('the pool slot is reusable immediately afterwards', async () => {
        await dbTransaction(
            async (trx: any) => { await trx.unsafe('SELECT pg_sleep(6)'); },
            { lane: 'background', label: 'test.sleep', timeoutMs: 500 },
        ).catch(() => {});

        // The distinguishing property. After a client-side abort the slot stays
        // busy for the statement's full 6 s; after a server-side kill it is back
        // in 1-2 ms (measured on both topologies).
        const t0 = performance.now();
        const rows = await dbExec<any[]>('SELECT 1 AS ok', []);
        const elapsed = performance.now() - t0;

        expect(rows[0].ok).toBe(1);
        expect(elapsed).toBeLessThan(1_000);
    });

    test('the setting does not leak past the transaction', async () => {
        // `SET LOCAL`, not `SET`. Under transaction pooling the server
        // connection is handed to the next client at COMMIT, so a session-level
        // setting would make one caller's 500 ms budget everybody's.
        await dbTransaction(async (trx: any) => { await trx.unsafe('SELECT 1'); }, { timeoutMs: 500 });

        const shown = await dbExec<any[]>('SHOW statement_timeout', []);
        expect(shown[0].statement_timeout).not.toBe('500ms');
    });

    test('dbExec enforces server-side when it opts in', async () => {
        const err = await dbExec('SELECT pg_sleep(6)', [], {
            lane: 'background',
            label: 'studio.sleep',
            timeoutMs: 800,
            serverTimeout: true,
        }).catch((e) => e);

        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(err.label).toBe('studio.sleep');
    });

    test('an already-spent budget refuses rather than running unbounded', async () => {
        // `statement_timeout = 0` disables the timeout, so a non-positive budget
        // must fail here instead of opening a transaction with no bound at all.
        const err = await dbTransaction(
            async (trx: any) => { await trx.unsafe('SELECT 1'); },
            { deadline: Date.now() - 10, label: 'spent' },
        ).catch((e) => e);

        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(err.label).toBe('spent');
    });

    test('the boot probe reproduces the known cancel behaviour on this driver', async () => {
        // TRIPWIRE. `query.cancel()` sends no CancelRequest on Bun
        // 1.4.0-canary.1, so this must report ineffective. If it ever fails,
        // the driver changed — and `runWithSignal`, docs/POOLING.md B8a and the
        // whole justification for the server-side bound need rereading, not
        // this assertion relaxing.
        const conn = await (db as any).reserve();
        try {
            const r = await probeCancelEffectiveness(conn, null, 250);
            expect(r.outcome).toBe('ran-to-completion');
            expect(r.effective).toBe(false);
        } finally {
            conn.release?.();
        }
    });

    test('a live statement_timeout is not mistaken for a working cancel', async () => {
        // The probe's own sleep gets killed by the SERVER here, early and with
        // SQLSTATE 57014 — indistinguishable from a successful cancel on timing
        // alone. Passing `null` as the server bound simulates a probe that does
        // not know about the role-level setting, which is precisely when the
        // message-text check has to carry it.
        const conn = await (db as any).reserve();
        try {
            await conn.unsafe(`SET statement_timeout = '60ms'`);
            const r = await probeCancelEffectiveness(conn, null, 300);

            expect(r.effective).not.toBe(true);
            expect(r.outcome).toBe('preempted-by-statement-timeout');
        } finally {
            await conn.unsafe(`SET statement_timeout = 0`).catch(() => {});
            conn.release?.();
        }
    });

    test('BUNSANE_DB_SERVER_TIMEOUT=off restores the old, client-only behaviour', async () => {
        // The kill switch exists so a deployment can bisect without a code
        // change. Asserting it here keeps the escape hatch honest: with the
        // bound off, the same statement is NOT killed at its budget.
        const prev = process.env.BUNSANE_DB_SERVER_TIMEOUT;
        process.env.BUNSANE_DB_SERVER_TIMEOUT = 'off';
        try {
            const rows = await dbTransaction(
                async (trx: any) => await trx.unsafe('SELECT pg_sleep(1) AS slept'),
                { lane: 'background', label: 'test.unbounded', timeoutMs: 200 },
            );
            expect(rows.length).toBe(1);
        } finally {
            if (prev === undefined) delete process.env.BUNSANE_DB_SERVER_TIMEOUT;
            else process.env.BUNSANE_DB_SERVER_TIMEOUT = prev;
        }
    });
});
