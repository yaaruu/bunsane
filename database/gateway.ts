/**
 * The DB execution seam.
 *
 * WHY THIS EXISTS
 *
 * Framework DB traffic used to reach Postgres through ~111 raw `.unsafe(` call
 * sites plus ~47 tagged templates, of which only a handful carried a timeout, a
 * cancellation signal, or a metric. There was consequently nowhere to put a
 * policy: bounding concurrency, propagating a deadline, keeping background work
 * from starving user traffic, or even counting queries accurately all required
 * touching every call site. That is the structural reason a slow database turned
 * into a wedged application — the framework had no place to say "no".
 *
 * This module is that place. Framework queries route through `dbExec`,
 * `dbRun` (for tagged templates) or `dbTransaction`, and the policies below live
 * here only. `tests/unit/db-seam.test.ts` enforces that and carries the
 * documented list of what is deliberately exempt.
 *
 * ADMISSION IS PER TRANSACTION, NOT PER STATEMENT
 *
 * `db.transaction()` holds a pooled connection for its whole duration. If
 * admission were taken per statement, a transaction that already owns its
 * connection would block waiting for a permit to issue its *next* statement
 * while other admitted callers hold the remaining permits — a nested-acquire
 * deadlock that presents exactly like the outage this work came from: a wedged
 * app with an idle database. So `dbTransaction` takes one permit and holds it,
 * and statements executed inside that scope are exempt (tracked via
 * AsyncLocalStorage, so exemption follows the async call tree rather than
 * needing to be threaded through every helper).
 *
 * THE QUEUE IS OURS, DELIBERATELY
 *
 * `DB_CONNECTION_TIMEOUT` was assumed to bound waiting for a busy pool. Measured
 * (`tests/load/pool-saturation.ts`): with `max: 1` and a 1 s timeout, a second
 * caller queued 2.9 s and then succeeded — Bun documents it as the connection
 * *establishment* timeout. Rather than depend on unverified driver semantics, the
 * wait for capacity happens here, against a deadline we control, and it is
 * observable (`queueDepth`, `admissionWaitMs`).
 *
 * LANES
 *
 *   request     — user-facing work. May use the whole admission limit.
 *   background  — scheduler, outbox, projection backfill/reconcile, DDL. Capped
 *                 well below the limit so it can never starve `request`.
 *   health      — liveness/readiness probes. NOT admitted: it draws on reserved
 *                 headroom above the admission limit, because a probe that
 *                 queues behind saturated work reports "wedged" when the truth
 *                 is "busy", and the orchestrator restarts a healthy container.
 */
