# Changelog

All notable changes to bunsane are documented here.

## 0.5.2 — 2026-06-19

### Added

- **`withLock(key, fn, options?)`** — public distributed-lock primitive,
  exported from `bunsane/core`. Runs `fn` while holding a PostgreSQL advisory
  lock and always releases it (even if `fn` throws); only one holder of a given
  `key` runs `fn` at a time across every process pointed at the same database.
  Returns `{ acquired: true, result }`, or `{ acquired: false }` when the lock
  is held elsewhere (`fn` does not run). Wraps the same `DistributedLock`
  singleton and PostgreSQL session the scheduler uses for task exclusion, now
  surfaced for app-level "run once cluster-wide" work — reindex, migration,
  cache rebuild. `options.wait` (ms, default `0` = try once) blocks for the lock
  instead of skipping; `options.retryInterval` (default 100 ms) sets the poll
  cadence. Layers an in-process guard over the advisory lock because PostgreSQL
  advisory locks are reentrant per session — without it, two concurrent
  same-key callers in one process would both win. Not reentrant; crash-safe
  (session-scoped); honors `distributedLocking: false` (then always reports
  `acquired: true` with no real lock). Also re-exported from
  `bunsane/core/scheduler`. A new `core/index.ts` barrel establishes
  `bunsane/core` as a public entry point.

## 0.5.1 — 2026-06-16

### Added

- **Transaction-aware cache invalidation** — component writes made via
  `comp.save(trx, id)` inside the new `transaction()` wrapper now bust the
  component cache on commit, using the same
  `CacheManager.invalidateEntityComponents` path (L1 + L2 + cross-instance
  pub/sub) that `Entity.save` uses. Touched `(entityId, typeId)` pairs are
  tracked automatically (keyed by the transaction handle), then flushed after
  the transaction commits. The `tx` context also exposes `tx.markDirty(entityId,
  component)` for components not saved directly and `tx.onCommit(cb)` for
  post-commit side effects. Exported from `bunsane/core/cache` as `transaction`,
  `txMarkDirty`, `txOnCommit`. No behavior change for `comp.save` outside the
  wrapper — tracking is a no-op there.
- **`ArcheTypeQuery.select(...fields)`** — opt-in projection for archetype
  queries. Loads data only for the selected component fields instead of every
  component in the archetype, cutting JSONB wire + parse cost for wide
  archetypes read with narrow selections. Membership filtering is unaffected
  (matching still requires all components); unselected fields remain
  lazy-loadable. Backward-compatible — without `select()`, all components load as
  before.

### Fixed

- **RedisCache test connects on `127.0.0.1`** instead of `localhost`, which
  resolves to IPv6 `::1` first on Windows and times out against an IPv4-only
  Redis. Test-only change.

## 0.5.0 — 2026-06-15

### Added

- **`/health` write probe** — the deep health check now exercises a real write
  through the same `db.transaction()` path `Entity.save` uses (a temp-table
  insert dropped on commit, no persistent side effect), instead of a read-only
  `SELECT 1`. A wedged write pool — one where reads stay healthy but writes hang
  — now fails liveness so orchestrators restart the container instead of it
  serving timeouts indefinitely. Configurable via `HEALTH_DB_WRITE_PROBE`
  (default on) and `DB_HEALTH_WRITE_TIMEOUT` (default 5000 ms). When the probe
  fails or times out, `/health` returns 503.
- **`DB_DISABLE_PREPARE`** — set to `true` to disable Bun SQL's automatic
  server-side prepared statements (`prepare: false`). **Required behind PgBouncer
  in transaction pooling mode**, where per-connection prepared statements break
  across pooled backends and can wedge the write path. Default behavior is
  unchanged (prepared statements remain on).
- **`docs/CONFIGURATION.md`** — full environment-variable reference, including a
  PgBouncer deployment section and the health-check/liveness guidance above.

### Behavior change

- `/health` now performs a database write by default. If you point a liveness
  probe at `/health`, ensure the write path is reachable, or set
  `HEALTH_DB_WRITE_PROBE=false` to keep the previous read-only behavior.

