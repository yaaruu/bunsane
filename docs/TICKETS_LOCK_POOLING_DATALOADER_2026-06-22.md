# Tickets — locking / pooling / DataLoader (from a 2026-06-22 prod incident)

Source: a downstream app (Isoiresik) hit production order-status stranding traced to framework behavior, not app code. All file:line refs are relative to this repo root. Severity ordered.

---

## BUNSANE-1 — `DistributedLock` / `withLock` silently broken behind a transaction-pooling pgbouncer (CRITICAL)

**Component:** `core/scheduler/DistributedLock.ts`, `core/scheduler/withLock.ts`

**Problem.** `DistributedLock` acquires session-level `pg_advisory_lock` on a connection pinned via `db.reserve()` (`DistributedLock.ts:83-102`, `:291-299`). The doc comment assumes `reserve()` pins one Postgres session. When the DB is reached through **pgbouncer in `pool_mode = transaction`**, each *transaction* is multiplexed onto a different server backend. So:
- `pg_try_advisory_lock` acquires on backend A;
- `pg_advisory_unlock` (a later, separate transaction) lands on backend B → returns `false` → the lock is **stranded** on backend A's session;
- the next `tryAcquire` for the same key lands on a different backend → `pg_try_advisory_lock` returns `false` → `withLock` returns `{acquired:false}` and **the guarded work is skipped**.

`reserve()` pins the *client*→pgbouncer connection, not the pgbouncer→Postgres server backend. The whole pinning strategy is defeated by the pooler.

**Evidence.** `DistributedLock.ts:5-15` (pinning rationale), `:227-242` (`pg_advisory_unlock returned false` warn path = the strand happening). Downstream prod `pgbouncer.ini`: `pool_mode = transaction`. Observed: an order with all items completed + shelved had both IN_PROGRESS→PREPARING and PREPARING→READY advances (each `withLock`-guarded) dropped.

**Impact.** Any `withLock` user behind a transaction pooler intermittently and silently skips its critical section. Worsens over time as strands accumulate on pooled backends. No error raised to the caller.

**Proposed fix (pick one):**
1. **Dedicated lock connection that bypasses the pooler.** Let `DistributedLock` take its own DSN (`LOCK_DB_URL`) pointing at Postgres directly (or a pgbouncer `session`-mode port). Document that advisory locks REQUIRE a session-pinned connection.
2. **Detect & refuse silently-unsafe config.** On first acquire, verify session affinity (e.g. `SET` a session GUC then read it back on a follow-up query; if it doesn't persist, the pool isn't session-pinned) and log a loud error / throw, instead of silently returning `{acquired:false}`.
3. **Offer a non-advisory lock backend** (Redis `SET NX PX`, or a `locks` table row with `SELECT … FOR UPDATE` inside one transaction) that is pooler-safe.

**Acceptance.** With pgbouncer `pool_mode=transaction`, `withLock(key, fn)` either runs `fn` under genuine mutual exclusion, or fails loudly at startup/first-use — never silently skips.

---

## BUNSANE-2 — `withLock` contract silently drops work; stranded locks only WARN (HIGH)

**Component:** `core/scheduler/withLock.ts`, `core/scheduler/DistributedLock.ts`

**Problem.** Two footguns compound BUNSANE-1:
1. Default `wait: 0` makes `withLock` return `{acquired:false}` **without running `fn`** on any contention (`withLock.ts:58-88`). A caller that forgets to handle `acquired:false` silently loses the work. The downstream app had to defensively pass `wait` and add a manual fallback that persists the work directly.
2. A failed unlock (`pg_advisory_unlock returned false`) — i.e. the BUNSANE-1 strand — is logged at **WARN** and swallowed (`DistributedLock.ts:238-242`). The single highest-signal symptom of a broken lock is near-invisible.

**Proposed fix.**
- Make the "lock unavailable" outcome impossible to ignore: either throw a typed `LockUnavailableError` (opt-out via option) or require the caller to pass an explicit `onContended` handler.
- Promote a false `pg_advisory_unlock` to ERROR, and add a metric/counter so strands are observable.
- Document the `wait:0` semantics at the call site (it currently reads like a timeout, not a "skip entirely" switch).

**Acceptance.** Misuse (ignoring contention) is a compile-time or loud-runtime failure, not a silent no-op. Stranded unlocks are surfaced.

---

## BUNSANE-3 — Request `componentsByEntityType` DataLoader not invalidated on `entity.save()` → stale reads within a request (HIGH)

**Component:** `core/RequestLoaders.ts`, `core/entity/saveEntity.ts`, `core/entity/componentAccess.ts`

**Problem.** Bare `entity.get(Component)` inside a GraphQL request routes through the ambient request-scope DataLoader (`componentAccess.ts:310-331`). `componentsByEntityType` is a standard `DataLoader` with caching ON (`RequestLoaders.ts:99,218` — `cacheKeyFn = entityId\x00typeId`, no `cache:false`). The save path does **not** `clear()`/`prime()` that loader for the changed `(entityId, typeId)` (`saveEntity.ts` — only `entity.removedComponents.clear()` at `:220`, unrelated). So within one request: read component (loader caches old value) → `set` + `save` → read again via a fresh shell/loader path → **stale old value returned**.