import type { SQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';
import db, { QUERY_TIMEOUT_MS } from './index';
import { timedQuery, getDbStats, type PerRequestCounters } from './instrumentedDb';
import { linkAbortSignals } from './cancellable';
import { logger as MainLogger } from '../core/Logger';

const logger = MainLogger.child({ scope: 'db.gateway' });

export type Lane = 'request' | 'background' | 'health';

/**
 * Thrown when the statement outlived its remaining budget.
 *
 * Needed because the driver wins the race: aborting makes Bun reject the query
 * with its own cancellation error, so without this translation the caller sees
 * "Query cancelled" and the *reason* — which deadline, how long, which lane — is
 * lost exactly when it is being logged. The driver error is preserved as `cause`.
 */
export class DbStatementTimeoutError extends Error {
    readonly code = 'ERR_BUNSANE_DB_STATEMENT_TIMEOUT';
    constructor(readonly lane: Lane, readonly budgetMs: number, readonly label?: string, cause?: unknown) {
        super(
            `DB statement timeout after ${Math.round(budgetMs)}ms ` +
            `(lane=${lane}${label ? `, label=${label}` : ''})`,
        );
        this.name = 'DbStatementTimeoutError';
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

/** Thrown when capacity did not become available before the deadline. */
export class DbAdmissionTimeoutError extends Error {
    readonly code = 'ERR_BUNSANE_DB_ADMISSION_TIMEOUT';
    readonly retryable = true;
    constructor(readonly lane: Lane, readonly waitedMs: number, readonly label?: string) {
        super(
            `Timed out after ${Math.round(waitedMs)}ms waiting for DB capacity ` +
            `(lane=${lane}${label ? `, label=${label}` : ''}). The database pool is saturated.`,
        );
        this.name = 'DbAdmissionTimeoutError';
    }
}

export interface DbExecOptions {
    /** Which lane's capacity to draw on. Defaults to `request`. */
    lane?: Lane;
    /** Short stable name for metrics and slow logs, e.g. `query.exec`. */
    label?: string;
    /** Absolute deadline (epoch ms). Wins over `timeoutMs` when both are given. */
    deadline?: number;
    /** Relative budget in ms, covering BOTH the wait for capacity and the query. */
    timeoutMs?: number;
    /** Caller signal (e.g. `req.signal`) linked into the operation's own. */
    signal?: AbortSignal;
    /** Per-request counters, as accepted by `timedUnsafe`. */
    perRequest?: PerRequestCounters;
    /** Execute on this connection/transaction handle instead of the pool. */
    conn?: SQL | any;
    /**
     * The caller already holds the connection in `conn` (a transaction, a
     * reserved connection), so this statement consumes no new pooled slot and
     * must NOT wait for an admission permit.
     *
     * Explicit rather than inferred from `conn`. Ownership is not a property of
     * the object: `conn` is also how a caller substitutes a different pool (the
     * gateway's own tests inject a stub that way), and treating every foreign
     * handle as owned would silently disable admission wherever `conn` is used
     * for injection.
     *
     * Set it wherever a transaction handle arrives from OUTSIDE the framework —
     * `Query.withTrx(trx)`, `saveEntity(entity, trx)` — because there is no
     * admitted ALS scope to inherit in those cases, and admitting while holding
     * a connection is the nested-acquire deadlock this seam exists to prevent.
     * Derive it from the handle at that boundary (`callerOwnsConn: !!this.trx`)
     * rather than hardcoding it, so it cannot drift from reality.
     */
    callerOwnsConn?: boolean;
    /**
     * Enforce the deadline SERVER-side with `SET LOCAL statement_timeout`.
     *
     * `dbTransaction` does this by default; `dbExec`/`dbRun` do not, and the
     * asymmetry is measured, not stylistic (real PG 17):
     *
     *   inside a transaction that already exists   +0.40 ms  (one round trip;
     *                                              13% of a 3.0 ms entity save,
     *                                              200 interleaved samples)
     *   wrapping a bare statement in one to        +0.95 ms  (3.7× a 0.35 ms
     *   carry it                                   `SELECT 1`, median of 300)
     *
     * One extra round trip is the real unit, and it is worth paying once per
     * write. It is NOT worth paying per statement on a read path that issues
     * thousands of them per request — there it is a regression wearing a
     * safeguard's clothes, which is why this is opt-in.
     *
     * Worth opting in for known-heavy work where ~1 ms is invisible next to a
     * multi-second query: studio endpoints, backfill, reconcile. NOT for DDL —
     * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
     *
     * The transaction is REQUIRED, not incidental: `SET LOCAL` outside one is a
     * no-op that Postgres merely warns about. A refactor that drops the wrapper
     * from the opt-in path below removes the bound silently — nothing fails,
     * the statement is just unguarded again.
     */
    serverTimeout?: boolean;
}

interface LaneStats {
    admitted: number;
    rejected: number;
    queueDepth: number;
    maxQueueDepth: number;
    waitMsTotal: number;
    maxWaitMs: number;
}

const laneStats: Record<Lane, LaneStats> = {
    request: newLaneStats(),
    background: newLaneStats(),
    health: newLaneStats(),
};

function newLaneStats(): LaneStats {
    return { admitted: 0, rejected: 0, queueDepth: 0, maxQueueDepth: 0, waitMsTotal: 0, maxWaitMs: 0 };
}

/**
 * FIFO admission queue with per-waiter deadlines.
 *
 * FIFO on purpose: LIFO or unordered wake-ups starve the oldest caller, which is
 * the one whose client is closest to giving up. Cancelled/expired waiters are
 * dropped on release rather than being woken and immediately failing.
 */
class AdmissionQueue {
    private permits: number;
    private readonly waiters: Array<{ resolve: () => void; expired: () => boolean }> = [];

    constructor(private readonly limit: number) {
        this.permits = limit;
    }

    get depth(): number { return this.waiters.length; }
    get available(): number { return this.permits; }
    get capacity(): number { return this.limit; }

    tryAcquire(): boolean {
        if (this.permits > 0) { this.permits--; return true; }
        return false;
    }

    /** Wait for a permit. Resolves true on acquire, false if the deadline passed. */
    async acquire(deadline: number, signal?: AbortSignal): Promise<boolean> {
        if (this.tryAcquire()) return true;

        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (ok: boolean) => {
                if (settled) return false;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(ok);
                return true;
            };

            const entry = {
                resolve: () => { if (!finish(true)) this.release(); },
                expired: () => settled,
            };

            const remove = () => {
                const i = this.waiters.indexOf(entry);
                if (i >= 0) this.waiters.splice(i, 1);
            };

            // Deliberately NOT unref'd, unlike the statement timer in `dbExec`.
            // A queued caller has no other pending work — no socket, no query —
            // so this timer is the only thing that can make progress. Measured:
            // with `.unref()` Bun never fires it and the caller hangs forever
            // instead of timing out, which is the failure mode this whole seam
            // exists to prevent. A waiter representing in-flight work SHOULD hold
            // the process open, and the deadline bounds how long that lasts.
            const timer = setTimeout(() => { remove(); finish(false); }, Math.max(0, deadline - Date.now()));

            const onAbort = () => { remove(); finish(false); };
            signal?.addEventListener('abort', onAbort, { once: true });

            this.waiters.push(entry);
        });
    }

    release(): void {
        // Hand the permit straight to the next live waiter; only return it to the
        // pool when nobody is waiting, so a permit is never lost to a waiter that
        // has already timed out.
        while (this.waiters.length > 0) {
            const next = this.waiters.shift()!;
            if (next.expired()) continue;
            next.resolve();
            return;
        }
        this.permits++;
    }
}

/** Marks the async scope of an admitted transaction; statements inside it are exempt. */
const admittedScope = new AsyncLocalStorage<{ lane: Lane }>();

let queues: { total: AdmissionQueue; background: AdmissionQueue } | null = null;
let configuredFor = -1;
let armed = false;
let warnedAboutLiveRebuild = false;

/**
 * UNARMED TRAFFIC — admission's silent failure mode.
 *
 * `admit()` is a passthrough until `armGateway()` runs, and the only caller is
 * `core/App.ts` after migrations. Anything that uses the framework's database
 * WITHOUT booting an App — a standalone script, a one-off job, a studio endpoint
 * reached outside the app lifecycle — therefore gets no admission at all, with
 * nothing in the logs to say so. A mitigation that is absent and silent is worse
 * than one that is absent and loud: the metrics look calm precisely because
 * nothing is being measured.
 *
 * Counted always, warned about only once the process has plainly stopped booting.
 * The grace window is not measured from module load: migrations on a cold
 * database can legitimately exceed a minute, and a warning that fires during a
 * normal slow boot is one people learn to ignore. `armGateway()` therefore
 * silences it permanently, so the warning can only ever describe a process that
 * genuinely never armed.
 */
const UNARMED_WARN_AFTER_MS = 60_000;
const gatewayLoadedAt = Date.now();
let unarmedCalls = 0;
let warnedUnarmed = false;

function admissionEnabled(): boolean {
    return process.env.BUNSANE_DB_ADMISSION !== 'off';
}

/**
 * Engage admission. Until this is called, `dbExec`/`dbTransaction` are a
 * passthrough.
 *
 * Boot DDL is the reason. `PrepareDatabase()` / `EnsureDatabaseMigrations()` run
 * dozens of statements before the pool size is meaningfully known, and admitting
 * them would serialize the migration phase behind a limit derived from a
 * possibly-zero `poolMax` — slowing the one phase that has no concurrency to gain
 * from being bounded. Arming after migrations keeps boot unbounded and steady
 * state bounded, without needing a special lane whose name would lie about what
 * it is for.
 */
export function armGateway(): void {
    if (armed) return;
    armed = true;
    // Suppresses the unarmed warning for good — see UNARMED_WARN_AFTER_MS. Boot
    // traffic that ran before this point was exempt by design, not by accident.
    warnedUnarmed = true;
    logger.info({ enabled: admissionEnabled(), unarmedCallsDuringBoot: unarmedCalls }, 'DB admission armed');
}

export function isGatewayArmed(): boolean {
    return armed;
}

/**
 * Admission capacity, derived from the pool so the two cannot drift apart.
 *
 * The limit sits BELOW `poolMax` by `DB_ADMISSION_HEADROOM` (default 1). The
 * headroom is what the health lane and any un-migrated call site draw on: if
 * admitted work could occupy every pooled connection, the liveness probe would
 * queue behind it and fail, restarting a container that was merely busy.
 */
function getQueues() {
    const poolMax = getDbStats().poolMax || parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10);
    if (queues && configuredFor === poolMax) return queues;

    // Never swap the queues out from under live permits. `setPoolMax` runs on
    // every `resetDatabase()` (benchmarks do that), and rebuilding mid-flight
    // would leave holders releasing into orphaned queues while new callers
    // acquire against fresh full-capacity ones — briefly exceeding the limit and
    // stranding the old waiters' timers.
    //
    // A resized pool DOES take effect, just not mid-flight: the rebuild happens
    // on the first call after the queues go idle (or immediately via
    // `resetGateway()`). "Deferred until idle", not "ignored".
    if (queues && (queues.total.available < queues.total.capacity
        || queues.background.available < queues.background.capacity)) {
        if (!warnedAboutLiveRebuild) {
            warnedAboutLiveRebuild = true;
            logger.warn(
                { configuredFor, poolMax },
                'Pool size changed while DB admission permits were outstanding — keeping the ' +
                'existing limits. Call resetGateway() when the pool is idle to reconfigure.',
            );
        }
        return queues;
    }

    const headroom = Math.max(1, parseInt(process.env.DB_ADMISSION_HEADROOM ?? '1', 10) || 1);
    const total = Math.max(1, poolMax - headroom);
    // Background gets at most half the admission limit: enough for backfill and
    // reconcile to make progress, never enough to lock user traffic out.
    const background = Math.max(1, Math.floor(total / 2));

    queues = { total: new AdmissionQueue(total), background: new AdmissionQueue(background) };
    configuredFor = poolMax;
    logger.info(
        { poolMax, admissionLimit: total, backgroundLimit: background, headroom },
        'DB admission configured',
    );
    return queues;
}