## 0.4.0 — 2026-06-11

### Performance (2026-06-10 overhaul)

- **ALS request scope** (`core/requestScope.ts`) — bare `entity.get()` calls inside
  `@ArcheTypeFunction`, `Unwrap`, and `populateRelations` are now batched
  automatically per request.
- **Sort-driven scan** for multi-component `sortBy` queries — LIMIT pushdown into
  the sort component scan (excluded for OR filters and cursor pagination).
- **`Query.count()` fixes** — no longer capped by `BUNSANE_DEFAULT_QUERY_LIMIT`;
  missing builder reset fixed.
- **`populate()` warms the component cache** (≤1000 components per query).
- **O(1) MemoryCache LRU** eviction.
- **Batched write-through** — 2 cache round-trips per `entity.save()` regardless of
  component count.
- **Framework `PreparedStatementCache` removed from the query hot path** — Bun SQL
  auto-prepares. `Query.noCache()` with no arguments is now a no-op; use
  `noCache({ component: true })` to bypass the component cache.
- **Default pool size 10 → 20** (`POSTGRES_MAX_CONNECTIONS`).
- **New `'fulltext'` index type** for `@IndexedField` (tsvector GIN).

### Internal refactors

- `core/Entity.ts` split into `core/entity/` submodules (pendingOps,
  componentAccess, saveEntity, finders). Public API and import paths unchanged.
- Package now publishes with a `files` whitelist — tests, internal docs, and tooling
  configs no longer ship to npm; `studio/dist` is now included so `enableStudio()`
  works from the published package (run `bun run build` before `npm publish`).

### BREAKING — v0.4.0

- **`entity_components` table is no longer written or created by the framework.**
  `components` (via `UNIQUE(entity_id, type_id)`) is now the single source of
  entity↔component membership. The `entity_components` table receives no further
  INSERTs, UPDATEs, or DELETEs on any save, delete, or soft-delete path.

  **Impact on consumers:**
  - Any application querying `entity_components` directly (e.g. raw `db.unsafe`
    calls, external analytics, custom reports) must migrate those queries to
    `components` — see the inventory in `docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md`.
  - Orphaned `entity_components` tables in upgraded databases can be dropped
    manually after verifying the upgrade succeeded:
    ```sql
    DROP TABLE entity_components;
    ```
    The framework emits a one-time info log at startup when the orphaned table is
    detected, directing the operator to drop it.
  - Databases with pre-dual-write history (written before Phase 1 of this plan)
    or with external writers to `entity_components` may have membership records
    that differ from `components`. Reconcile those differences before upgrading
    by running a diff query (`SELECT entity_id, type_id FROM entity_components
    EXCEPT SELECT entity_id, type_id FROM components`).

  **Emergency rollback:** `BUNSANE_MEMBERSHIP_SOURCE=legacy` re-routes all
  membership reads to `entity_components`. However this only works if the table
  is populated. After Phase 3, that requires a manual backfill:
  1. `CreateEntityComponentTable()` — recreates the DDL.
  2. `PopulateComponentIds()` — backfills rows from `components`.

  Both functions are exported from `database/DatabaseHelper.ts`.

### Fixed

- **`UploadManager` no longer registers default providers asynchronously
  (BUNSANE-007).** The constructor previously called an `async`
  `initializeDefaultProviders()` that suspended on
  `await localProvider.initialize()`, so the default `"local"` provider
  was registered in a *later* microtask — after any consumer's
  synchronous `registerStorageProvider("local", custom)` override — and
  silently clobbered it. Result: uploads via `"local"` always wrote to
  the default `./public` regardless of a custom `basePath`/`UPLOAD_ROOT`
  provider. Default registration is now fully synchronous, and
  `LocalStorageProvider` creates its base directory in its constructor
  (`initialize()` retained as an idempotent no-op for the
  `StorageProvider` contract and S3 parity). A custom `"local"` provider
  registered immediately after `getInstance()` now survives.

### Added (v0.3.2 — AbortSignal propagation + DB observability)

