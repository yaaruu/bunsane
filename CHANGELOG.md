# Changelog

All notable changes to bunsane are documented here.

## Unreleased

### Fixed

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