**Evidence.** `componentAccess.ts:315-331`; `RequestLoaders.ts:99-218`; `saveEntity.ts` (no loader invalidation). This was a candidate root cause for the incident before the lock was confirmed; it remains a latent correctness bug for any read-after-write in the same request via the loader.

**Proposed fix.** On commit, `requestScope.loaders.componentsByEntityType.clear({entityId, typeId})` (and `entityById.clear(entityId)`) for every changed/removed component, or `.prime()` with the new value. Hook it into the same post-commit step that drains side effects.

**Acceptance.** Read-after-write of a component within a single request returns the written value regardless of whether the read goes through the loader.

---

## BUNSANE-4 — Advisory lock keys collapse to 32 bits → cross-key false contention (MEDIUM)

**Component:** `core/scheduler/DistributedLock.ts:64-76`

**Problem.** `generateLockKey` computes a JS string hash with `hash = hash & hash` (truncates to 32-bit signed), `Math.abs`, then ORs it into the low 32 bits under a fixed 32-bit prefix. Effective key space ≈ 2^32. Distinct lock keys that hash-collide map to the **same** advisory lock id → unrelated critical sections block each other (false contention), independent of BUNSANE-1.

**Proposed fix.** Use a 64-bit hash (e.g. xxhash64/fnv-1a 64) for the full `bigint` advisory key, or key off `pg_advisory_lock(int4, int4)` with a structured (namespace, hash) pair. Document the collision probability.

**Acceptance.** Two distinct keys do not share an advisory lock id within practical key volumes.

---

## BUNSANE-5 — `loadComponents` `skipCache` parameter is dead / misleading API (MEDIUM)

**Component:** `core/entity/finders.ts:61`, `core/Entity.ts:229` (`LoadComponents`), `query/Query.ts` (passes `skipComponentCache`)

**Problem.** `loadComponents(entities, componentIds, skipCache = false)` declares `skipCache` but never references it (`finders.ts:61-95`) — the body always reads `db` directly. `Query.exec` threads `this.skipComponentCache` through `Entity.LoadComponents` into this dead param. Callers reasonably believe they can force/avoid caching; it does nothing. (It always reads fresh from Postgres, which is the safe-but-unintended behavior.)

**Proposed fix.** Either implement the flag honestly (consult/skip the relevant cache) or delete the param across the chain and document that `loadComponents`/`.populate()` always read through to Postgres.

**Acceptance.** No parameter that silently does nothing; behavior matches the signature.

---

## BUNSANE-6 — Distributed lock is disabled in tests → the lock path is untested in consumers (MEDIUM)

**Component:** test harness guidance / `getDistributedLock` test ergonomics

**Problem.** Consumer test setups disable locking (`getDistributedLock({enabled:false})`) because real `pg_advisory_lock` starves a single-connection PGLite. Consequence: `withLock`-guarded logic runs the in-process path in tests and the *distributed* path is never exercised — so BUNSANE-1/2 shipped green in the downstream suite (550+ tests) and only broke in prod.

**Proposed fix.** Ship a framework-provided, pooler-faithful lock test double (e.g. an in-memory `DistributedLock` that simulates cross-"session" contention and stranding), plus docs: "PGLite/disabled-lock tests do NOT validate locking; add an integration test against real Postgres + the configured pooler."

**Acceptance.** A documented, runnable way to test lock correctness without a live cluster; release notes flag the test gap.

---

## BUNSANE-7 — Document & startup-guard pooling constraints for lock/scheduler (LOW / DOCS)

**Component:** docs + `core/App` startup

**Problem.** Nothing warns that `DistributedLock`, `@ScheduledTask` cron gating, `sql.reserve()`, and LISTEN/NOTIFY are unsafe behind a transaction-pooling pooler. A downstream deploy once asserted transaction pooling was "verified SAFE: no session advisory locks" — true until app code later adopted `withLock`, silently invalidating the assumption.

**Proposed fix.** (1) Docs section: "Connection pooling & session-bound features — what breaks under transaction pooling and how to configure a session-pinned lane." (2) Optional startup probe: if any `withLock`/scheduler feature is enabled AND the connection target looks pooled in transaction mode, emit a prominent warning (or require an explicit ack env).

**Acceptance.** Adopting `withLock`/scheduler surfaces the pooling requirement at build/boot, not via a production incident.

---

### Summary

| ID | Severity | One-liner |
|----|----------|-----------|
| BUNSANE-1 | Critical | Advisory lock silently broken behind transaction-pooling pgbouncer |
| BUNSANE-2 | High | `withLock` silently drops work on contention; strands only WARN |
| BUNSANE-3 | High | Request DataLoader not invalidated on save → stale read-after-write |
| BUNSANE-4 | Medium | 32-bit lock-key hash → cross-key false contention |
| BUNSANE-5 | Medium | Dead `skipCache` param (misleading API) |
| BUNSANE-6 | Medium | Lock disabled in tests → lock path untested in consumers |
| BUNSANE-7 | Low/Docs | No docs/guard for pooling vs session-bound features |