- **AbortSignal threading into `Query.exec` + DataLoaders.** Resolvers
  invoked from a GraphQL request now receive the request's `AbortSignal`
  via the request-context plugin. When the framework's 30s wall-clock
  fires (`core/app/requestRouter.ts`), in-flight `db.unsafe()` queries
  are cancelled through Bun's `SQL.Query.cancel()`. Without this an
  aborted request leaked its backend connection into
  `idle in transaction` under pgbouncer transaction-mode pooling,
  cascading into pool starvation under sustained timeout pressure.
  Public surface: `Query.exec({ signal })`, `Query.count({ signal })`,
  `Query.estimatedCount(component, { signal })`,
  `Query.findOneById(id, { signal })`,
  `Query.explainAnalyze(buffers, { signal })`,
  `createRequestLoaders(db, cache?, signal?, perRequest?)`.
  Reuses helper `runWithSignal` extracted to `database/cancellable.ts`
  and shared with the existing `Entity.doSave` / `Entity.doDelete`
  abort paths.

- **DB roundtrip observability (`database/instrumentedDb.ts`).** Every
  `db.unsafe()` callsite in `Query.ts`, `RequestLoaders.ts` and the
  shared `PreparedStatementCache.execute` now routes through
  `timedUnsafe`. Tracks `totalCount`, `totalMs`, `maxMs`, `avgMs`,
  `slowCount`, `abortedCount`, `inFlightMax`, plus per-DataLoader-kind
  counters. Exposed at `/metrics` under the new `db` key. Calls over
  `BUNSANE_DB_SLOW_MS` (default 500ms, set 0 to disable warn) log a
  structured `Slow DB call` warning with a SQL snippet.

- **Per-request stats on access + timeout logs.** GraphQL request
  context now captures `operationName`, `dataLoaderCalls`
  (entity / component / relation), and `dbQueryCount`. These attach to
  the underlying `Request` via `__bunsaneStats` so the HTTP router's
  catch block and `AccessLog` middleware can include them in every
  log line. The previous `Request failed after 30004ms: POST /graphql`
  log now carries enough fields to identify the offending operation
  without re-running production with a debug build. Timeout warn log
  also includes operation name when reachable.

### Env vars added

- `BUNSANE_DB_SLOW_MS` (default `500`) — per-call DB threshold for
  slow log + `slowCount` metric. Set `0` to suppress the warn (stats
  still accumulate).

### Backward compatibility

All additions are opt-in. Existing apps see no behavior change:
`Query.exec()`, `Query.count()`, `createRequestLoaders(db, cache)`,
and `preparedStatementCache.execute(s, p, db)` retain their pre-0.3.2
signatures. `/metrics` gains a `db` key (pure addition). Log lines
gain fields but preserve existing ones.

### Added (HR-Screening ticket batch — BUNSANE-002..006)

- **`@ScheduledTask` allows entity-less time-based tasks.** Previously
  `SchedulerManager.registerTask` rejected tasks without `query` or
  `componentTarget`, contradicting documented "runs every hour" examples.
  Time-based tasks now register successfully and invoke the handler with
  no entity argument on each tick. Existing entity-targeted tasks
  unchanged. Ticket BUNSANE-002.

- **`Entity.requireComponents(ctors)` hydrator.** Batched-load helper
  that ensures the given component constructors are present on the
  in-memory `componentList`. Required before `set` / `save` flows that
  may trigger `@ComponentTargetHook` — hook matching reads
  `componentList()` (in-memory only), so tag components must be loaded
  first for the hook to fire. Ticket BUNSANE-003.

- **`ServiceRegistry` class named-exported.** `service/ServiceRegistry.ts`
  now exports the class as named alongside the existing default-instance
  export. Available via `service/index.ts` as `ServiceRegistryClass` for
  type/subclass use; existing `ServiceRegistry` import remains the
  singleton instance for backward compatibility. Ticket BUNSANE-004.

- **`CacheManager.invalidateEntities(ids: string[])`.** Batched helper
  that invalidates both the entity-existence cache and all component
  caches for a list of IDs. Call after a raw-SQL write (`db.unsafe`)
  that bypasses `Entity.set` / `Entity.save`. Ticket BUNSANE-005.