/** Rebuild the queues — tests and `resetDatabase()` change the pool underneath us. */
export function resetGateway(): void {
    queues = null;
    configuredFor = -1;
    armed = false;
    warnedAboutLiveRebuild = false;
    // Budgets are parsed once and cached on the hot path, so a test (or a runtime
    // reconfigure) that changes DB_REQUEST_TIMEOUT sees it only after this.
    laneBudgets = {};
    unarmedCalls = 0;
    warnedUnarmed = false;
    for (const lane of Object.keys(laneStats) as Lane[]) laneStats[lane] = newLaneStats();
}

function recordWait(lane: Lane, waitMs: number): void {
    const s = laneStats[lane];
    s.admitted++;
    s.waitMsTotal += waitMs;
    if (waitMs > s.maxWaitMs) s.maxWaitMs = waitMs;
}

function enterQueue(lane: Lane): void {
    const s = laneStats[lane];
    s.queueDepth++;
    if (s.queueDepth > s.maxQueueDepth) s.maxQueueDepth = s.queueDepth;
}

function leaveQueue(lane: Lane): void {
    laneStats[lane].queueDepth--;
}

interface Admission {
    release: () => void;
}

/**
 * Acquire capacity for `lane` before the deadline. `health` and already-admitted
 * scopes return immediately.
 */
