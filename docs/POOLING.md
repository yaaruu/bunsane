# Running behind a connection pooler

**BunSane runs behind PgBouncer `pool_mode = transaction`, but that is not the
recommended topology.** Transaction pooling removes session affinity, and the
features that depend on it fail *silently* rather than loudly. Where a choice
exists, prefer **`pool_mode = session` scoped to the application's
user/database** (PgBouncer supports per-user and per-database `pool_mode`), or a
direct connection: both keep session affinity and everything on this page is
safe. Check `pool_size` / `max_db_connections` for that pool so the app's
session-pinned connections do not starve other consumers.

If you must run transaction pooling, read this page in full — it lists what
breaks, what to set, and what the framework verifies at boot.

> Honesty note: an earlier revision of this page opened with *"yes, BunSane
> supports `pool_mode = transaction` — that is the deployment the framework is
> tuned for"* and marked wall-clock timeouts ✅ safe. That claim had no test
> behind it and was wrong (B8a, below). Rows on this page are now expected to
> cite a measurement or a boot probe.

---

## Required settings behind a transaction pooler

| Setting | Value | Why |
|---|---|---|
| `DB_DISABLE_PREPARE` | `true` | Bun SQL auto-prepares per connection. Under transaction pooling the next statement can land on a backend that has never seen the prepared statement → `prepared statement "…" does not exist`, which can poison the pooled client and wedge the write path. |
| `BUNSANE_LOCK_BACKEND` | leave unset (`auto` → `postgres`) | The lease backend needs no session affinity. See [LOCKING.md](./LOCKING.md). |
| `statement_timeout` | `ALTER ROLE <user> SET statement_timeout = '<ms>'` | `DB_STATEMENT_TIMEOUT` does **not** work here — see below. |

PgBouncer itself needs `options` in `IGNORE_STARTUP_PARAMETERS` (most
deployments already have it, or connections fail outright).

---

## What is unsafe under transaction pooling

| Feature | Status | Notes |
|---|---|---|
| Session advisory locks (`advisory` lock backend) | ❌ unsafe | `sql.reserve()` pins a *client-side pool slot*, not a backend. `pg_try_advisory_lock` can acquire on backend A while `pg_advisory_unlock` runs on backend B, returns false, and the lock stays held until that backend is recycled. Every *successful* lock strands its own key. The backend now refuses to run here unless `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`. |
| Server-side prepared statements | ❌ unsafe | Set `DB_DISABLE_PREPARE=true`. |
| `DB_STATEMENT_TIMEOUT` | ❌ inert | Passed as the `options` startup parameter, which the pooler drops. Use `ALTER ROLE`. |
| `LISTEN` / `NOTIFY`, `SET SESSION`, session temp tables | ❌ unsafe | Not used by the framework; avoid in application code. |
| Lease lock backend (`postgres`, the default) | ✅ safe | One autocommit statement per acquire/renew/release. |
| Transactions (`Entity.save`, `db.transaction`) | ✅ safe | A transaction is pinned to one backend for its duration. |
| Query/save wall-clock timeouts as a *slot recovery* mechanism | ❌ ineffective | `query.cancel()` does not free the slot through a pooler: the statement runs to natural completion and holds its connection for the full duration (measured — see B8a below). The timeout still bounds the caller. The only real statement bound is server-side `statement_timeout`. |
| Projections / QSP dual-write | ✅ safe | Ordinary statements and transactions. |

### JSONB parameters

With `prepare: false`, Bun SQL serializes a JS object bound as a parameter to
the string `"[object Object]"`. Use the `sql(rows, ...columns)` helper (what
`Entity.save` does) or an inline literal for JSONB writes; do not bind a raw
object to a `::jsonb` placeholder. `JSON.stringify()` + `::jsonb` is *also*
wrong with `prepare: true` — it arrives as a jsonb **string**, so `||` merges
produce an array instead of an object.

---

## Boot-time verification

The framework no longer assumes any of this. On startup, `probeConnection()`
(`database/connectionProbe.ts`) measures it:

- **Pooling mode** — `pg_backend_pid()` issued as separate statements on one
  reserved slot. Different PIDs *prove* transaction pooling and log a warning
  listing what is unsafe. Identical PIDs mean **unproven**, not proven safe.
- **`statement_timeout`** — `SHOW statement_timeout` read back and compared with
  `DB_STATEMENT_TIMEOUT`. A mismatch logs at **error** with the `ALTER ROLE`
  remedy, because the documented mitigation is silently inert.

The probe never throws; it never blocks boot. The `advisory` lock backend runs
its own stricter probe (`set_config` then read back on a separate statement) and
*does* throw, because a stranded lock is a correctness failure, not a warning.

---

## Timeouts, end to end

**Behind a transaction pooler, the only effective bound on a statement is
server-side.** Everything else bounds the caller, not the work.