- **`Entity.reload(opts?)` refresher.** Discards in-memory component
  state and re-hydrates from the `components` table. Preserves entity
  identity — callers holding a reference see fresh data on the same
  instance. Use after raw-SQL writes or when a sibling `Entity`
  instance with the same id mutated persisted data. Ticket BUNSANE-006.

- **Empty-string filter values supported.** `Query.filter(field, op, '')`
  and the downstream SQL emit path (`ComponentInclusionNode`,
  `PreparedStatementCache.execute`, `Query.doExec` / `doCount` /
  `doAggregate` param validators) previously rejected empty /
  whitespace-only values with "would cause PostgreSQL UUID parsing errors".
  JSONB text extraction (`c.data->>'field'`) returns text, so `= ''` /
  `!= ''` / `LIKE ''` are legitimate for text fields. The UUID-cast path
  is gated by a value-side regex that an empty string cannot match, so
  unsafe casts never fire. `findById('')` still throws — entity IDs
  remain UUID-typed.

- **`Entity.drainPendingSideEffects(timeoutMs)`.** Drainable tracking
  for post-commit work scheduled via `queueMicrotask` from `save()`
  (cache invalidation + lifecycle hooks). Wired into `App.shutdown`
  after `drainPendingCacheOps`. Tests under PGlite can call this in
  `beforeAll` to settle prior-file background work before asserting.
  Partial mitigation for BUNSANE-001 (Bun SQL / PGlite visibility race
  — see `CLAUDE.md` PGlite section for full context).

### Fixed (PR E — outbox, cache, query hardening)

- **OutboxWorker publishes to Redis concurrently and marks rows in bulk.**
  Previously `processBatch` awaited each `publisher.xadd` serially inside
  the PG transaction, holding `FOR UPDATE` row locks for up to N ×
  `commandTimeout` when Redis was slow. Now uses `Promise.allSettled` to
  publish the whole batch in parallel — worst-case lock hold drops to a
  single xadd timeout. Followed by a single bulk `UPDATE … WHERE id IN
  …` instead of N serial updates. Tickets H-DB-1 (partial — full fix
  needs claim-via-column redesign so Redis latency is outside the PG
  transaction entirely) and H-DB-3.

- **`Entity.save` pre-flights `ComponentRegistry.getReadyPromise` outside
  the transaction.** Previously `doSave` awaited registry readiness from
  inside `executeSave`, so a slow DDL (partition creation) would keep a PG
  transaction idle. Pre-flight loop in `save()` awaits readiness before
  opening the transaction; `doSave` now only asserts readiness and throws
  if a caller bypassed `save()`. Ticket H-DB-4.

- **Entity.set / Entity.remove fire-and-forget cache ops now drainable on
  shutdown.** Previously `setImmediate(async () => { … })` was untracked,
  so SIGTERM could abandon in-flight cache writes. `Entity.pendingCacheOps`
  is a drainable `Set<Promise<void>>`, and `Entity.drainPendingCacheOps`
  is awaited by `App.shutdown` between HTTP drain and cache disconnect.
  Ticket H-CACHE-1.

- **`CacheManager.shutdownProvider` descends into `MultiLevelCache` layers.**
  Previously only checked the top-level provider for `disconnect` /
  `stopCleanup` methods, so a MultiLevelCache deployment left its inner
  MemoryCache cleanup timer and Redis connection alive forever. Now
  dispatches to `getL1Cache()` and `getL2Cache()` when available. Ticket
  H-CACHE-2.

- **`setComponentWriteThrough` preserves `createdAt` across updates.**
  Previously every write-through stamped `createdAt: new Date()`,
  corrupting the timeline across consecutive updates. Now peeks the
  existing cache entry and preserves its `createdAt` when present; only
  `updatedAt` is stamped fresh. Full fix (BaseComponent tracking
  timestamps natively) deferred. Ticket H-CACHE-3.

