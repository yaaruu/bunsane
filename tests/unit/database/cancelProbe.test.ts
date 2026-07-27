/**
 * The boot probe that answers "does a timeout actually reclaim the connection?"
 *
 * It used to be inferred from pooling mode, which was wrong twice: cancellation
 * is a driver property, and pooling mode does not predict it. The probe now
 * measures it — and these tests cover the ways a measurement like this lies:
 *
 *  - a server-side `statement_timeout` killing the probe's own statement, which
 *    looks exactly like a working cancel unless the message text is read;
 *  - `BUNSANE_ABORT_MODE=off`, where the deployment's cancellation is disabled
 *    even though the driver might support it.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { probeCancelEffectiveness } from '../../../database/connectionProbe';

/**
 * A fake connection whose `pg_sleep` finishes after `naturalMs` unless
 * `honoursCancel` and someone calls `cancel()`.
 */
function fakeConn(opts: { naturalMs: number; honoursCancel: boolean; failWith?: Error }) {
    let cancelled = false;
    const conn = {
        cancelCalls: 0,
        unsafe: (_sql: string) => {
            let settle: () => void = () => {};
            const promise: any = new Promise<any[]>((resolve, reject) => {
                const done = () => (opts.failWith ? reject(opts.failWith) : resolve([]));
                settle = done;
                setTimeout(done, opts.naturalMs);
            });
            promise.catch(() => { /* the probe owns this too; belt and braces */ });
            promise.cancel = () => {
                conn.cancelCalls++;
                if (!opts.honoursCancel || cancelled) return;
                cancelled = true;
                settle();
            };
            return promise;
        },
    };
    return conn;
}

const originalAbortMode = process.env.BUNSANE_ABORT_MODE;

afterEach(() => {
    if (originalAbortMode === undefined) delete process.env.BUNSANE_ABORT_MODE;
    else process.env.BUNSANE_ABORT_MODE = originalAbortMode;
});

describe('cancel effectiveness probe', () => {
    test('reports a cancel that stops the statement', async () => {
        const conn = fakeConn({ naturalMs: 400, honoursCancel: true });
        const r = await probeCancelEffectiveness(conn, null, 200);

        expect(r.effective).toBe(true);
        expect(r.outcome).toBe('stopped');
        expect(r.observedMs).toBeLessThan(200);
    });

    test('reports a cancel the server never hears — the B8a shape', async () => {
        // The statement runs to its natural end holding its slot, while the
        // caller was released long before. This is the real behaviour on Bun
        // 1.4.0-canary.1 and the reason the framework cannot rely on cancel.
        const conn = fakeConn({ naturalMs: 200, honoursCancel: false });
        const r = await probeCancelEffectiveness(conn, null, 200);

        expect(r.effective).toBe(false);
        expect(r.outcome).toBe('ran-to-completion');
        expect(r.observedMs).toBeGreaterThanOrEqual(150);
    });

    test('does NOT credit a server-side statement_timeout as a working cancel', async () => {
        // The trap this probe most easily falls into: with a role-level
        // statement_timeout in force, the probe's own sleep is killed by the
        // SERVER, the statement stops early, and timing alone reads that as
        // cancellation working — certifying the exact property that is broken.
        // Both raise SQLSTATE 57014; only the message tells them apart.
        const conn = fakeConn({
            naturalMs: 40,
            honoursCancel: false,
            failWith: new Error('ERR_POSTGRES_SERVER_ERROR: canceling statement due to statement timeout'),
        });
        const r = await probeCancelEffectiveness(conn, null, 300);

        expect(r.effective).toBeNull();
        expect(r.outcome).toBe('preempted-by-statement-timeout');
    });

    test('refuses to probe under a statement_timeout too tight to fit under', async () => {
        const conn = fakeConn({ naturalMs: 10, honoursCancel: true });
        const r = await probeCancelEffectiveness(conn, 50, 200);

        expect(r.effective).toBeNull();
        expect(r.outcome).toBe('server-timeout-too-tight');
        expect(conn.cancelCalls).toBe(0);
    });

    test('sizes the probe under the server bound when there is room', async () => {
        // 300 ms server bound → the probe must not sleep past ~150 ms, or it
        // measures the server instead of the cancel.
        const conn = fakeConn({ naturalMs: 1_000, honoursCancel: true });
        const r = await probeCancelEffectiveness(conn, 300, 500);

        expect(r.outcome).toBe('stopped');
        expect(r.observedMs).toBeLessThan(150);
    });

    test('BUNSANE_ABORT_MODE=off reports ineffective even on a driver that would obey', async () => {
        // The probe measures THIS DEPLOYMENT's path, not the driver in the
        // abstract: it goes through `runWithSignal`, so a deployment that has
        // switched cancellation off is told its timeouts do not reclaim slots.
        process.env.BUNSANE_ABORT_MODE = 'off';
        const conn = fakeConn({ naturalMs: 200, honoursCancel: true });
        const r = await probeCancelEffectiveness(conn, null, 200);

        expect(r.effective).toBe(false);
        expect(conn.cancelCalls).toBe(0);
    });
});
