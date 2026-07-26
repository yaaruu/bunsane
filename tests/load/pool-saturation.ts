#!/usr/bin/env bun
/**
 * Pool saturation + recovery harness.
 *
 * This is the test the B8 outage needed and nobody had: drive the connection
 * pool past capacity, then assert the framework **fails fast and recovers
 * fully**. A pool that never returns to its configured size is the failure that
 * took a production API down for ~7 h with an idle database.
 *
 * It runs as a standalone script rather than a `bun test` case because it has to
 * construct its own pool with its own `max` and `connectionTimeout`, and the
 * suite shares one module-level pool.
 *
 * Usage:
 *   # Against any reachable Postgres (real PG strongly preferred):
 *   POOL_TEST_URL=postgres://user:pw@host:5432/db bun tests/load/pool-saturation.ts
 *
 *   # Knobs (defaults in brackets):
 *   POOL_SIZE [3]  SLOW_SECONDS [5]  CONN_TIMEOUT_SECONDS [1]
 *
 * WHAT IT PROVES WHERE:
 *   - On a DIRECT connection: pool accounting, fast-fail classification, and
 *     recovery are all meaningful.
 *   - Behind PgBouncer `pool_mode = transaction`: additionally measures B8a —
 *     whether a client-side abort actually returns the slot, or whether the slot
 *     stays pinned until the statement finishes on its own. This is the number
 *     the framework used to *assume*; run it against the real topology.
 *   - On PGlite: only the plumbing (classification, counters). PGlite is
 *     single-connection, so it says nothing about pool behaviour. The script
 *     says so rather than implying a green run means anything.
 */
import { SQL } from 'bun';
import { isPoolAcquisitionError } from '../../database/poolErrors';
import { runWithSignal } from '../../database/cancellable';

const url = process.env.POOL_TEST_URL ?? process.env.DB_CONNECTION_URL;
if (!url) {
    console.error('Set POOL_TEST_URL (or DB_CONNECTION_URL) to a reachable Postgres.');
    process.exit(2);
}

const POOL_SIZE = int(process.env.POOL_SIZE, 3);
const SLOW_SECONDS = int(process.env.SLOW_SECONDS, 5);
const CONN_TIMEOUT_SECONDS = int(process.env.CONN_TIMEOUT_SECONDS, 1);
const isPglite = process.env.USE_PGLITE === 'true';

const failures: string[] = [];
const notes: string[] = [];

function int(raw: string | undefined, fallback: number): number {
    const v = parseInt(raw ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

function check(name: string, ok: boolean, detail: string): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name} — ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
}

function note(text: string): void {
    console.log(`  NOTE  ${text}`);
    notes.push(text);
}

const sql = new SQL({
    url,
    max: POOL_SIZE,
    idleTimeout: 30,
    maxLifetime: 600,
    connectionTimeout: CONN_TIMEOUT_SECONDS,
    ...(process.env.DB_DISABLE_PREPARE === 'true' ? { prepare: false } : {}),
});

/** Occupy every slot with a long statement. Returns the in-flight promises. */
function occupyPool(): Promise<unknown>[] {
    return Array.from({ length: POOL_SIZE }, () =>
        (sql as any).unsafe(`SELECT pg_sleep(${SLOW_SECONDS})`).catch(() => { /* reported by phase */ }),
    );
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; err?: unknown }> {
    const t0 = performance.now();
    try {
        const value = await fn();
        return { ms: performance.now() - t0, value };
    } catch (err) {
        return { ms: performance.now() - t0, err };
    }
}

console.log(`\n=== pool saturation harness ===`);
console.log(`url=${url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@')}`);
console.log(`pool=${POOL_SIZE} slow=${SLOW_SECONDS}s connectionTimeout=${CONN_TIMEOUT_SECONDS}s\n`);
if (isPglite) {
    note('USE_PGLITE=true — single-connection engine; pool results below are plumbing only.');
}

