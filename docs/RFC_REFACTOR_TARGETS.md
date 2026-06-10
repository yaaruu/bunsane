# RFC: Remaining Refactor Targets

**Status:** Backlog / planning
**Author:** uray@qyubit.io (drafted with Claude)
**Date:** 2026-05-09 (updated 2026-06-10)
**Prior work:**
- `core/ArcheType.ts` split — commit `a886b45`, merged to `staging` (`fd75f21`).
- `core/App.ts` split — branch `refactor/app-split`, merged to `staging` (`c855e04`). See §3.1.

---

## 1. Purpose

After `ArcheType.ts` was split (3064 → 1032 LOC across 8 modules under `core/archetype/`), several other files in `core/` remain large and concern-dense. This RFC enumerates them in priority order so future refactor work has a reference. As of 2026-06-10, targets §3.1, §3.3, §3.4, §3.5 are complete; only §3.2 (`Entity.ts`) remains, gated on `ENTITY_COMPONENTS_REMOVAL_PLAN.md`.

This is a **planning document**, not an approval-bound RFC. Each target listed here would get its own scoped RFC (like `RFC_APP_REFACTOR.md`) before work starts.

## 2. Selection Criteria

Files are ordered by combined score of:

1. **Size** (LOC) — bigger = harder to read, harder to test.
2. **Concern density** — number of distinct responsibilities mixed in one class/module.
3. **Blast radius** — how many tests/consumers depend on the file booting cleanly.
4. **Refactor ROI** — likelihood that splitting yields independently testable modules without behavior change.

Pure "library leaf" files (formatter helpers, fixed schemas) are excluded even when large, because splitting them wouldn't reveal new structure.

## 3. Targets

### 3.1 `core/App.ts` — ~~1477 LOC~~ → 386 LOC — **DONE (2026-05-09)**

**Completed:** branch `refactor/app-split`, merged to `staging` (`c855e04`). 1477 → 386 LOC across 11 modules under `core/app/`: `bootstrap`, `cors`, `graphqlSetup`, `healthEndpoints`, `metricsCollector`, `preparedStatementWarmup`, `processHandlers`, `requestRouter`, `restRegistry`, `shutdown`, `studioRouter`.

Original concern inventory (for reference) — the file mixed:

- Application lifecycle (phase orchestration, DB prep, component registration).
- HTTP server (Bun.serve setup, request routing, signal/disconnect plumbing).
- CORS (origin validation, header injection, preflight handling).
- OpenAPI spec generation (per-endpoint registration, Swagger UI HTML).
- GraphQL setup (Yoga instance, depth/complexity limits, plugin pipe, context factory wrap).
- REST routing (endpoint collection, dispatch).
- Plugin pipeline (`addPlugin`, `addYogaPlugin`).
- Scheduler bootstrap (`SchedulerManager` init, scheduled task registration per service).
- Health endpoints (`/health`, `/health/ready`, `/health/remote`).
- Metrics endpoint (`/metrics`).
- Studio routing (`/studio/api/*` — 107 LOC inline).
- Remote subsystem bootstrap (RemoteManager init, handler registration).
- Process signal & error handlers (SIGTERM, SIGINT, unhandledRejection, uncaughtException).
- Graceful shutdown ordering (HTTP → scheduler → remote → cache → DB).
- Prepared-statement cache warm-up (since obsoleted: warm-up is a no-op as of the 2026-06-10 perf overhaul — Bun SQL auto-prepares; `core/app/preparedStatementWarmup.ts` kept as deprecated shell for `/metrics` API stability).

**Detailed plan:** see `RFC_APP_REFACTOR.md`.

**Status:** Done. Extraction pattern from §4.1 held up; reuse for remaining targets.

---

### 3.2 `core/Entity.ts` — 1142 LOC (was 1212 at draft time)

**Why next:** `save()` alone likely 300+ LOC. Cache ops inline. Mixes:

- Component add/get/remove (in-memory + persisted).
- DB persistence (insert/update/delete with abort signal + per-component partitioned writes).
- Cache write-through / write-invalidate strategies (L1 + L2 + pubsub), batch write-through via `CacheManager.setComponentsBatchWriteThrough` (2026-06-10), negative caching for absent components (`4f3c893`).
- Hook dispatch (pre-save, post-save, post-delete) via `EntityHookManager`.
- Post-commit side effects (cache, hooks) scheduled via `queueMicrotask` so they don't consume save budget (v0.3.0).
- Pending side-effects queue (`Entity.pendingCacheOps`, `Entity.pendingSideEffects` static drain methods for shutdown; `trackCacheOp` now public — `populate()` cache warming registers through it).
- Profile timing (`DB_SAVE_PROFILE`).
- Abort signal handling (timeout + client disconnect cancellation).
- Component-ready preflight (`ComponentRegistry.getReadyPromise`).
- Static finders (`FindById`, etc.).

**⚠ Sequencing dependency (added 2026-06-10):** `docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md` rewrites the same `save()` / `doDelete()` bodies — it removes 5 `entity_components` write sites in this file (`Entity.ts:834,895,911,979,986`). Run the removal plan **first**, then refactor the smaller surviving `save()`. Refactoring first means re-reviewing the split immediately after.

