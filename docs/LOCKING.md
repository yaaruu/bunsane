# Locking & connection pooling

BunSane provides distributed mutual exclusion through `withLock()` and the
scheduler's single-execution gating. Both run on a pluggable **lock backend**.
This document covers backend selection and the connection-pooling constraints
that determine which backend is safe for your deployment.

> **TL;DR** — the default `postgres` lease backend is pooler-safe; you don't need
> to configure anything. Only read on if you're choosing a non-default backend
> or running behind a transaction pooler.

---

## Backends

| Backend | Cross-process? | Pooler-safe? | Infra | Use when |
|---------|----------------|--------------|-------|----------|
| `postgres` (default) | ✅ | ✅ | PostgreSQL (already required) | Default. Multi-instance, behind PgBouncer or direct. |
| `in-process` | ❌ | n/a | none | Single instance; or tests. No cross-process exclusion. |
| `redis` | ✅ | ✅ | Redis | Offload lock traffic from PG (opt-in). |
| `advisory` | ✅ | ⚠️ **only on a session-pinned lane** | PostgreSQL | Legacy. Direct connection or `session`-mode PgBouncer only. |

Select via `BUNSANE_LOCK_BACKEND`, `scheduler.lockBackend`, or the
`DistributedLock` `backend` config. `auto` (the default) resolves to `postgres`.

### `postgres` — lease table (default)

A row in `bunsane_locks (key, owner, expires_at)` represents a held lock. Every
operation is a **single autocommit statement**:

- **acquire** — `INSERT … ON CONFLICT (key) DO UPDATE … WHERE expires_at < now()`:
  inserts a fresh lease, or steals an expired one; a live foreign lease yields
  zero rows → not acquired.
- **renew** — `UPDATE … WHERE key = $1 AND owner = $2 AND expires_at > now()`.
- **release** — `DELETE … WHERE key = $1 AND owner = $2`.

Because each op is one transaction on one backend, it is correct behind
PgBouncer `pool_mode = transaction` — no session affinity needed. The `owner`
token fences renew/release so a holder whose lease expired and was stolen cannot
clobber the new holder.

The `bunsane_locks` table is created lazily and idempotently on first acquire.

**Leases expire.** A lock is held until released *or* `leaseTtlMs` (default
30 000 ms) passes — this is what makes a crashed holder's lock recoverable.
`withLock` runs a heartbeat that renews the lease every ~`ttl/3` while your
function runs, so long critical sections don't get stolen. The scheduler does
**not** heartbeat, so a single scheduled task should complete within
`leaseTtlMs`.

### `in-process` — single instance

In-memory `Map` of leases. Genuine mutual exclusion *within one process* (and a
faithful test double), but **no cross-process exclusion**. Use only when you run
exactly one instance, or in tests.

### `advisory` — PostgreSQL session advisory locks (legacy)

Uses `pg_advisory_lock` on a connection pinned via `sql.reserve()`. Advisory
locks live on the PostgreSQL **session** that took them, so this is **only safe
when the connection has session affinity** — a direct connection, or a PgBouncer
`session`/`statement`-mode port.

Behind PgBouncer `pool_mode = transaction` it breaks silently: lock and unlock
land on different backends, the lock strands, and the next acquire fails — so
`withLock` returns `{ acquired: false }` and **skips the guarded work with no
error** (this caused a production incident — see BUNSANE-1).

To catch this, the advisory backend runs a **session-affinity probe on first
use**: it sets a session GUC and reads it back on a separate query. If the value
is lost (the signature of transaction pooling), it throws
`UnsafeAdvisoryPoolingError` instead of silently proceeding. Bypass the probe
only with `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`.

### `redis` — lease via `SET NX PX` (opt-in)

Planned opt-in backend for offloading lock traffic from PostgreSQL. Falls back
to `postgres` until shipped.

---

## What breaks under transaction pooling

PgBouncer `pool_mode = transaction` multiplexes each *transaction* onto a
possibly-different backend. Anything relying on **server-session state surviving
across statements** is unsafe:

- **`pg_advisory_lock`** (the `advisory` backend) — strands as described above.
- **`sql.reserve()` for affinity** — pins client→PgBouncer, not
  PgBouncer→backend.
- **Session `SET`/GUCs, `LISTEN`/`NOTIFY`** — don't persist/deliver across
  pooled transactions.

The default `postgres` lease backend avoids all of this because it never depends
on session state.

---

## `withLock` contention semantics

```ts
import { withLock, LockUnavailableError } from "bunsane";

const res = await withLock("rebuild-index", async () => rebuild());
if (!res.acquired) {
  // another holder is running — this call did NOT run the function
}
```

When the lock can't be acquired, `withLock` returns `{ acquired: false }` and
**does not run your function**. This is easy to ignore by accident, so two
opt-ins make contention impossible to miss (BUNSANE-2):

| Option | Effect |
|--------|--------|
| `wait` | Poll up to N ms for the lock before giving up (default `0` = try once). |
| `throwOnContention: true` | Throw `LockUnavailableError` instead of returning `{ acquired: false }`. |
| `onContended: (key) => …` | Called when contended — record/forward the dropped work explicitly. |
| `leaseTtlMs` | Lease lifetime + heartbeat cadence for this call. |

```ts
// Fail loud instead of silently skipping:
await withLock("k", fn, { throwOnContention: true });
```

> A future major version will make `throwOnContention` the default. Handle
> `{ acquired: false }` (or opt into throwing) today.

A failed lease release/renew (the signature of a lost or stranded lock) is
logged at **ERROR** and counted — see `DistributedLock.getLostLeaseCount()`.

---

## Testing locks

`in-process` and `postgres` backends are both testable without a live cluster.
Crucially, two `postgres` backend *instances* sharing one database contend over
a real lease row, so cross-"session" contention and stranding are exercisable
even on single-connection PGlite — which the `advisory` backend could not be.

> Disabling locking in tests (`distributedLocking: false`) does **not** validate
> locking. To validate lock correctness, exercise the `postgres` or `in-process`
> backend directly, or run an integration test against real PostgreSQL behind
> your configured pooler.