- **Default query limit applied when `.take()` is omitted.** `Query.exec()`
  now applies a framework-level default LIMIT
  (env `BUNSANE_DEFAULT_QUERY_LIMIT`, default 10000, 0 to disable) and
  emits a warning so runaway queries are visible. Ticket H-QUERY-1.

- **OrNode debug `console.log` traces removed from the production path.**
  Ticket H-QUERY-2.

- **`unregisterDecoratedHooks` now actually unregisters.** Previously a
  no-op stub that warned to stderr. Hook IDs returned from each
  registration are stored in a `WeakMap<instance, string[]>` and passed
  to `EntityHookManager.removeHook` on tear-down. Enables per-instance
  cleanup in tests and service destruction. Ticket H-HOOK-3.

### Fixed (PR D — scheduler + hook concurrency hardening)

- **Entity.add / Entity.set / Entity.remove hook calls no longer leak
  unhandled rejections.** `EntityHookManager.executeHooks` is async, but
  the three mutating methods previously invoked it without `await` and the
  surrounding `try/catch` captured only synchronous throws. A hook
  declared `async` that rejected escaped as an unhandled rejection. `set`
  now `await`s consistently; `add` and `remove` remain synchronous (to
  preserve their fluent-chain / boolean signatures) and attach a
  `.catch` to the returned promise so rejections are logged rather than
  escaping. Ticket H-HOOK-1.

- **Hook timeout timers no longer leak and late rejections no longer
  escape.** All four timeout race sites in `EntityHookManager` (sync path,
  async-parallel path, sync-batch path, async-batch path) now capture the
  `setTimeout` handle and `clearTimeout` on normal completion, and
  attach a detached `.catch` to the hook callback promise so a rejection
  that arrives after the race has been decided is logged rather than
  emitted as an unhandled rejection. Tickets H-HOOK-2 / H-MEM-2.

- **SchedulerManager task interval no longer burns lock attempts for a
  still-running task.** `doExecuteTask` now skips early if
  `taskInfo.isRunning` is true, avoiding a wasted PG advisory-lock
  round-trip every tick when execution outlasts the interval. Increments
  `skippedExecutions`. Ticket H-SCHED-1.

- **Scheduled-task retry timer is now tracked and cleared on stop.**
  `handleTaskFailure` previously scheduled retries with a bare
  `setTimeout` whose handle was never stored, so `stop()` could not
  clear it and the retry fired post-shutdown against a closed DB pool.
  The retry handle is now registered in `intervals` under
  `<taskId>:retry:<n>` and self-deletes once fired. The retry callback
  also checks `isRunning` before executing. Tickets H-SCHED-2 /
  H-SCHED-3.

- **DistributedLock re-entry now reports overlap instead of success.**
  `tryAcquire` previously returned `acquired: true` when the instance
  already held the lock for `taskId`, which meant retry + interval could
  both enter `executeTask` concurrently. Now returns
  `acquired: false` so the second caller skips — defense-in-depth on
  top of the caller-side `isRunning` guard. Ticket H-SCHED-4.

- **`executeWithTimeout` no longer leaks late rejections.** A scheduled
  task that rejects after its wrapper timed out previously produced an
  unhandled rejection (the wrapper was already settled). The wrapper now
  uses a `settled` flag and logs late rejections instead of propagating.
  Ticket H-SCHED-5.

- **DistributedLock `reservePromise` nulls on reject.** Previously, if
  `db.reserve()` rejected (pool exhausted, shutdown mid-call), the
  rejected promise was cached in `reservePromise` forever and every
  subsequent `ensureReserved` received the same rejection. Now nulls the
  promise in the reject handler so future callers retry a fresh reserve.
  Ticket H-DB-2.

- **`App.waitForAppReady` no longer polls indefinitely.** Replaced the
  100ms `setInterval` with a one-shot phase listener and default 60s
  timeout. A boot failure that never reaches `APPLICATION_READY` now
  surfaces as a rejection instead of leaking a timer for process
  lifetime. Ticket H-MEM-1.

### Security