async function admit(
    lane: Lane,
    deadline: number,
    signal?: AbortSignal,
    label?: string,
    callerOwnsConnection = false,
): Promise<Admission> {
    const noop: Admission = { release: () => {} };
    // `callerOwnsConnection` is the second exemption alongside the ALS scope, and
    // it covers what ALS cannot: a connection handed in from OUTSIDE the
    // framework. `Query.withTrx(trx)` lets consumer code pass a transaction it
    // opened with a raw `db.transaction()`, so there is no admitted scope to
    // inherit — yet the connection is unquestionably already held. Admitting
    // there would block waiting for a permit while holding the very resource
    // permits are rationing: the nested-acquire deadlock, arriving through the
    // public API rather than through our own call tree.
    //
    // The rule is simply: whoever owns the connection already paid for it.
    // Split out from the exemptions below rather than folded into one condition:
    // the others are deliberate policy, this one is usually a deployment that
    // never armed and does not know it.
    if (!armed) {
        unarmedCalls++;
        if (!warnedUnarmed && Date.now() - gatewayLoadedAt > UNARMED_WARN_AFTER_MS) {
            warnedUnarmed = true;
            logger.warn(
                { unarmedCalls, lane, label },
                'DB admission is NOT armed and this process is past boot — every query is running ' +
                'unbounded. armGateway() is called by App.start(); a standalone script or job that ' +
                'uses the framework database directly must call it itself.',
            );
        }
        return noop;
    }
    if (!admissionEnabled() || lane === 'health' || callerOwnsConnection || admittedScope.getStore()) {
        return noop;
    }

    const { total, background } = getQueues();
    const t0 = performance.now();
    enterQueue(lane);
    try {
        // Background takes its sub-permit first: holding a scarce global permit
        // while waiting for the plentiful lane permit would let background work
        // occupy global capacity it is not yet allowed to use.
        let laneAcquired = false;
        if (lane === 'background') {
            laneAcquired = await background.acquire(deadline, signal);
            if (!laneAcquired) {
                laneStats[lane].rejected++;
                throw new DbAdmissionTimeoutError(lane, performance.now() - t0, label);
            }
        }

        const acquired = await total.acquire(deadline, signal);
        if (!acquired) {
            if (laneAcquired) background.release();
            laneStats[lane].rejected++;
            throw new DbAdmissionTimeoutError(lane, performance.now() - t0, label);
        }

        recordWait(lane, performance.now() - t0);
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                total.release();
                if (laneAcquired) background.release();
            },
        };
    } finally {
        leaveQueue(lane);
    }
}