// ---------------------------------------------------------------- phase 1
console.log('phase 1: what happens to a caller when every slot is taken?');
{
    const busy = occupyPool();
    await Bun.sleep(150); // let the slots be taken

    const attempt = await timed(() => (sql as any).unsafe('SELECT 1'));
    const budgetMs = CONN_TIMEOUT_SECONDS * 1000 * 2.5;
    const code = (attempt.err as any)?.code ?? 'none';

    // Three genuinely different outcomes. Bun documents `connectionTimeout` as
    // the time to wait when *establishing* a connection, which is not obviously
    // the same as waiting for a busy pool to free a slot — so this phase
    // MEASURES which it is rather than assuming, and only the third outcome is
    // a failure of the harness's own expectations.
    if (attempt.err === undefined) {
        note(
            `caller QUEUED and then succeeded after ${Math.round(attempt.ms)}ms — ` +
            `connectionTimeout=${CONN_TIMEOUT_SECONDS}s did NOT bound the wait for a free ` +
            `slot on this engine. Unbounded pool queueing is how a slowdown becomes a stall: ` +
            `requests pile up behind the pool instead of failing fast. Verify on the real ` +
            `topology before relying on DB_CONNECTION_TIMEOUT as a fast-fail mechanism.`,
        );
    } else if (isPoolAcquisitionError(attempt.err)) {
        check(
            'acquisition fails within the connection timeout budget',
            attempt.ms < budgetMs,
            `waited ${Math.round(attempt.ms)}ms (budget ${Math.round(budgetMs)}ms), err=${code}`,
        );
        note('failure is classified as pool exhaustion → the framework answers 503, not 500.');
    } else {
        check('exhaustion produced a recognisable outcome', false,
            `unexpected error while the pool was full: code=${code}`);
    }

    await Promise.allSettled(busy);
}

// ---------------------------------------------------------------- phase 2
console.log('\nphase 2: the pool returns to FULL capacity afterwards');
{
    const settled = await timed(() => (sql as any).unsafe('SELECT 1'));
    check('a trivial query succeeds once the slow work is done', settled.err === undefined,
        `${Math.round(settled.ms)}ms, err=${(settled.err as any)?.code ?? 'none'}`);

    // Every slot must be usable again — not just one.
    const all = await timed(() =>
        Promise.all(Array.from({ length: POOL_SIZE }, () => (sql as any).unsafe('SELECT 1'))),
    );
    check(
        `all ${POOL_SIZE} slots are usable again`,
        all.err === undefined,
        `${Math.round(all.ms)}ms, err=${(all.err as any)?.code ?? 'none'}`,
    );
}

// ---------------------------------------------------------------- phase 3
console.log('\nphase 3: MEASURE — does a client-side abort actually return the slot? (B8a)');
{
    const controller = new AbortController();
    const slowQuery = (sql as any).unsafe(`SELECT pg_sleep(${SLOW_SECONDS})`);
    const started = performance.now();
    const abandoned = runWithSignal(slowQuery, controller.signal).catch(() => { /* expected */ });

    // Fill the remaining slots so exactly one slot is in question.
    const others = Array.from({ length: POOL_SIZE - 1 }, () =>
        (sql as any).unsafe(`SELECT pg_sleep(${SLOW_SECONDS})`).catch(() => {}),
    );

    await Bun.sleep(300);
    controller.abort(new Error('client gave up'));
    const abortedAt = performance.now() - started;

    // How long until a slot is actually available? Retry until one is.
    const deadline = Date.now() + (SLOW_SECONDS + 5) * 1000;
    let acquiredAt: number | null = null;
    while (Date.now() < deadline) {
        const probe = await timed(() => (sql as any).unsafe('SELECT 1'));
        if (!probe.err) { acquiredAt = performance.now() - started; break; }
        if (!isPoolAcquisitionError(probe.err)) {
            note(`probe failed for an unrelated reason: ${(probe.err as any)?.code}`);
            break;
        }
    }

    await Promise.allSettled([abandoned, ...others]);

    if (acquiredAt === null) {
        check('a slot became available before the deadline', false, 'never acquired');
    } else {
        const statementMs = SLOW_SECONDS * 1000;
        const recoveredEarly = acquiredAt < statementMs * 0.8;
        console.log(
            `  DATA  aborted at ${Math.round(abortedAt)}ms, slot acquired at ` +
            `${Math.round(acquiredAt)}ms, statement duration ${statementMs}ms`,
        );
        note(recoveredEarly
            ? 'cancel DID free the slot early → session-affine path (direct or pool_mode=session).'
            : 'slot was pinned until the statement finished on its own → cancel does NOT recover ' +
              'capacity here (B8a). Server-side statement_timeout is the only real bound.');
    }
}

// ---------------------------------------------------------------- summary
console.log('\n=== summary ===');
for (const n of notes) console.log(`  note: ${n}`);
if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
}
await sql.close().catch?.(() => {});
process.exit(failures.length ? 1 : 0);
