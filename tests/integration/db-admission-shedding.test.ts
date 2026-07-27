/**
 * Admission SHEDS under real saturation — real Postgres only.
 *
 * The unit tests in `tests/unit/database/gateway.test.ts` prove admission's
 * logic against hand-built stub connections: permit accounting, queue wait, the
 * lane deadline, per-call override. What they cannot show is the property the
 * knob is bought for — that when real connections are genuinely occupied by real
 * statements, excess callers are turned away *before reaching the server* rather
 * than piling into the pool.
 *
 * That distinction had consequences. A downstream verification of 0.6.1 read a
 * green suite as evidence the budgets were untested, because its own harness ran
 * unarmed and every budget in it was inert. The numbers that did prove shedding
 * lived in a docblock as a measurement someone had to trust. This file makes
 * them assertions.
 *
 * The shape being pinned, measured on real PG 17 (`admissionLimit = 3`, 20
 * concurrent 2 s statements): at an 800 ms request budget, 17 of 20 were
 * rejected and drain was 2063 ms; at the shipped 30 s default nothing was
 * rejected, all 20 executed, and drain was 14056 ms — WORSE than admission off,
 * because admission caps concurrency below `poolMax` without shedding. Both rows
 * matter. The second is why a long budget is not a safe default in disguise.
 *
 * PGlite is excluded deliberately: it is a single-connection in-process engine,
 * so there is no pool to saturate and nothing to shed.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { getDbStats } from '../../database/instrumentedDb';
import {
    dbExec,
    resetGateway,
    armGateway,
    isAdmissionTimeout,
    getGatewayStats,
    DbStatementTimeoutError,
} from '../../database/gateway';

const isPGlite = process.env.USE_PGLITE === 'true';

/** Small enough to saturate quickly, big enough that the headroom maths is real. */
const TARGET_LIMIT = 3;
const CONCURRENCY = 20;
const SLEEP_SECONDS = 2;

const poolMax = () => getDbStats().poolMax
    || parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10);

// A pool that cannot hold TARGET_LIMIT + headroom has nothing to demonstrate.
const tooSmall = !isPGlite && poolMax() < TARGET_LIMIT + 1;

const saved = {
    headroom: process.env.DB_ADMISSION_HEADROOM,
    request: process.env.DB_REQUEST_TIMEOUT,
};

/**
 * Drive `admissionLimit` to TARGET_LIMIT through the headroom knob rather than
 * by faking the pool: the limit is derived as `poolMax - headroom` precisely so
 * the two cannot drift, and a test that bypassed that derivation would stop
 * covering it.
 */
function armWithBudget(budgetMs: number): void {
    process.env.DB_ADMISSION_HEADROOM = String(poolMax() - TARGET_LIMIT);
    process.env.DB_REQUEST_TIMEOUT = String(budgetMs);
    resetGateway();
    armGateway();

    // Asserted on every arm, not just the first: `getQueues()` derives the limit
    // from the live pool, so a pool-size change would otherwise turn a saturation
    // test into a no-op that still passes.
    const stats = getGatewayStats();
    expect(stats.admissionLimit).toBe(TARGET_LIMIT);
    expect(stats.armed).toBe(true);
}

/**
 * Three outcomes, and keeping them apart is the point.
 *
 * A lane budget is a TOTAL deadline, not a door policy: `admit()` gets it for
 * the queue wait, and whatever remains bounds execution. So a caller can fail in
 * two distinguishable ways — turned away at the door (`DbAdmissionTimeoutError`,
 * never reached the server) or admitted and then cut off (`DbStatementTimeoutError`).
 * Collapsing them would hide which bound actually fired.
 */
type Outcome = 'completed' | 'shed-at-door' | 'killed-after-admission';

async function saturate(): Promise<{
    completed: number; shedAtDoor: number; killedAfterAdmission: number; drainMs: number;
}> {
    const t0 = performance.now();
    const outcomes = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
            dbExec(`SELECT pg_sleep(${SLEEP_SECONDS})`, [], { lane: 'request', label: 'test.saturate' })
                .then(
                    () => 'completed' as Outcome,
                    (err) => {
                        if (isAdmissionTimeout(err)) return 'shed-at-door' as Outcome;
                        if (err instanceof DbStatementTimeoutError) return 'killed-after-admission' as Outcome;
                        throw err;
                    },
                ),
        ),
    );
    const drainMs = performance.now() - t0;
    const count = (o: Outcome) => outcomes.filter((x) => x === o).length;

    return {
        completed: count('completed'),
        shedAtDoor: count('shed-at-door'),
        killedAfterAdmission: count('killed-after-admission'),
        drainMs,
    };
}

