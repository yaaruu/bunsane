# Changelog

All notable changes to bunsane are documented here.

## Unreleased

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