**Known latent bug (file separately per §4.4):** `doSave` sets `_persisted = true` early, making the later `if (!this._persisted)` entity_components-for-existing-components block dead code (affects `MakeRef` path only). The removal plan deletes that block anyway.

**Proposed split direction:**

```
core/entity/
  saveEntity.ts       # save() body — DB writes, abort, profile
  cacheStrategies.ts  # write-through, write-invalidate per component
  pendingOps.ts       # pendingCacheOps + pendingSideEffects + drain methods
  componentAccess.ts  # add/get/remove + in-memory cache
  finders.ts          # static FindById, etc.
```

Class skeleton + public API stays in `Entity.ts`.

**Risks:**

- `Entity.save()` is hot-path. Per-step micro-benchmark (save 1000 entities) before/after each extraction.
- Hook ordering is load-bearing (per `MEMORY.md` H-HOOK-1..3, C13). Don't reorder pre/post-commit phases.
- The PGlite Bun-SQL ACK race (documented in `CLAUDE.md`) is in this file's blast radius — keep `await entity.save()` semantics byte-identical.

**Estimated effort:** larger than App.ts because of perf sensitivity. ~6–8 hours plus benchmark validation.

**Status:** Not started. Blocked-soft on `ENTITY_COMPONENTS_REMOVAL_PLAN.md` (see sequencing note above).

---

### 3.3 `core/SchedulerManager.ts` — ~~806 LOC~~ → 310 LOC — **DONE (2026-06-10)**

**Completed:** merge `c5f9730`. Split into `core/scheduler/`: `cronEvaluator`, `taskRunner`, `lockCoordinator`, `lifecycleHooks`, `metrics`. Full suite green (829 pass / 0 fail), guards H-SCHED-1..5 + C14 preserved. Follow-ups noted in review (non-blocking): dead imports in `SchedulerManager.ts`, internals promoted public for the instance-parameter pattern (mark `@internal`), `(manager as any).executeTask` casts.

**Why next:** Scheduling logic + distributed lock + hook orchestration in one class.

Concerns to disentangle:

- Cron expression parsing + schedule evaluation.
- Task registration & lookup (`registerScheduledTasks`).
- Per-task execution loop with skip-on-running guard (H-SCHED-1..5 in memory).
- Distributed lock (`DistributedLock`) acquisition + release semantics.
- Lifecycle integration (`disposeLifecycleIntegration`, awaiting in-flight tasks on `stop()` per C14).
- Metrics (`getMetrics`).
- Error handling per task.

**Proposed split direction:**

```
core/scheduler/
  cronEvaluator.ts    # cron expression -> next-fire-time
  taskRunner.ts       # per-task execute loop + skip-on-running
  lockCoordinator.ts  # DistributedLock wiring
  lifecycleHooks.ts   # phase-listener + dispose
  metrics.ts          # getMetrics
```

`SchedulerManager` keeps singleton + public API.

Note: `core/scheduler/` already exists and holds `DistributedLock.ts` (the lock itself was never inside `SchedulerManager` — `lockCoordinator.ts` here means only the acquire/release wiring around task runs, a smaller extraction than the name suggests).

**Risks:**

- Concurrency hardening already done in v0.3.0 (H-SCHED-1..5). Refactor must preserve every guard. Property-based tests on the runner would help.
- Re-entry semantics on `DistributedLock` (memory: `acquired:false` on overlap). Don't change.

**Status:** Not started.

---

### 3.4 `core/EntityHookManager.ts` — ~~827 LOC~~ → 200 LOC — **DONE (2026-06-10)**

**Completed:** merge `b82abe6`. Split into `core/hooks/`: `registry` (owns `typeIdOfCtor` memo), `dispatcher` (timer unref paths), `guards` (component-target matching). Hook ordering (C13, H-HOOK-1..3) verified by suite (829 pass / 0 fail); `typeIdOfCtor` byte-identical to `5eb1f16`. Note: `guards.ts` ended up holding component-target matching rather than timer logic (lives inline in dispatcher) — naming diverges from plan below, functionally fine.

**Why next:** Hook registry + dispatch + lifecycle in one place.

Concerns:

- Hook registration (per-component, per-event).
- Dispatch ordering (pre vs post, sync vs async).
- Hook chain with timer leak fixes (memory: H-HOOK-2, H-MEM-2).
- Re-entry / recursion guard.
- Integration with `Entity.save()` post-commit microtask scheduling.
- Memoized `typeIdOfCtor` Map for hook matching (perf, `5eb1f16`) — owned state that must move with the registry.

**Proposed split direction:**

```
core/hooks/
  registry.ts     # register/lookup
  dispatcher.ts   # dispatch loop + ordering
  guards.ts       # re-entry guard, timer cleanup
```

`EntityHookManager` keeps public API.

**Risks:**

- Hook timing fixes (C13, H-HOOK-1..3) are load-bearing. Tests assert specific orderings.
- Cross-file coupling with `Entity.ts` — coordinate with §3.2 if both run in flight.