describe.skipIf(isPGlite || tooSmall)('admission sheds under real saturation', () => {
    beforeAll(() => { resetGateway(); });

    afterAll(() => {
        for (const [key, value] of [
            ['DB_ADMISSION_HEADROOM', saved.headroom],
            ['DB_REQUEST_TIMEOUT', saved.request],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetGateway();
    });

    test('a tight request budget turns callers away before they reach the server', async () => {
        armWithBudget(800);

        const { completed, shedAtDoor, killedAfterAdmission, drainMs } = await saturate();

        // The load is 20 × 2 s against 3 permits: ~13 s of work behind an 800 ms
        // budget. Nothing can finish, and the great majority never reaches the
        // server at all — that is the shed.
        expect(shedAtDoor).toBeGreaterThan(CONCURRENCY / 2);
        expect(completed).toBe(0);
        // The few that were admitted before the queue filled are bounded by the
        // permit count, not by luck.
        expect(killedAfterAdmission).toBeLessThanOrEqual(TARGET_LIMIT * 2);
        expect(shedAtDoor + killedAfterAdmission).toBe(CONCURRENCY);
        // Drain tracks the budget, not the queued work — the whole point.
        expect(drainMs).toBeLessThan(SLEEP_SECONDS * 1000 * 3);

        const stats = getGatewayStats();
        expect(stats.admissionAvailable).toBe(stats.admissionLimit);   // every permit returned
    }, 30_000);

    /**
     * The budget is a TOTAL deadline, not a door policy.
     *
     * A downstream 0.6.1 verification concluded the opposite — "a budget never
     * cuts off a slow-but-admitted query", from `pg_sleep(3)` completing in
     * 3006 ms under `DB_REQUEST_TIMEOUT=500`. That measurement went through raw
     * `getDb()` SQL, which is outside the seam entirely, so it observed no
     * bound because it took no bound. Through `dbExec`/`dbTransaction` the
     * remaining budget after admission bounds execution too.
     *
     * The distinction that survives, and it is the load-bearing one: this
     * releases the CALLER. Whether the pool SLOT comes back depends on the
     * server-side bound (B8a — `query.cancel()` sends no CancelRequest on Bun
     * 1.4.0-canary.1), which is what `serverTimeout` / a role
     * `statement_timeout` is for. Bounding the caller and reclaiming the slot
     * are different guarantees; only the first is asserted here.
     */
    test('an admitted statement is cut off by what remains of its budget', async () => {
        armWithBudget(600);

        const t0 = performance.now();
        const err = await dbExec(`SELECT pg_sleep(${SLEEP_SECONDS})`, [], {
            lane: 'request', label: 'test.solo',
        }).catch((e) => e);
        const elapsed = performance.now() - t0;

        // Sole caller: admission is instant, so the whole budget goes to execution.
        expect(err).toBeInstanceOf(DbStatementTimeoutError);
        expect(isAdmissionTimeout(err)).toBe(false);
        expect(err.label).toBe('test.solo');
        expect(elapsed).toBeLessThan(SLEEP_SECONDS * 1000);
    }, 30_000);

    test('a long budget queues instead of shedding — the default is not a free bound', async () => {
        // The second row of the measurement, and the reason DB_REQUEST_TIMEOUT is
        // a policy decision rather than a safety net: at the shipped default
        // nothing sheds, everything queues, and drain is longer than it would be
        // with admission off entirely.
        armWithBudget(30_000);

        const { completed, shedAtDoor, killedAfterAdmission, drainMs } = await saturate();

        expect(shedAtDoor).toBe(0);
        expect(killedAfterAdmission).toBe(0);
        expect(completed).toBe(CONCURRENCY);
        // 20 statements × 2 s through 3 permits ≈ 7 waves. Serialization is the
        // point of the assertion: it must exceed a single statement by a lot.
        expect(drainMs).toBeGreaterThan(SLEEP_SECONDS * 1000 * 3);

        const stats = getGatewayStats();
        expect(stats.admissionAvailable).toBe(stats.admissionLimit);
        expect(stats.maxQueueDepth.request).toBeGreaterThan(0);
    }, 60_000);
});
