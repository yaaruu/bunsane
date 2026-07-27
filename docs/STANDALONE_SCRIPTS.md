# Standalone scripts (migrations, backfills, heals, cleanups)

**Yes — `bun scripts/<x>.ts` against a live database is a supported execution
mode.** Running one-off maintenance outside the HTTP process is expected. This
page states what such a script gets, what it does not, and what it must do
before exiting.

## Bootstrap

```ts
import 'reflect-metadata';
import db from 'bunsane/database';                     // or: import { getDb } from 'bunsane/database'
import { Entity } from 'bunsane';
import { ComponentRegistry } from 'bunsane/core/components';   // singleton instance
import './components';                                 // import the @Component classes you touch

// Registers type ids and (with the default `list` strategy) component partitions.
await ComponentRegistry.registerAllComponents();
```

There is no lifecycle phase to emit and no `App.init()` to run. The DB
connection is created lazily on first use.

Historically `Entity.delete()` was the exception: `EntityManager.deleteEntity`
gated on a `DATABASE_READY` lifecycle phase that a script never emits, so
deletes resolved `false`, wrote nothing, and logged nothing — while
`Entity.save()` in the same script worked, because it bypasses `EntityManager`.
That gate is gone. `delete()` now returns `false` only for an unpersisted
entity; a database failure throws.

## What a script does NOT get

| Not started | Consequence |
|---|---|
| GraphQL/HTTP server, middleware, request context | No per-request DataLoader batching — `entity.get()` is one query per call. Prefer `Query…populate()`. |
| Scheduler, reconcile sweep, projection poll | `ProjectionManager` is not polling; if `BUNSANE_QSP` is on, the dual-write still runs on save/delete because it lives in the write path. |
| Cache manager (unless you `await CacheManager.initialize(...)`) | Writes bypass the cache instead of invalidating it — see below. |
| DB admission (`database/gateway.ts`) | Inert. `App.init()` arms it after migrations; a script never runs that path, so framework queries are unbounded in concurrency. That matches the pre-gateway behaviour, and it is usually what a one-off wants. For a bulk backfill sharing a database with a live service, arm it deliberately: `import { armGateway } from 'bunsane/database/gateway'; armGateway();` — then the script's own concurrency is bounded and `lane: 'background'` work cannot occupy the whole pool. Check `getGatewayStats().armed` if unsure which mode you are in — `unarmedCalls` counts how many queries have already gone through unbounded, and a long-lived process that never arms logs a warning once it is a minute past start. |
| Signal handlers / graceful shutdown | You own process exit. |

## Before you exit

Post-commit side effects (lifecycle hooks, cache invalidation) are
fire-and-forget on both the save and the delete path. If the process exits
first, the write-through cache can keep serving rows the script already
deleted. Drain instead of sleeping:

```ts
await Entity.drainPendingSideEffects(5_000);
await Entity.drainPendingCacheOps(5_000);
process.exit(0);
```

`drainPendingSideEffects` covers deletes as well as saves. `Bun.sleep(2000)`
before exit is a guess; the drain is a guarantee.

## Locks

`withLock()` works in a script and uses the same `postgres` lease backend as the
server, so a script and the API will not run the same critical section
concurrently. Keep script-held locks inside `leaseTtlMs` (default 30 s) or rely
on `withLock`'s heartbeat, which renews while your function runs.

## Verify what you wrote

A maintenance script should assert its own effect rather than trusting a return
value — count the rows it claims to have changed and print the count. Framework
write APIs throw on failure; they do not report success while writing nothing.