**Status:** Not started.

---

### 3.5 `core/cache/CacheManager.ts` — ~~656 LOC~~ → 431 LOC — **DONE (2026-06-10)**

**Completed:** merge `ef70361`. Split into `core/cache/strategies/writeThrough.ts` (incl. `setComponentsBatchWriteThrough`), `strategies/writeInvalidate.ts` (incl. `invalidateEntityComponents`), `invalidation.ts` (pub/sub, `instanceId` loop prevention), `health.ts`. Contracts verified by suite: async `initialize`, frozen `getConfig()` identity, L1-only remote invalidation.

**Why next:** L1 (memory) + L2 (Redis) + strategies + pub/sub all-in-one. Already smaller than peers, so lower priority.

Concerns:

- Provider initialization (memory + Redis).
- Strategy dispatch (write-through vs write-invalidate).
- Batch ops (added 2026-06-10): `setComponentsBatchWriteThrough` (2 pipelined RTTs per save), `invalidateEntityComponents` (one deleteMany + one pub/sub message per save). Belong in `strategies/` when split.
- Cross-instance invalidation via Redis pub/sub (`instanceId` loop prevention).
- Cache stats / health (`ping`, `getStats`); `getConfig()` returns frozen direct ref — tests assert `toBe` + `Object.isFrozen`, preserve on split.
- Singleton lifecycle (`initialize` async, `shutdown`).

**Proposed split direction:**

```
core/cache/
  CacheManager.ts        # singleton + public API (kept)
  strategies/
    writeThrough.ts
    writeInvalidate.ts
  invalidation.ts        # pub/sub coordinator
  health.ts              # ping + stats
```

**Risks:**

- `CacheManager.initialize()` is now async (BREAKING CHANGE per memory, 2026-02-17). Don't regress.
- Cross-instance loop prevention (`instanceId`) is load-bearing. Test with two instances on same Redis.

**Status:** Not started. Lowest priority of the five — defer until at least one peer refactor lands.

---

## 4. Cross-Cutting Themes

Several patterns recur and would benefit from being decided once before any of these refactors start:

### 4.1 Extraction pattern

`ArcheType.ts` split established the pattern:

- Pure functions in submodules accept the class instance as a parameter (`buildFieldResolvers(archetype)`).
- Class methods become 1-line delegates via lazy `require()` to break circular type deps.
- Maps/state stay in the submodule that owns them, exported as `const`.
- Public API preserved by re-export from the parent file.

This pattern works well for ECS-style classes where the class is mostly a data bag with methods. **Re-use it for App, Entity, SchedulerManager, EntityHookManager.** `CacheManager` may want a different shape (provider injection) given its strategy variants.

### 4.2 Test infrastructure assumed stable

All targets are exercised by the existing suite (65 test files under `tests/`, run via `bun run test:pglite`). No target requires new test scaffolding before extraction starts; existing tests are sufficient guardrails for behavior preservation. The App.ts split (§3.1) confirmed this assumption in practice.

### 4.3 No DI introduction

Project rule (per `CLAUDE.md` and `MEMORY.md`): singletons + global exports, no dependency injection container. Extracted modules must respect this — pass `app: App`, `entity: Entity`, etc., not an injection token.

### 4.4 No bundled bug fixes

If a refactor reveals a latent bug (wrong ordering, missing guard, stale comment claim), file it separately. Refactor PRs must show "no behavior change" by passing the existing test suite unchanged.

## 5. Recommended Order

1. ~~**`App.ts`**~~ — **Done** (merged `c855e04`, 2026-05-09).
2. ~~**`SchedulerManager.ts`**~~, ~~**`EntityHookManager.ts`**~~, ~~**`CacheManager.ts`**~~ — **Done** (merged `c5f9730`, `b82abe6`, `ef70361` on 2026-06-10; executed in parallel via isolated worktrees, full suite green after each merge).
3. **`Entity.ts`** — Last remaining target. Gated **after** `ENTITY_COMPONENTS_REMOVAL_PLAN.md` lands (it rewrites/deletes large parts of `save()`; splitting first creates churn). Highest perf sensitivity but biggest readability win. Allocate benchmark time.

The original ordering rationale held: the most heavily-tested file went first (more guardrails); the perf-sensitive file goes last with dedicated benchmark time.

## 6. Anti-Goals

These are not refactors and should not be bundled:

- **Adding new abstractions** (router DSL, plugin SPI v2, hook framework). Out of scope for any of these.
- **Performance "improvements"** that change semantics. If a refactor reveals an O(n²) loop, file it separately.
- **API renaming** for "consistency". Public symbols stay byte-identical.
- **Comment cleanup pass** as a side effect. Touch only comments that are actively wrong after a code move.

## 7. Decision

This RFC requires no decision. It exists so the next person picking up refactor work has:

- A prioritized list.
- Concern inventory per file.
- Pre-identified risks per file.
- Cross-cutting guardrails (extraction pattern, no-DI rule, no bundled fixes).

When work starts on any one target, that target gets its own RFC and own branch (per the `RFC_APP_REFACTOR.md` template).
