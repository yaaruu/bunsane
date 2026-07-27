/**
 * The DB execution seam.
 *
 * WHY THIS EXISTS
 *
 * Framework DB traffic reaches Postgres through ~111 raw `.unsafe(` call sites
 * plus ~47 tagged templates, of which only a handful carry a timeout, a
 * cancellation signal, or a metric. There is consequently nowhere to put a
 * policy: bounding concurrency, propagating a deadline, keeping background work
 * from starving user traffic, or even counting queries accurately all require
 * touching every call site. That is the structural reason a slow database turned
 * into a wedged application — the framework had no place to say "no".
 *
 * This module is that place. Every framework query is meant to route through
 * `dbExec` / `dbTransaction`, and the policies below live here only.
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
    logger.info({ enabled: admissionEnabled() }, 'DB admission armed');
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
    if (!armed || !admissionEnabled() || lane === 'health' || callerOwnsConnection || admittedScope.getStore()) {
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

function resolveDeadline(opts: DbExecOptions): number {
    if (opts.deadline !== undefined) return opts.deadline;
    const budget = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
    return Date.now() + budget;
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
    const deadline = resolveDeadline(opts);
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
            if (deadlineExpired) {
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
    const deadline = resolveDeadline(opts);
    // Same exemption as `dbExec`: opening a SAVEPOINT on a handle the caller
    // already holds consumes no new pooled connection, so it must not queue for
    // a permit behind work that does.
    const admission = await admit(lane, deadline, opts.signal, opts.label, opts.callerOwnsConn === true);
    try {
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
        return await (target as any).transaction((trx: any) => admittedScope.run({ lane }, () => fn(trx)));
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
