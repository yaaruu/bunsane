# Changelog

All notable changes to bunsane are documented here.

## Unreleased

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