/**
 * PER-LANE DEADLINES — the only knob that makes the seam SHED rather than queue.
 *
 * `timeoutMs` covers the wait for a permit AND the query. That single budget is
 * therefore what decides whether an overloaded seam refuses work or merely makes
 * the queue orderly, and the difference is not subtle. Measured on real PG 17,
 * 20 concurrent 2 s statements against `admissionLimit = 3`:
 *
 *   budget 800 ms   17 of 20 REJECTED before touching the server; drain 2063 ms
 *   budget 30 000 ms  0 of 20 rejected, all 20 executed;          drain 14056 ms
 *                     callers queued 4.3 s on average, 12.0 s at worst
 *
 * The 30 s row is what shipped: no framework call site passes `timeoutMs`, so
 * every lane inherited `DB_QUERY_TIMEOUT` (default 30 000). Admission bounded the
 * queue and made it observable — the thing `DB_CONNECTION_TIMEOUT` provably does
 * not do — but shed nothing, and capped concurrency below `poolMax` while doing
 * it, so drain was WORSE than with admission off (10034 ms).
 *
 * One global value cannot serve both lanes: a request wants to fail in seconds,
 * while backfill and reconcile legitimately run far longer on the same pool.
 * Hence a default per lane.
 *
 * `health` deliberately has no override. `admit()` exempts the health lane
 * outright, so a health budget would bound only the query and never the queue —
 * a knob that looks like it controls admission and does not. It falls through to
 * the global.
 *
 * NOT changed by default: both overrides are unset out of the box, so behaviour
 * is identical to before. Shortening the request lane changes which requests
 * fail under load, which is a deployment's call, not a patch release's.
 * Request-facing deployments should set `DB_REQUEST_TIMEOUT` to a few seconds.
 *
 * Runtime env wins over the import-time `QUERY_TIMEOUT_MS`, for BOTH the
 * per-lane keys and the global, so the two are never read off different clocks.
 * The parse is cached because this sits on the hottest path in the framework;
 * `resetGateway()` clears it.
 */
const LANE_BUDGET_ENV: Record<Lane, string | null> = {
    request: 'DB_REQUEST_TIMEOUT',
    background: 'DB_BACKGROUND_TIMEOUT',
    health: null,
};

let laneBudgets: Partial<Record<Lane, number>> = {};

function parseBudget(key: string, raw: string | undefined): number | null {
    if (raw === undefined) return null;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v <= 0) {
        logger.warn({ [key]: raw }, `Ignoring ${key}: expected a positive integer in milliseconds`);
        return null;
    }
    return v;
}

function laneBudgetMs(lane: Lane): number {
    const cached = laneBudgets[lane];
    if (cached !== undefined) return cached;

    const key = LANE_BUDGET_ENV[lane];
    const budget =
        (key === null ? null : parseBudget(key, process.env[key]))
        ?? parseBudget('DB_QUERY_TIMEOUT', process.env.DB_QUERY_TIMEOUT)
        ?? QUERY_TIMEOUT_MS;

    laneBudgets[lane] = budget;
    return budget;
}

