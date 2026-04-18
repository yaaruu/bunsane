# Changelog

All notable changes to bunsane are documented here.

## Unreleased

### Fixed

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