- **SQL injection hardening across Query layer.** Identifiers (component
  table names, JSON field paths, ORDER BY properties, text-search language)
  interpolated into SQL via `db.unsafe(...)` or template literals are now
  validated against strict allow-lists before use. Added `query/SqlIdentifier.ts`
  with `assertIdentifier`, `assertComponentTableName`, `assertFieldPath`,
  `assertTsLanguage`. Applied at `Query.estimatedCount`, `Query.doAggregate`,
  `ComponentInclusionNode` sort expressions (3 sites), and
  `FullTextSearchBuilder` (3 sites + factory). Throws `InvalidIdentifierError`
  on unsafe input. Ticket C08.

- **GraphQL depth limit hard minimum enforced.** Previously `maxDepth: 0`
  or `undefined` silently disabled the depth-limit guard, allowing CPU/memory
  DoS via deeply nested queries. Now `createYogaInstance` enforces a hard
  floor of 15 regardless of input; callers can raise but cannot disable.
  Ticket C06.

- **Request AbortSignal now propagates into Yoga and REST handlers.** The
  30s wall-clock timer previously only logged a warning; the signal was
  never forwarded downstream. Request timeouts (and client disconnects) now
  cancel in-flight resolvers, DB queries, and external calls. Uses
  `AbortSignal.any` (Bun/Node 20+) with a manual combiner fallback.
  Ticket C05.

### Fixed

- **Sync lifecycle hooks now awaited, preventing unhandled rejections.**
  `EntityHookManager.executeHooks` previously discarded the return value of
  `hook.callback(event)` on the sync path when no timeout was configured.
  A hook mistakenly declared `async: false` but implemented as an
  `async function` would silently throw unhandled rejections, crashing the
  process under strict mode. Sync path now awaits consistently. Ticket C13.

- **`createRequestContextPlugin` auto-applied by default.** Previously
  opt-in (and the export was commented out of the root barrel), so any app
  using `@BelongsTo` / `@HasMany` relations silently fell into N+1 query
  patterns. `App` now prepends the plugin to Yoga plugins by default. Opt
  out via `App.disableRequestContextPlugin()` if supplying your own
  DataLoader layer. Ticket C07.

- **Redis cache no longer causes unbounded heap growth when Redis is
  unreachable.** `enableOfflineQueue` now defaults to `false` so commands
  fail fast and the caller's `try/catch` treats it as a cache miss instead
  of queuing indefinitely. Can be overridden per-deployment via
  `REDIS_ENABLE_OFFLINE_QUEUE=true` when you accept the memory risk.
  Ticket C02.

- **Redis reconnect storm capped.** `retryStrategy` now returns `null`
  after `maxReconnectAttempts` (default 20) so a permanently unreachable
  Redis cannot spin forever, saturating logs and keeping the ioredis
  state machine busy. Configurable via `REDIS_MAX_RECONNECT_ATTEMPTS`.
  Default inter-attempt delay also raised from `times * 50` to
  `times * 200` (capped at 2s) for a gentler back-off. Ticket C03.

- **`App.init()` now awaits `CacheManager.initialize()`.** Previously only
  `getInstance()` was called so pub/sub cross-instance invalidation was
  never set up and any app-supplied cache config was silently ignored.
  Added `App.setCacheConfig(config)` so callers can supply a partial
  config that is merged with `defaultCacheConfig` and passed to
  `initialize()`. Ticket C04.

- **`Entity.doDelete` no longer leaks `idle in transaction` backends on timeout.**
  Same AbortController + in-flight query cancellation pattern as `Entity.save`.
  Post-commit cache invalidation and lifecycle hooks moved out of the save
  budget via `queueMicrotask`. Ticket C01.

- **`SYSTEM_READY` phase errors are no longer swallowed silently.**
  Previously a schema-build, REST-registration, or scheduler-init failure was
  caught and only logged, leaving the app stuck at `isReady=false` with
  `/health/ready` returning 503 forever and k8s rollouts blocked indefinitely.
  Now marks the app unready, logs at fatal level, and exits so the orchestrator
  can restart. In tests, rethrows instead of exiting. Ticket C09.