function resolveDeadline(opts: DbExecOptions, lane: Lane): number {
    if (opts.deadline !== undefined) return opts.deadline;
    const budget = opts.timeoutMs ?? laneBudgetMs(lane);
    return Date.now() + budget;
}

/**
 * SERVER-SIDE DEADLINE ENFORCEMENT
 *
 * A client-side abort does not stop the server. Measured on Bun 1.4.0-canary.1:
 * `query.cancel()` sends no Postgres CancelRequest, so an abandoned statement
 * runs to completion and keeps its pool slot for its real duration — identical
 * on a direct connection and through PgBouncer, because it is a driver
 * property, not a pooling one. That is the outage signature: the app gives up,
 * the database does not, and the slot never comes back.
 *
 * `SET LOCAL statement_timeout` is the bound that works. A 6 s statement was
 * killed at 1215 ms (direct) / 1213 ms (pooled) against a 1200 ms setting, and
 * the slot was reusable 1–2 ms later on both.
 *
 * `SET LOCAL`, never plain `SET`: under transaction pooling the server
 * connection is handed to another client at COMMIT, and a session-level setting
 * would follow it there — one caller's 500 ms budget silently becoming
 * everyone's.
 */
function serverTimeoutEnabled(): boolean {
    // PGlite is skipped for the same reason `DB_STATEMENT_TIMEOUT` is: it is a
    // single-connection in-process engine where the failure this guards against
    // cannot occur, and the whole test suite now crosses this path.
    return process.env.BUNSANE_DB_SERVER_TIMEOUT !== 'off' && process.env.USE_PGLITE !== 'true';
}

/**
 * Apply the remaining budget as a server-side statement timeout on `conn`.
 * Must be called INSIDE a transaction — `SET LOCAL` outside one is a no-op with
 * a warning.
 *
 * `SET` cannot take a bind parameter, so the value is interpolated — safe here
 * because `ms` is a validated integer, never caller text. Passing NO params
 * array keeps this on the simple query protocol, which matters twice over: the
 * statement is never prepared, so varying SQL text cannot collide with Bun's
 * ~40-character prepared-statement naming (the 42P05 shape this codebase has
 * already paid for once), and it measured cheaper than the constant-text
 * `SELECT set_config('statement_timeout', $1, true)` alternative — +0.40 ms vs
 * +0.55 ms on a real entity save.
 */
async function applyStatementTimeout(conn: any, budgetMs: number): Promise<void> {
    // Guard the floor deliberately: `statement_timeout = 0` means NO timeout in
    // Postgres, so rounding an exhausted budget down would silently remove the
    // bound at exactly the moment it matters most.
    const ms = Math.max(1, Math.ceil(budgetMs));
    await conn.unsafe(`SET LOCAL statement_timeout = '${ms}ms'`);
}

/** SQLSTATE 57014 raised by `statement_timeout`, as opposed to a client cancel. */
export function isServerStatementTimeout(err: unknown): boolean {
    const e = err as { code?: unknown; errno?: unknown; message?: unknown } | null | undefined;
    if (e?.code === '57014' || e?.errno === '57014') return true;
    return typeof e?.message === 'string'
        && e.message.includes('canceling statement due to statement timeout');
}

/**
 * Execute one statement under lane admission and a deadline that covers BOTH the
 * wait for capacity and the query itself.
 *
 * A single budget for both halves is the point: two independent 30 s clocks —
 * one to get a connection, one to run — is how a request ends up stalled for a
 * minute before failing. The remaining budget after admission is what the query
 * gets.
 */
export async function dbExec<T = any>(sql: string, params?: any[], opts: DbExecOptions = {}): Promise<T> {
    return await dbRun<T>(
        (conn) => (params === undefined ? (conn as any).unsafe(sql) : (conn as any).unsafe(sql, params)),
        sql,
        opts,
    );
}

/**
 * Run a caller-built query under the same lane, admission and deadline policy.
 *
 * The escape hatch for TAGGED TEMPLATES. `db\`… ${sql(ids)} …\`` cannot be
 * expressed as a flat string plus params without rewriting the SQL by hand, and
 * converting templates to `unsafe()` changes the wire protocol — which broke the
 * suite once already via Bun's prepared-statement naming (see
 * `database/DatabaseHelper.ts`). Passing the factory keeps construction and
 * protocol byte-identical while still getting admission, a deadline, cancellation
 * and metrics.
 *
 * `describe` is a label for the slow log, since there is no SQL string to snip.
 */
