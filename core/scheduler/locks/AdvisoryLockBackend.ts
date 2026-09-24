/**
 * AdvisoryLockBackend — PostgreSQL session advisory locks (`pg_advisory_lock`).
 *
 * The framework's historical lock primitive, preserved as an OPT-IN backend.
 *
 * ⚠️  Advisory locks are bound to the PostgreSQL *session* that took them. This
 * backend pins one connection via `sql.reserve()` and routes every lock/unlock
 * through it, so a process's locks all live in one session and unlock always
 * hits the acquiring session. If the process crashes, PostgreSQL drops the
 * session and releases every lock automatically.
 *
 * This is ONLY safe when the client→server path preserves session affinity,
 * i.e. a direct PostgreSQL connection or pgbouncer in `session`/`statement`
 * mode. Behind pgbouncer `pool_mode = transaction` the reserved connection
 * pins client→pgbouncer but NOT pgbouncer→backend, so lock and unlock land on
 * different backends and the lock strands silently (BUNSANE-1). Prefer
 * {@link PostgresLeaseLockBackend} unless you control a session-pinned lane.
 *
 * @see https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
 */

import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { ReservedSQL, SQL } from "bun";
import db from "../../../database";
import { logger } from "../../Logger";
import type { AcquireOptions, LockBackend, LockHandle } from "./LockBackend";

const loggerInstance = logger.child({ scope: "AdvisoryLockBackend" });

/**
 * Thrown on first use when the advisory backend detects it is NOT on a
 * session-pinned connection (i.e. behind a transaction-pooling pooler), where
 * advisory locks strand silently (BUNSANE-1/-7). This is a configuration error,
 * not a transient lock failure — {@link DistributedLock} re-throws it so the
 * misconfiguration fails loudly instead of silently skipping critical sections.
 * Acknowledge and bypass with `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`.
 */
export class UnsafeAdvisoryPoolingError extends Error {
    constructor() {
        super(
            "Advisory lock backend is running on a connection without session affinity " +
                "(transaction-pooling pooler detected). Session advisory locks strand silently here. " +
                "Use the default 'postgres' lease backend, point this app at a session-pinned lane, " +
                "or set BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true to override at your own risk."
        );
        this.name = "UnsafeAdvisoryPoolingError";
    }
}

export interface AdvisoryBackendConfig {
    /** Namespace prefix occupying the high 32 bits of the advisory key. */
    lockKeyPrefix: number;
    enableLogging: boolean;
}

const DEFAULT_PREFIX = 0x42554e53; // "BUNS"

interface AdvisoryInternal {
    bigintKey: bigint;
}

interface HeldAdvisory {
    token: string;
    bigintKey: bigint;
}

function tokensEqual(stored: string, presented: string): boolean {
    const a = Buffer.from(stored, "utf8");
    const b = Buffer.from(presented, "utf8");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
}

export class AdvisoryLockBackend implements LockBackend {
    readonly name = "advisory";
    private config: AdvisoryBackendConfig;
    private readonly sql: SQL;

    private reservedConn: ReservedSQL | null = null;
    private reservePromise: Promise<ReservedSQL> | null = null;
    /** Outstanding handles; the reserved session is freed when this hits 0. */
    private outstanding = 0;
    /** Per-key ownership token. taskId/key is only the advisory lock key. */
    private readonly held = new Map<string, HeldAdvisory>();
    /** Keys with an acquire in flight, so a second caller cannot bump the PG refcount. */
    private readonly inflight = new Set<string>();
    /** Session-affinity probe runs once per reserved session. */
    private safetyChecked = false;

    constructor(config: Partial<AdvisoryBackendConfig> = {}, sql: SQL = db) {
        this.config = {
            lockKeyPrefix: config.lockKeyPrefix ?? DEFAULT_PREFIX,
            enableLogging: config.enableLogging ?? false,
        };
        this.sql = sql;
    }

    /**
     * 32-bit string hash folded into the low half of the advisory key under a
     * fixed 32-bit prefix. NOTE (BUNSANE-4): effective key space is ~2^32, so
     * distinct keys can hash-collide onto the same advisory id → false
     * contention. Acceptable for the opt-in advisory path; lease backends key
     * on the raw text and have no such collision.
     */
    private generateLockKey(key: string): bigint {
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            const char = key.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        hash = Math.abs(hash);
        const prefix = BigInt(this.config.lockKeyPrefix);
        const hashBigInt = BigInt(hash >>> 0);
        return (prefix << 32n) | hashBigInt;
    }

    private async ensureReserved(): Promise<ReservedSQL> {
        if (this.reservedConn) return this.reservedConn;
        if (!this.reservePromise) {
            // On reject (pool exhausted / shutdown mid-reserve), null the
            // promise so the next caller retries a fresh reserve rather than
            // re-awaiting the same rejected one forever (H-DB-2).
            this.reservePromise = this.sql.reserve().then(
                (conn) => {
                    this.reservedConn = conn;
                    this.reservePromise = null;
                    return conn;
                },
                (err) => {
                    this.reservePromise = null;
                    throw err;
                }
            );
        }
        return this.reservePromise;
    }