- **HTTP server drain is now awaited before tearing down dependencies.**
  `server.stop(false)` previously initiated drain but was not awaited, so the
  scheduler / cache / DB pool closed while requests were still executing,
  causing cascade failures in the final seconds of shutdown. Shutdown now
  polls pending requests (bounded by `shutdownGracePeriod`) before force-close,
  then stops each subsystem in order. Ticket C10.

- **ApplicationLifecycle phase listeners are now captured and removed on
  shutdown.** Five singletons (`App`, `EntityManager`, `EntityHookManager`,
  `SchedulerManager`, `ServiceRegistry`) previously registered listeners
  without storing refs, so each `init()` call (common in tests) stacked
  listeners on the singleton `EventTarget`, permanently leaking memory and
  firing duplicate phase handlers. Each now captures the listener reference
  and exposes a `dispose()` / `disposeLifecycleIntegration()` method called
  from `App.shutdown()`. `init()` paths are also idempotent. Ticket C11.

- **`ApplicationLifecycle.waitForPhase` replaced 100ms busy-loop with a
  listener-based Promise.** Previously a `while (currentPhase !== phase)`
  loop polling every 100ms; if the target phase was never reached (see
  SYSTEM_READY fix above) every caller hung forever. Now attaches a one-shot
  phase listener + `timeoutMs` (default 30s). Rejects with a descriptive
  error on timeout. Ticket C12.

- **`SchedulerManager.stop()` now awaits in-flight tasks before returning.**
  Previously cleared timers and returned immediately; any task mid-execution
  continued running against a DB pool that was about to close in
  `App.shutdown()`. Now tracks each `executeTask` promise in a Set, and
  `stop(drainTimeoutMs = 15_000)` awaits `Promise.allSettled` bounded by the
  timeout. Scheduler listener also disposed. Ticket C14.

- **Process-level error handlers (`unhandledRejection`, `uncaughtException`)
  and signal handlers (`SIGTERM`, `SIGINT`) now registered at the top of
  `App.init()` instead of only in `start()`.** Previously any rejection
  during boot (DB prep, component registration, cache init) was silently
  discarded by the runtime. Signal handlers now use `process.once` so a
  double SIGTERM cannot fire two concurrent shutdown paths. Ticket C15.

- **`Entity.save` no longer leaks `idle in transaction` backends on timeout.**
  The previous implementation wrapped `db.transaction(...)` in a JS `setTimeout`
  and rejected the outer promise when the timer fired, but the underlying Bun
  SQL transaction continued on the server with no `COMMIT`/`ROLLBACK` ever
  sent. Under pgbouncer `transaction` pool mode this pinned backend sessions
  permanently, exhausting the pool and cascading into further save timeouts.

  `Entity.save` now threads an `AbortSignal` into `doSave`. When the wall-clock
  timer fires the signal is aborted, the in-flight `SQL.Query` is cancelled
  via `.cancel()`, and the cancellation propagates out of the transaction
  callback, triggering Bun SQL's automatic `ROLLBACK` and releasing the
  pooled connection. The `DB_STATEMENT_TIMEOUT` env var (already supported
  in `database/index.ts`) acts as a PostgreSQL-side backstop.

  See `docs` / handoff dated 2026-04-18 for incident details.

### Changed

- **Post-commit side effects (cache invalidation, lifecycle hooks) no longer
  block `Entity.save`.** `handleCacheAfterSave` and `EntityHookManager.executeHooks`
  are now queued via `queueMicrotask` after the transaction commits. Save
  resolves as soon as the DB write is durable; cache or hook latency cannot
  consume the save budget or surface as save failures. Errors are logged
  and swallowed (matching prior error-handling behavior).

### Added

- **`DB_SAVE_PROFILE=true` env var** — when set, `Entity.save` logs per-phase
  timings (`db`, `cache`, `hooks`, `total`) at info level. Off by default.

- **Integration tests** in `tests/integration/entity/Entity.saveTimeout.test.ts`
  covering: aborted save leaves no partial rows, pool stays healthy after
  repeated aborts, backwards-compatible signal-less `doSave`, non-blocking
  post-commit work.