export async function dbRun<T = any>(
    makeQuery: (conn: any) => any,
    describe: string,
    opts: DbExecOptions = {},
): Promise<T> {
    const lane = opts.lane ?? 'request';
    const deadline = resolveDeadline(opts, lane);

    // Opt-in server-side enforcement. A lone statement has no transaction to
    // hang `SET LOCAL` on, so one is opened for it — hence the +0.95 ms and
    // hence opt-in. Admission is taken by `dbTransaction`; the inner call runs
    // inside its ALS scope and is exempt, so no permit is taken twice.
    if (opts.serverTimeout === true && opts.conn === undefined && !opts.callerOwnsConn && serverTimeoutEnabled()) {
        return await dbTransaction<T>(
            (trx) => dbRun<T>(makeQuery, describe, { ...opts, conn: trx, deadline, serverTimeout: false }),
            { ...opts, deadline },
        );
    }

    const admission = await admit(lane, deadline, opts.signal, opts.label, opts.callerOwnsConn === true);
    try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new DbAdmissionTimeoutError(lane, 0, opts.label);
        }

        const controller = new AbortController();
        const unlink = linkAbortSignals(opts.signal, controller);
        let deadlineExpired = false;
        // Unref'd, unlike the admission timer above: at high QPS thousands of
        // these are live at once and they must not hold the event loop open. That
        // is safe here because an in-flight query keeps the loop alive through
        // its own socket, so the timer always gets a chance to fire. The
        // admission timer has no such companion work, which is why it stays
        // ref'd — the two choices are deliberate and opposite.
        const timer = setTimeout(
            () => {
                deadlineExpired = true;
                controller.abort(new DbStatementTimeoutError(lane, remaining, opts.label));
            },
            remaining,
        );
        (timer as unknown as { unref?: () => void }).unref?.();

        try {
            return await timedQuery<T>(
                () => makeQuery(opts.conn ?? db),
                describe,
                controller.signal,
                opts.perRequest,
            );
        } catch (err) {
            // The driver wins the race: cancelling makes it reject with its own
            // error ("Query cancelled"), which would replace the reason the
            // caller needs. Re-throw our deadline error, keeping the driver's as
            // `cause`. A caller-initiated abort keeps the caller's reason.
            //
            // A SERVER-side kill arrives the same way and needs the same
            // translation: `canceling statement due to statement timeout` says
            // nothing about which lane, label or budget was exceeded, which is
            // precisely the information `DbStatementTimeoutError` exists to
            // carry. Without this the server bound would be strictly less
            // legible than the client one it replaces.
            if (deadlineExpired || isServerStatementTimeout(err)) {
                throw new DbStatementTimeoutError(lane, remaining, opts.label, err);
            }
            throw err;
        } finally {
            clearTimeout(timer);
            unlink();
        }
    } finally {
        admission.release();
    }
}

/**
 * Run a transaction under a single admission held for its whole duration.
 *
 * Statements issued inside `fn` — whether through `dbExec` or the raw `trx`
 * handle — do not re-enter admission. See the header note on why per-statement
 * admission deadlocks.
 */