    private releaseReservationIfIdle(): void {
        if (this.outstanding > 0 || !this.reservedConn) return;
        try {
            this.reservedConn.release();
        } catch (error) {
            loggerInstance.warn(
                `Failed to release reserved connection: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        this.reservedConn = null;
    }

    /**
     * Verify the reserved connection has session affinity. Sets a session GUC
     * then reads it back on a SEPARATE query: under a transaction pooler the two
     * queries land on different backends so the value is lost, exposing the
     * silently-unsafe config (BUNSANE-1/-7). Runs once per session. A probe that
     * errors out (e.g. an engine that disallows the GUC) is treated as
     * inconclusive → assume safe rather than block. Throws
     * {@link UnsafeAdvisoryPoolingError} on an affirmative "not pinned" unless
     * acknowledged via `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`.
     */
    private async checkSessionAffinity(conn: ReservedSQL): Promise<void> {
        if (this.safetyChecked) return;

        if (process.env.BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK === "true") {
            this.safetyChecked = true;
            return;
        }

        const token = randomUUID();
        let readBack: string | null = null;
        try {
            await conn`SELECT set_config('bunsane.lock_affinity_probe', ${token}, false)`;
            const rows = await conn`
                SELECT current_setting('bunsane.lock_affinity_probe', true) AS v
            `;
            readBack = rows[0]?.v ?? null;
        } catch (error) {
            // Inconclusive (engine rejected the GUC, etc.) — don't block.
            loggerInstance.debug(
                `Session-affinity probe inconclusive, assuming safe: ${error instanceof Error ? error.message : String(error)}`
            );
            this.safetyChecked = true;
            return;
        }

        if (readBack !== token) {
            loggerInstance.error(
                "Advisory lock backend has NO session affinity — a transaction-pooling pooler is " +
                    "multiplexing queries across backends. Session advisory locks WILL strand silently " +
                    "(see BUNSANE-1). Switch to the 'postgres' lease backend or a session-pinned lane."
            );
            throw new UnsafeAdvisoryPoolingError();
        }
        this.safetyChecked = true;
    }

    async acquire(key: string, _opts?: AcquireOptions): Promise<LockHandle | null> {
        if (this.held.has(key) || this.inflight.has(key)) {
            return null;
        }
        this.inflight.add(key);
        try {
            const bigintKey = this.generateLockKey(key);

            // Reserve the session (transient failures → null, retried next call).
            let conn: ReservedSQL;
            try {
                conn = await this.ensureReserved();
            } catch (error) {
                loggerInstance.error(
                    `Error reserving connection for advisory lock ${key}: ${error instanceof Error ? error.message : String(error)}`
                );
                return null;
            }

            // Fail LOUD on an unsafe pooling config (throws past the catch below).
            await this.checkSessionAffinity(conn);

            try {
                const result = await conn`
                    SELECT pg_try_advisory_lock(${bigintKey}::bigint) as locked
                `;
                const acquired = result[0]?.locked ?? false;
                if (!acquired) {
                    this.releaseReservationIfIdle();
                    return null;
                }
                const token = randomBytes(16).toString("hex");
                this.held.set(key, { token, bigintKey });
                this.outstanding++;
                if (this.config.enableLogging) {
                    loggerInstance.debug(`Acquired advisory lock ${key} (${bigintKey})`);
                }
                const internal: AdvisoryInternal = { bigintKey };
                return { key, token, expiresAt: null, _internal: internal };
            } catch (error) {
                loggerInstance.error(
                    `Error acquiring advisory lock ${key}: ${error instanceof Error ? error.message : String(error)}`
                );
                this.releaseReservationIfIdle();
                return null;
            }
        } finally {
            this.inflight.delete(key);
        }
    }

    async release(handle: LockHandle): Promise<boolean> {
        const owned = this.held.get(handle.key);
        if (!owned || !tokensEqual(owned.token, handle.token)) {
            return false;
        }
        // Forget ownership before touching PG: if the unlock throws or the
        // session is gone, the PG lock goes with the session anyway, and a
        // lingering entry would make every later acquire(key) return null.
        this.held.delete(handle.key);
        const { bigintKey } = owned;
        if (!this.reservedConn) {
            loggerInstance.warn(
                `No reserved connection to release advisory lock ${handle.key}`
            );
            return false;
        }
        try {
            const result = await this.reservedConn`
                SELECT pg_advisory_unlock(${bigintKey}::bigint) as unlocked
            `;
            const released = result[0]?.unlocked ?? false;
            this.outstanding = Math.max(0, this.outstanding - 1);
            // A false unlock is the canonical stranded-lock signal (BUNSANE-1/2);
            // the DistributedLock facade promotes it to a loud ERROR + counter,
            // so keep the backend log at debug to avoid double-logging.
            if (this.config.enableLogging) {
                loggerInstance.debug(
                    released
                        ? `Released advisory lock ${handle.key} (${bigintKey})`
                        : `pg_advisory_unlock returned false for ${handle.key} (${bigintKey}) — may be stranded on another backend`
                );
            }
            this.releaseReservationIfIdle();
            return released;
        } catch (error) {
            loggerInstance.error(
                `Error releasing advisory lock ${handle.key}: ${error instanceof Error ? error.message : String(error)}`
            );
            this.outstanding = Math.max(0, this.outstanding - 1);
            this.releaseReservationIfIdle();
            return false;
        }
    }

    async renew(handle: LockHandle, _ttlMs: number): Promise<boolean> {
        const owned = this.held.get(handle.key);
        return !!owned && tokensEqual(owned.token, handle.token);
    }

    async dispose(): Promise<void> {
        this.outstanding = 0;
        this.held.clear();
        this.inflight.clear();
        this.safetyChecked = false; // new session must re-probe affinity
        if (this.reservedConn) {
            try {
                this.reservedConn.release();
            } catch {
                /* best-effort on shutdown */
            }
            this.reservedConn = null;
        }
    }

    updateConfig(config: Partial<AdvisoryBackendConfig>): void {
        this.config = { ...this.config, ...config };
    }
}