- `statement_timeout` — **the real one.** Set it on the role:
  `ALTER ROLE <user> SET statement_timeout = '<ms>'`. `DB_STATEMENT_TIMEOUT` is
  inert here (the `options` startup parameter is dropped, see above), and the
  client-side clocks below cannot stop a running statement. Set
  `idle_in_transaction_session_timeout` on the role too.
- `DB_QUERY_TIMEOUT` (default 30 000 ms) — JS-side wall clock on
  `Query.exec/count/sum/average`, `Entity.save` and `Entity.doDelete`. It bounds
  **how long the caller waits**. It requests cancellation first, but see B8a
  below: through a pooler that does not release the slot. Treat it as a caller
  deadline, never as capacity recovery.
- `DB_CONNECTION_TIMEOUT` (default 30 s) — Bun SQL's connection-**establishment**
  timeout. When it fires, `ERR_POSTGRES_CONNECTION_TIMEOUT` is answered as
  **503 + `Retry-After`** (`code: POOL_EXHAUSTED`) and counted as
  `poolAcquireFailures` in `/metrics`. ⚠️ Whether it also bounds *waiting for a
  busy pool* is **unverified**: against the PGlite bridge with `max: 1`, a second
  caller queued 2.9 s and then succeeded rather than timing out at 1 s. Measure
  your own topology with `bun run test:pool-saturation` before treating this as
  fast-fail. **Request-facing deployments should still set `5`.** The default
  stays 30 s because background work (scheduler, outbox, projection
  backfill/reconcile) shares the same pool and legitimately waits longer; there
  is no per-lane timeout yet.
- `DB_POOL_IDLE_TIMEOUT` (default 30) and `DB_POOL_MAX_LIFETIME` (default 600) —
  **seconds**, not milliseconds. Connection recycling; see below.
- `DB_POOL_SATURATION_READY_MS` (default 3000, `0` disables) — how long the pool
  must stay saturated before `/health/ready` starts failing. See below.

### B8a — a client-side abort cannot reclaim server-side work

Measured against pgbouncer `pool_mode = transaction`: aborting a
`SELECT pg_sleep(20)` released the pool slot at **20.0 s** — the query's natural
end — both when the client abandoned it and when it called `cancel()` and waited
5 s. A Postgres cancel request travels on a separate connection keyed by backend
PID and must be forwarded by the pooler; forwarding needs a server connection,
which is precisely what is missing when the pool is exhausted.

Consequence: a wall-clock timeout provides **zero** slot recovery behind a
pooler. Slots stay pinned for the real duration of every abandoned query, so a
run of slow queries walks the pool down one slot at a time. The mitigations that
do work are the server-side `statement_timeout` above, a fast
`DB_CONNECTION_TIMEOUT` so callers fail instead of queueing, and shedding traffic
on readiness while the pool drains.

`BUNSANE_ABORT_MODE=cancel|off` (default `cancel`) exists **temporarily** so a
deployment can test whether issuing `cancel()` is itself implicated in
connections that never return to the pool. It will be removed once that is
settled.

---

## Connection recycling (fixed in 0.5.11 — check your config)

Bun SQL pool timeouts are in **seconds**. Up to 0.5.10 the framework passed
`idleTimeout: 30000` and `maxLifetime: 600000`, intending 30 s / 10 min but
actually configuring ~8 h 20 m / ~6.9 days — so **no connection was ever recycled
on age or idleness** within a container's lifetime. An idle pool never shrank
(pinning `max` server-side connections behind the pooler after any burst), and a
connection in a degraded state — protocol desync, for instance — had no
age-based escape hatch.

Defaults are now 30 s idle / 600 s lifetime, overridable via
`DB_POOL_IDLE_TIMEOUT` / `DB_POOL_MAX_LIFETIME` (seconds), and a value above
86 400 is **rejected at boot** rather than silently disabling the policy — use
`0` if "no limit" is genuinely intended.

---

## Saturation vs. wedged: two conditions, two signals

| Condition | Signal | Response |
|---|---|---|
| Pool **saturated** (full, still moving) | `/health/ready` → 503 with a `db_pool` check, after `DB_POOL_SATURATION_READY_MS` sustained | Shed traffic, drain in place |
| Pool **wedged** (write path stuck) | `/health` write probe hangs → 503 | Restart the container |

Saturation deliberately does **not** fail liveness: a full pool is also what a
legitimate burst looks like, and restarting mid-burst turns a slow minute into a
cold start plus a reconnect thundering herd.

Watch `poolMax`, `inFlight`, `inFlightMax`, `poolSaturatedForMs` and
`poolAcquireFailures` in `/metrics`. Caveat: `inFlight` counts only the calls
that go through `database/instrumentedDb.ts`, which is a subset of framework DB
traffic today — it is a **lower bound** on occupancy. A positive saturation
reading is certain; a zero is unproven.