export async function dbTransaction<T>(
    fn: (trx: any) => Promise<T>,
    opts: DbExecOptions = {},
): Promise<T> {
    const lane = opts.lane ?? 'request';
    const startedAt = Date.now();
    const deadline = resolveDeadline(opts, lane);
    // Same exemption as `dbExec`: opening a SAVEPOINT on a handle the caller
    // already holds consumes no new pooled connection, so it must not queue for
    // a permit behind work that does.
    const admission = await admit(lane, deadline, opts.signal, opts.label, opts.callerOwnsConn === true);
    try {
        // Emit `SET LOCAL statement_timeout` unless the caller opts out. Costs
        // one round trip (+0.40 ms, 13% of a 3.0 ms entity save) — paid once
        // per transaction, in exchange for the write path having a bound the
        // server actually honours.
        //
        // NOT when `conn` is supplied. `SET LOCAL` is transaction-scoped, not
        // savepoint-scoped: releasing the savepoint this opens does NOT restore
        // the previous value, so a framework transaction nested inside consumer
        // code's own transaction would silently reset THEIR statement_timeout
        // for the rest of it. Same reasoning for `callerOwnsConn`.
        const emitServerTimeout = opts.serverTimeout !== false
            && opts.conn === undefined
            && !opts.callerOwnsConn
            && serverTimeoutEnabled();

        // `opts.conn` is honoured so a caller already holding a transaction handle
        // can open a SAVEPOINT on it instead of acquiring a second pooled
        // connection — which is what `(db as any).transaction(...)` would do,
        // deadlocking against itself once every statement is routed here.
        const target = opts.conn ?? db;

        // The ALS scope MUST be entered inside the transaction callback, not
        // around `.transaction(...)`. Bun invokes the callback from its own
        // async context (`onTransactionConnected` in bun:sql), so a scope
        // established outside does not propagate into it: measured, every
        // statement inside the transaction re-entered admission and deadlocked
        // against the permit the transaction itself was holding — the precise
        // failure this design exists to avoid. Entering the scope here means it
        // propagates through everything `fn` awaits.
        return await (target as any).transaction((trx: any) => admittedScope.run({ lane }, async () => {
            if (emitServerTimeout) {
                const budget = deadline - Date.now();
                // Refuse rather than run unbounded: `statement_timeout = 0`
                // disables the timeout, so an already-spent budget must fail
                // here, not silently open the transaction with no bound.
                if (budget <= 0) throw new DbStatementTimeoutError(lane, 0, opts.label);
                // Plainly awaited. Issuing it unawaited and resolving it
                // alongside `fn` — hoping the driver would pipeline the two —
                // was measured and made no difference (0.397 ms vs 0.400 ms):
                // Bun serializes a connection's queue rather than batching it,
                // so the round trip is real and there is no version of this
                // that costs less. Not worth the ordering risk for 3 µs.
                await applyStatementTimeout(trx, budget);
            }
            return await fn(trx);
        }));
    } catch (err) {
        // Statements issued on the raw `trx` handle never pass through
        // `dbRun`, so this is the only place their server-side kill can be
        // translated — `saveEntity`'s inner writes are exactly that shape.
        if (isServerStatementTimeout(err)) {
            throw new DbStatementTimeoutError(lane, deadline - startedAt, opts.label, err);
        }
        throw err;
    } finally {
        admission.release();
    }
}

/** True when the caller is inside an admitted transaction scope. */
export function inAdmittedScope(): boolean {
    return admittedScope.getStore() !== undefined;
}

export function getGatewayStats() {
    const { total, background } = getQueues();
    return {
        enabled: admissionEnabled(),
        /** False until `armGateway()` runs (boot DDL is deliberately unbounded). */
        armed,
        /**
         * Queries that bypassed admission because nothing had armed the gateway.
         * Nonzero-and-still-`armed: false` long after start means this process
         * never armed and is running its database traffic unbounded.
         */
        unarmedCalls,
        /** Effective per-lane default budget in ms (`DB_REQUEST_TIMEOUT` etc.). */
        laneBudgetMs: {
            request: laneBudgetMs('request'),
            background: laneBudgetMs('background'),
            health: laneBudgetMs('health'),
        },
        admissionLimit: total.capacity,
        admissionAvailable: total.available,
        backgroundLimit: background.capacity,
        backgroundAvailable: background.available,
        /** Callers currently waiting for capacity, per lane. */
        queueDepth: {
            request: laneStats.request.queueDepth,
            background: laneStats.background.queueDepth,
            health: laneStats.health.queueDepth,
        },
        maxQueueDepth: {
            request: laneStats.request.maxQueueDepth,
            background: laneStats.background.maxQueueDepth,
            health: laneStats.health.maxQueueDepth,
        },
        admitted: {
            request: laneStats.request.admitted,
            background: laneStats.background.admitted,
            health: laneStats.health.admitted,
        },
        rejected: {
            request: laneStats.request.rejected,
            background: laneStats.background.rejected,
            health: laneStats.health.rejected,
        },
        avgWaitMs: {
            request: avg(laneStats.request),
            background: avg(laneStats.background),
            health: avg(laneStats.health),
        },
        maxWaitMs: {
            request: Math.round(laneStats.request.maxWaitMs),
            background: Math.round(laneStats.background.maxWaitMs),
            health: Math.round(laneStats.health.maxWaitMs),
        },
    };
}

function avg(s: LaneStats): number {
    return s.admitted > 0 ? Number((s.waitMsTotal / s.admitted).toFixed(2)) : 0;
}

export function isAdmissionTimeout(err: unknown): boolean {
    return (err as { code?: unknown } | null | undefined)?.code === 'ERR_BUNSANE_DB_ADMISSION_TIMEOUT';
}
