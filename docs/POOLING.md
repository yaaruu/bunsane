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
| Query/save wall-clock timeouts as a *slot recovery* mechanism | ❌ ineffective **everywhere** | `query.cancel()` issues no CancelRequest at all: the statement runs to natural completion and holds its connection for the full duration. Measured identically on a direct connection and through the pooler, so this is a driver property, not a pooling one — session mode does not fix it (see B8a below). The timeout still bounds the caller. The only real statement bound is server-side `statement_timeout`. |
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
- **Cancel effectiveness** — does aborting a statement actually stop it? A
  ~150 ms `pg_sleep` is aborted a quarter of the way in, through the framework's
  own `runWithSignal` path (so `BUNSANE_ABORT_MODE=off` reports honestly), and
  the *statement* is watched to see when it really ended. `runWithSignal`
  releases the caller immediately by design, so caller latency proves nothing —
  only the statement's own settle time does.

  Two traps this avoids, both of which would certify the broken property as
  working: a role-level `statement_timeout` killing the probe's own sleep looks
  identical to a successful cancel on timing (both are SQLSTATE 57014, so the
  message text decides, and the probe sizes its sleep under the server bound or
  declines to run); and a skipped or failed probe reports **`null` — unproven**,
  never "fine".

  An ineffective cancel **combined with** no server-side `statement_timeout`
  logs at **error**: that pair means nothing in the deployment can stop a slow
  query, which is the outage precondition exactly. Either alone is a warning.

The probe never throws; it never blocks boot. The `advisory` lock backend runs
its own stricter probe (`set_config` then read back on a separate statement) and
*does* throw, because a stranded lock is a correctness failure, not a warning.

---

## Timeouts, end to end

**The only effective bound on a statement is server-side — on every topology,
not just behind a pooler.** Everything else bounds the caller, not the work.

- `statement_timeout` — **the real one.** Set it on the role:
  `ALTER ROLE <user> SET statement_timeout = '<ms>'`. `DB_STATEMENT_TIMEOUT` is
  inert here (the `options` startup parameter is dropped, see above), and the
  client-side clocks below cannot stop a running statement. Set
  `idle_in_transaction_session_timeout` on the role too.
- `DB_QUERY_TIMEOUT` (default 30 000 ms) — JS-side wall clock on
  `Query.exec/count/sum/average`, `Entity.save` and `Entity.doDelete`. It bounds
  **how long the caller waits**. It requests cancellation first, but see B8a
  below: that request never reaches Postgres, on any topology, so the slot is not
  released. Treat it as a caller deadline, never as capacity recovery.
- `DB_CONNECTION_TIMEOUT` (default 30 s) — Bun SQL's connection-**establishment**
  timeout. When it fires, `ERR_POSTGRES_CONNECTION_TIMEOUT` is answered as
  **503 + `Retry-After`** (`code: POOL_EXHAUSTED`) and counted as
  `poolAcquireFailures` in `/metrics`. ⚠️ **It does not bound waiting for a busy
  pool** — no longer "unverified", measured 2026-07-27 on real PostgreSQL 17.10:
  with `connectionTimeout: 1`, a caller arriving at a full pool queued **4860 ms
  (direct) / 4862 ms (through pgbouncer)** and then succeeded, waiting out the 5 s
  statements ahead of it. The earlier PGlite observation (2.9 s on `max: 1`) was
  not a single-connection artifact. Do **not** treat this as a fast-fail
  mechanism; framework-side admission (`database/gateway.ts`) is what bounds the
  wait. Setting `5` is still reasonable for request-facing deployments as an
  establishment bound. The default stays 30 s because background work (scheduler,
  outbox, projection backfill/reconcile) shares the same pool and legitimately
  waits longer.
- `DB_POOL_IDLE_TIMEOUT` (default 30) and `DB_POOL_MAX_LIFETIME` (default 600) —
  **seconds**, not milliseconds. Connection recycling; see below.
- `DB_POOL_SATURATION_READY_MS` (default 3000, `0` disables) — how long the pool
  must stay saturated before `/health/ready` starts failing. See below.

### B8a — a client-side abort cannot reclaim server-side work

**This section previously blamed the pooler. That was wrong, and the correction
matters: it means session pooling does not fix this.** Re-measured 2026-07-27 on
PostgreSQL 17.10 with Bun 1.4.0-canary.1, running the identical harness
(`tests/load/pool-saturation.ts`) against both topologies:

| topology | abort issued | slot reacquired | statement |
|---|---|---|---|
| direct connection, no pooler | 311 ms | **5010 ms** | 5000 ms |
| pgbouncer `pool_mode = transaction` | 316 ms | **5009 ms** | 5000 ms |

Identical to within 1 ms. The slot is pinned for the statement's full natural
duration **on a direct connection too**, so cancel-forwarding through a pooler is
not the mechanism.

