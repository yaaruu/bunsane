# RFC: Remaining Refactor Targets

**Status:** Backlog / planning
**Author:** uray@qyubit.io (drafted with Claude)
**Date:** 2026-05-09
**Prior work:** `core/ArcheType.ts` split — commit `a886b45`, merged to `staging` (`fd75f21`).

---

## 1. Purpose

After `ArcheType.ts` was split (3064 → 1032 LOC across 8 modules under `core/archetype/`), several other files in `core/` remain large and concern-dense. This RFC enumerates them in priority order so future refactor work has a reference.

This is a **planning document**, not an approval-bound RFC. Each target listed here would get its own scoped RFC (like `RFC_APP_REFACTOR.md`) before work starts.

## 2. Selection Criteria

Files are ordered by combined score of:

1. **Size** (LOC) — bigger = harder to read, harder to test.
2. **Concern density** — number of distinct responsibilities mixed in one class/module.
3. **Blast radius** — how many tests/consumers depend on the file booting cleanly.
4. **Refactor ROI** — likelihood that splitting yields independently testable modules without behavior change.

Pure "library leaf" files (formatter helpers, fixed schemas) are excluded even when large, because splitting them wouldn't reveal new structure.

## 3. Targets

### 3.1 `core/App.ts` — 1477 LOC — **highest priority**

**Why next:** Most God-class. Mixes:

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
- Prepared-statement cache warm-up.

`init()` is a giant `switch (phase)` (lines 198–476) where each case runs 30–80 LOC of business logic. `handleRequest()` is ~430 LOC across 8+ branches.

**Detailed plan:** see `RFC_APP_REFACTOR.md` (drafted, awaiting approval).

**Status:** RFC drafted, not started.

---

### 3.2 `core/Entity.ts` — 1212 LOC

**Why next:** `save()` alone likely 300+ LOC. Cache ops inline. Mixes:

- Component add/get/remove (in-memory + persisted).
- DB persistence (insert/update/delete with abort signal + per-component partitioned writes).
- Cache write-through / write-invalidate strategies (L1 + L2 + pubsub).
- Hook dispatch (pre-save, post-save, post-delete) via `EntityHookManager`.
- Pending side-effects queue (`Entity.pendingCacheOps`, `Entity.pendingSideEffects` static drain methods for shutdown).
- Profile timing (`DB_SAVE_PROFILE`).
- Abort signal handling (timeout + client disconnect cancellation).
- Component-ready preflight (`ComponentRegistry.getReadyPromise`).
- Static finders (`FindById`, etc.).

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

**Status:** Not started.

---

### 3.3 `core/SchedulerManager.ts` — 932 LOC

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

**Risks:**

- Concurrency hardening already done in v0.3.0 (H-SCHED-1..5). Refactor must preserve every guard. Property-based tests on the runner would help.
- Re-entry semantics on `DistributedLock` (memory: `acquired:false` on overlap). Don't change.

**Status:** Not started.

---

### 3.4 `core/EntityHookManager.ts` — 921 LOC

**Why next:** Hook registry + dispatch + lifecycle in one place.

Concerns:

- Hook registration (per-component, per-event).
- Dispatch ordering (pre vs post, sync vs async).
- Hook chain with timer leak fixes (memory: H-HOOK-2, H-MEM-2).
- Re-entry / recursion guard.
- Integration with `Entity.save()` post-commit microtask scheduling.

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

### 3.5 `core/cache/CacheManager.ts` — 574 LOC

**Why next:** L1 (memory) + L2 (Redis) + strategies + pub/sub all-in-one. Already smaller than peers, so lower priority.

Concerns:

- Provider initialization (memory + Redis).
- Strategy dispatch (write-through vs write-invalidate).
- Cross-instance invalidation via Redis pub/sub (`instanceId` loop prevention).
- Cache stats / health (`ping`, `getStats`).
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

All five targets are exercised by the current 770-test suite (under `bun run test:pglite`). No target requires new test scaffolding before extraction starts; existing tests are sufficient guardrails for behavior preservation.

### 4.3 No DI introduction

Project rule (per `CLAUDE.md` and `MEMORY.md`): singletons + global exports, no dependency injection container. Extracted modules must respect this — pass `app: App`, `entity: Entity`, etc., not an injection token.

### 4.4 No bundled bug fixes

If a refactor reveals a latent bug (wrong ordering, missing guard, stale comment claim), file it separately. Refactor PRs must show "no behavior change" by passing the existing test suite unchanged.

## 5. Recommended Order

1. **`App.ts`** — RFC drafted, ready to start. Highest payoff: every test boots through it.
2. **`Entity.ts`** — Highest perf sensitivity but biggest readability win. Allocate benchmark time.
3. **`SchedulerManager.ts`** *or* **`EntityHookManager.ts`** — Either next. They're partially coupled (hooks fire from scheduler-triggered work), so coordinate.
4. **`CacheManager.ts`** — Last. Smallest of the five, already structured around providers.

This ordering minimizes risk because the most heavily-tested file goes first (more guardrails) and the perf-sensitive file goes early-second when there's still energy for benchmarking.

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
