# Running behind a connection pooler

**Short answer: yes, BunSane supports PgBouncer `pool_mode = transaction`** —
that is the deployment the framework is tuned for. But transaction pooling
removes session affinity, and a few things break *silently* when it does. This
page states which, and what to set.

Nothing here applies to `pool_mode = session` or a direct connection; both keep
session affinity and everything below is safe.

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
| Query/save wall-clock timeouts | ✅ safe | They cancel the in-flight statement (`query.cancel()`), so the backend is released rather than abandoned. |
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

- `DB_QUERY_TIMEOUT` (default 30 000 ms) — JS-side wall clock on
  `Query.exec/count/sum/average`, `Entity.save` and `Entity.doDelete`. It
  **cancels** the running statement via `AbortSignal` → `query.cancel()`, then
  rejects. Without the cancel, an abandoned query keeps its backend busy and a
  slowdown compounds into pool exhaustion.
- `DB_CONNECTION_TIMEOUT` (default 30 s) — how long the pool waits for a free
  slot. Consider 5 s for user-facing services.
- `statement_timeout` — server-side backstop; set it on the role behind a
  pooler.
