/**
 * LockBackend — pluggable mutual-exclusion primitive behind {@link DistributedLock}.
 *
 * Three concrete backends ship with the framework:
 *  - {@link InProcessLockBackend}    — single-instance, in-memory. No infra.
 *  - {@link PostgresLeaseLockBackend} — lease-row table, pooler-safe. Default
 *    distributed backend (each acquire/renew/release is one short transaction,
 *    so it works behind pgbouncer `pool_mode = transaction`).
 *  - {@link AdvisoryLockBackend}     — PostgreSQL session advisory locks. The
 *    historical default; opt-in only because it REQUIRES a session-pinned
 *    connection lane (breaks silently behind a transaction pooler — see
 *    docs/TICKETS_LOCK_POOLING_DATALOADER_2026-06-22.md, BUNSANE-1).
 *
 * The unifying model is a *lease*: a holder owns `key` until it releases it or
 * `expiresAt` passes. Advisory locks have no TTL (they live for the session),
 * so `ttlMs`/`renew` are best-effort: a backend that cannot honour a lease
 * simply ignores `ttlMs` and omits `renew`.
 */

/**
 * Opaque proof of ownership returned by {@link LockBackend.acquire}. Must be
 * passed back to `renew`/`release` so a backend can verify the caller still
 * owns the lease (fencing) before mutating shared state.
 */
export interface LockHandle {
    /** The logical lock key the caller asked for. */
    key: string;
    /**
     * Unique-per-acquisition owner token. Lease backends compare-and-act on
     * this so a holder whose lease already expired and was stolen cannot
     * release/renew the new holder's lease.
     */
    token: string;
    /**
     * Wall-clock ms (Date.now scale) at which the lease lapses, or `null` for
     * session-bound backends (advisory) that have no TTL.
     */
    expiresAt: number | null;
    /**
     * Backend-private scratch space (e.g. the bigint advisory key). Not part of
     * the public contract — never read it outside the backend that set it.
     */
    readonly _internal?: unknown;
}

export interface AcquireOptions {
    /**
     * Desired lease lifetime in ms. Lease backends use this as the TTL;
     * session-bound backends ignore it. Renew before this elapses for work
     * that outlives the lease.
     */
    ttlMs?: number;
}

/**
 * A pluggable lock primitive. Implementations MUST be safe to call
 * concurrently and MUST treat `acquire` as atomic: at most one live handle
 * exists per `key` across every process sharing the backend's store.
 */
export interface LockBackend {
    /** Stable identifier for logs/metrics (e.g. "postgres-lease"). */
    readonly name: string;

    /**
     * Try once to acquire `key`. Resolves to a {@link LockHandle} on success or
     * `null` if another holder owns it. Never blocks/retries — the caller
     * ({@link DistributedLock}) owns the wait loop.
     */
    acquire(key: string, opts?: AcquireOptions): Promise<LockHandle | null>;

    /**
     * Extend an owned lease by `ttlMs`. Returns `false` if the handle no longer
     * owns the lock (expired and stolen, or already released). Optional:
     * session-bound backends omit it (their lock never lapses while held).
     */
    renew?(handle: LockHandle, ttlMs: number): Promise<boolean>;

    /**
     * Release an owned lock. Returns `true` if this handle released a lock it
     * genuinely held, `false` if the lock was already gone / owned by someone
     * else (a `false` here is the canonical "stranded/lost lease" signal —
     * callers should surface it loudly, see BUNSANE-2).
     */
    release(handle: LockHandle): Promise<boolean>;

    /**
     * Release any backend-held resources (pooled connection, redis client
     * subscription). Called on shutdown. Idempotent.
     */
    dispose?(): Promise<void>;
}
