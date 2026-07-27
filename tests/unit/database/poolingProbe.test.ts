/**
 * Pooling detection is one-directional, and these tests pin that down.
 *
 * Distinct backend PIDs across separate statements on ONE client connection can
 * only happen under transaction pooling, so `proven` is sound. Identical PIDs
 * prove nothing — PgBouncer returns connections LIFO, so an idle transaction-pooled
 * pool hands back the same backend every time and is indistinguishable from
 * session pooling. Reporting that as `transactionPooling: false` has twice been
 * read as "no pooler in front of this deployment": once at 0.5.10 boot on
 * production, once as a first-run flake after a vendor swap.
 *
 * Hence `poolingOutcome`. The boolean stays for the proven case; the third state
 * is what stops a quiet probe from being used as evidence.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { probeConnection, resetConnectionProbe } from '../../../database/connectionProbe';

/**
 * A fake pool that answers `pg_backend_pid()` from a scripted list of PIDs and
 * `SHOW statement_timeout` with a fixed value.
 *
 * No `reserve()`: `probeConnection` falls back to using the pool directly, which
 * is the path that matters here — what varies is only which PIDs come back.
 */
function fakeSql(pids: number[], statementTimeout = '15s') {
    let next = 0;
    const sql: any = (strings: TemplateStringsArray) => {
        const text = strings.join('');
        if (text.includes('pg_backend_pid')) {
            return Promise.resolve([{ pid: pids[Math.min(next++, pids.length - 1)] }]);
        }
        if (text.includes('statement_timeout')) {
            return Promise.resolve([{ statement_timeout: statementTimeout }]);
        }
        return Promise.resolve([]);
    };
    return sql;
}

const saved = {
    pglite: process.env.USE_PGLITE,
    probeCancel: process.env.BUNSANE_PROBE_CANCEL,
};

/**
 * Scoped to this file's run, NOT to module load.
 *
 * `bun test` executes every file in one process, so clearing `USE_PGLITE` at
 * import time would unset it for whatever imports afterwards — a unit file
 * quietly reaching for a real database it was never meant to touch.
 */
beforeAll(() => {
    // These tests are about the non-PGlite path, which `probeConnection` skips.
    delete process.env.USE_PGLITE;
    // Cancel effectiveness is measured in cancelProbe.test.ts; leaving it on
    // here would run a real `pg_sleep` against a fake connection.
    process.env.BUNSANE_PROBE_CANCEL = 'off';
});

afterAll(() => {
    if (saved.pglite === undefined) delete process.env.USE_PGLITE;
    else process.env.USE_PGLITE = saved.pglite;
    if (saved.probeCancel === undefined) delete process.env.BUNSANE_PROBE_CANCEL;
    else process.env.BUNSANE_PROBE_CANCEL = saved.probeCancel;
});

afterEach(() => {
    resetConnectionProbe();
});

describe('pooling detection', () => {
    test('distinct backends prove transaction pooling', async () => {
        const r = await probeConnection(fakeSql([101, 102, 103]));

        expect(r.transactionPooling).toBe(true);
        expect(r.poolingOutcome).toBe('proven');
    });

    test('one backend for every statement is UNPROVEN, not "session pooled"', async () => {
        // The exact shape of the false negative: an idle pgbouncer in transaction
        // mode looks identical to this.
        const r = await probeConnection(fakeSql([101, 101, 101]));

        expect(r.transactionPooling).toBe(false);
        expect(r.poolingOutcome).toBe('unproven-idle-pool');
    });

    test('two of three distinct is still proof — one reassignment is enough', async () => {
        const r = await probeConnection(fakeSql([101, 101, 102]));

        expect(r.transactionPooling).toBe(true);
        expect(r.poolingOutcome).toBe('proven');
    });

    test('a probe that observed nothing is skipped, not unproven', async () => {
        // No PIDs at all means the probe never got an answer, which is a
        // different thing from getting the same answer three times.
        const failing: any = () => Promise.reject(new Error('connection refused'));
        const r = await probeConnection(failing);

        expect(r.backendPids).toEqual([]);
        expect(r.transactionPooling).toBe(false);
        expect(r.poolingOutcome).toBe('skipped');
    });
});