The actual mechanism, observed from a second connection via `pg_stat_activity`
while aborting a `pg_sleep(8)` with three pool slots free (capacity confirmed
live, so the cancel cannot be queued behind the query it targets):

```
[408ms]  spare slot usable in 3ms
[415ms]  cancel() called
[1323ms] backend 106920: active
...        active at every 900ms sample
[7717ms] backend 106920: active
[8018ms] query RESOLVED          <-- resolves normally, 8s = natural end
[8623ms] backend 106920: idle
```

`query.cancel()` exists and returns a promise, but that promise resolves only when
the statement ends on its own, and the query **resolves rather than rejecting**.
No CancelRequest is issued to Postgres. `runWithSignal` therefore bounds the
CALLER and nothing else — on every topology.

Consequence: a wall-clock timeout provides **zero** slot recovery, pooler or not.
Slots stay pinned for the real duration of every abandoned query, so a run of slow
queries walks the pool down one slot at a time.

**`DB_CONNECTION_TIMEOUT` is not a mitigation either** — an earlier revision of
this page listed it as one. With `connectionTimeout: 1`, a caller arriving at a
full pool queued for **4860 ms (direct) / 4862 ms (pgbouncer)** and then
succeeded: it waited out the 5 s statements. Bun documents the option as the
*establishment* timeout, and that is exactly what it is. It does not bound waiting
for a busy pool. Admission has to be bounded by the framework
(`database/gateway.ts`), which is why the seam owns its own queue and deadline
rather than delegating to the driver.

What actually works:

- **`statement_timeout`, server-side** — the only real bound. `SET LOCAL
  statement_timeout` inside a transaction killed a 6 s statement at **1215 ms
  (direct) / 1213 ms (pgbouncer)**, with the slot reusable **1–2 ms** later. Use
  `SET LOCAL`, never plain `SET`: under transaction pooling a session-level `SET`
  leaks to the next client of that pooled server connection.
- **Role-level default** — `ALTER ROLE <user> SET statement_timeout = '<ms>'`
  covers single statements that are not wrapped in a transaction, at zero
  per-query cost. This is the universal ceiling; set it.
- **Shedding traffic on readiness** while the pool drains.

Cost note, in case you are tempted to wrap every statement to guard it: on a
trivial `SELECT 1`, `BEGIN`/`COMMIT` plus `SET LOCAL` costs **+0.95 ms (3.7×)**
against a 0.35 ms baseline. Inside a transaction that already exists, `SET LOCAL`
costs **+0.12 ms**. So the framework guards transactions by default and leaves
bare statements to the role-level default.

### What the framework does about it

`dbTransaction` (`database/gateway.ts`) emits `SET LOCAL statement_timeout` from
its own deadline, on every transaction it opens. Every write path — `entity.save`,
`entity.delete`, studio bulk deletes — therefore carries a real server-side bound.

Cost, measured end to end rather than projected: **+0.40 ms on a 3.0 ms entity
save (13%)**, 200 interleaved samples on real PG 17 — **a local Docker Postgres,
so read it as one extra round trip, not as a portable percentage**. The absolute
cost scales with your RTT; the percentage also depends on how many statements
your save already issues. It is the floor — issuing the `SET LOCAL` unawaited so the driver might
pipeline it with the transaction body was tried and changed nothing (0.397 ms vs
0.400 ms), because Bun serializes a connection's queue. The +0.12 ms quoted above
is the micro-benchmark figure for a bare `BEGIN`/`SELECT 1`/`COMMIT`; a real save
pays a full round trip.

Three deliberate exceptions:

- **Bare statements are not wrapped.** `dbExec` takes `serverTimeout: true` per
  call, and the studio endpoints and projection backfill/reconcile set it,
  because ~1 ms is invisible against a table scan. The read path does not, because
  it issues thousands of statements per request and +3.7× each is a regression,
  not a safeguard. **This is the gap the role-level default covers, and the reason
  it is load-bearing.**
- **Not on DDL.** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
  block, so `projDdl` and `IndexingStrategy` stay unwrapped.
- **Not on a caller-supplied handle.** `SET LOCAL` is transaction-scoped, not
  savepoint-scoped: releasing a savepoint does not restore the previous value, so
  emitting inside a transaction *you* opened would silently reset your
  `statement_timeout` for the rest of it.

When the server kills a statement the framework re-throws it as
`DbStatementTimeoutError` carrying the lane, label and budget, instead of the bare
`canceling statement due to statement timeout`. `BUNSANE_DB_SERVER_TIMEOUT=off`
disables emission entirely; it is also skipped under PGlite.

`BUNSANE_ABORT_MODE=cancel|off` (default `cancel`) exists **temporarily** so a
deployment can test whether issuing `cancel()` is itself implicated in
connections that never return to the pool. Note that the two modes are now known
to be equivalent from the server's point of view — the switch can only bisect
client-side effects. It will be removed once B8b is settled.

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
