# Configuration

BunSane is configured through environment variables (and a handful of
`app.*()` setters). This document is the reference for every environment
variable the framework reads, grouped by subsystem. Defaults are taken
directly from the source.

> **Validation:** `core/validateEnv.ts` validates a subset of these on startup
> (numeric/enum formats, required DB connection). Invalid values throw before
> the server binds.

---

## Database connection

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_CONNECTION_URL` | — | Full PostgreSQL connection string. **Overrides** the `POSTGRES_*` fields below when set. |
| `POSTGRES_HOST` | — | DB host (required if no `DB_CONNECTION_URL`). |
| `POSTGRES_USER` | — | DB user (required if no `DB_CONNECTION_URL`). |
| `POSTGRES_PASSWORD` | — | DB password. |
| `POSTGRES_DB` | — | Database name (required if no `DB_CONNECTION_URL`). |
| `POSTGRES_PORT` | `5432` | DB port. |
| `POSTGRES_MAX_CONNECTIONS` | `20` | Connection pool size. |

A connection requires **either** `DB_CONNECTION_URL` **or**
`POSTGRES_HOST` + `POSTGRES_USER` + `POSTGRES_DB`.

## Database behavior & timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_QUERY_TIMEOUT` | `30000` (ms) | Client-side wall-clock timeout for `Query.exec/count/sum/average`, `Entity.save` and `Entity.doDelete`. It bounds **how long the caller waits**. It requests cancellation first, but that request never reaches Postgres — `query.cancel()` issues no CancelRequest, so the statement runs to natural completion and holds its slot for the full duration. Measured identically on a direct connection and through a pooler, so this is a driver property and session pooling does not change it (see [POOLING.md](./POOLING.md) B8a). The only effective bound on a statement is server-side `statement_timeout`. |
| `DB_REQUEST_TIMEOUT` | *(unset → `DB_QUERY_TIMEOUT`)* | Default budget for the **request** lane, in ms. Covers the wait for an admission permit AND the query. **This is the only setting that makes an overloaded seam shed rather than queue**, because no framework call site passes a per-call `timeoutMs` — every lane otherwise inherits the 30 s global. Measured on real PG 17 (20 concurrent 2 s statements, `admissionLimit = 3`): at **800 ms**, 17 of 20 were rejected before reaching the server and the database drained in **2.1 s**; at the 30 s default, **nothing** was rejected, all 20 executed, callers queued 4.3 s on average and **12.0 s** at worst, and drain took **14.1 s**. **Request-facing deployments should set this to a few seconds.** Left unset by default because shortening it changes which requests fail under load — a deployment's decision, not a patch release's. ⚠️ Because it covers the query too, this is **not** a queue-only knob: a value of `500` also kills any *admitted* query slower than 500 ms, with `DbStatementTimeoutError` rather than an admission rejection. Size it against your slowest legitimate request, not against your queue depth. It bounds the **caller**; reclaiming the pool **slot** is the server-side `statement_timeout`'s job (see B8a in [POOLING.md](./POOLING.md)) — different guarantees, and you want both. |
| `DB_BACKGROUND_TIMEOUT` | *(unset → `DB_QUERY_TIMEOUT`)* | Same, for the **background** lane (scheduler, outbox, projection backfill/reconcile). Exists so the request lane can be shortened without also killing background work that legitimately runs long on the same pool. There is deliberately no `DB_HEALTH_TIMEOUT`: the health lane is exempt from admission entirely, so such a knob would bound only the query and never the queue. |
| `DB_CONNECTION_TIMEOUT` | `30` (s) | Bun SQL's timeout when **establishing** a connection. When it fires, `ERR_POSTGRES_CONNECTION_TIMEOUT` is classified as capacity and answered with **503 + `Retry-After`** (`code: POOL_EXHAUSTED`), counted as `poolAcquireFailures` in `/metrics`. ⚠️ **It does NOT bound waiting for a busy pool** — measured on real PostgreSQL 17, both direct and through PgBouncer: with a 1 s setting a caller arriving at a full pool queued **4859 ms / 4879 ms** and then *succeeded*. Bun documents it as the *establishment* timeout, and that is exactly what it is. Framework admission (`database/gateway.ts`) is what bounds the wait; see `DB_REQUEST_TIMEOUT` for the part that sheds. Setting `5` is still reasonable as an establishment bound. The default stays 30 s because background work shares this pool. |
| `DB_POOL_IDLE_TIMEOUT` | `30` (**s**) | Close idle pooled connections after this long. Bun SQL pool timeouts are in **seconds**; a value above `86400` is rejected at boot as a ms/s mix-up. Use `0` for no limit. |
| `DB_POOL_MAX_LIFETIME` | `600` (**s**) | Retire a pooled connection after this long regardless of activity. Recycling is the only mechanism that ever retires a connection the driver still believes is usable — before 0.5.11 these two were passed as milliseconds, so nothing was ever recycled. Same `86400` guard; `0` for no limit. |
| `DB_POOL_SATURATION_READY_MS` | `3000` (ms, `0` disables) | How long the pool must stay continuously saturated (`inFlight >= poolMax`) before `/health/ready` fails with a `db_pool` check. Sheds traffic so the pool can drain; deliberately does **not** fail liveness, because a full pool is also what a legitimate burst looks like. |
| `BUNSANE_DB_ADMISSION` | `on` | Bounded concurrency in front of the pool (`database/gateway.ts`). Framework queries acquire a permit before running, so a saturated database queues **here**, against the caller's own deadline, instead of inside the driver where nothing is observable. `off` makes the gateway a pure passthrough. Admission engages only after boot migrations (`armGateway()` in `App.init`), so DDL and schema migration are never serialized behind a limit derived before the pool is warm — `/metrics.dbAdmission.armed` reports whether it is live. Lanes: `request` may use the whole limit, `background` (scheduler, outbox, projection backfill/reconcile) is capped at half so it cannot starve user traffic, and `health` is never admitted. |
| `DB_ADMISSION_HEADROOM` | `1` | How many pooled connections stay **outside** the admission limit (limit = `POSTGRES_MAX_CONNECTIONS` − headroom). The headroom is what the health lane and any not-yet-migrated call site draw on: if admitted work could occupy every connection, the liveness probe would queue behind it and fail, restarting a container that was merely busy. |
| `BUNSANE_PROBE_CANCEL` | `on` | Boot probe that measures whether aborting a statement actually stops it server-side, by running a ~150 ms `pg_sleep`, aborting it a quarter of the way through the framework's own `runWithSignal` path, and watching when the statement really ends. Costs ~150 ms of boot, once. Reports **error** when an ineffective cancel coincides with no server-side `statement_timeout` — the pair means nothing in the deployment can stop a slow query, which is the B8 outage precondition. Skipped under PGlite. `off` disables it; note that a skipped probe reports `null` (unproven), never "fine". |
| `BUNSANE_PROBE_CANCEL_SLEEP_MS` | `150` | Probe statement duration. Longer is more conclusive and costs more boot time; `runDoctor()` will use a longer value than boot does. Automatically shortened to stay under an effective `statement_timeout`, and skipped entirely below 80 ms, because a server bound that kills the probe's own statement looks exactly like a working cancel. |
| `BUNSANE_DB_SERVER_TIMEOUT` | `on` | Whether `dbTransaction` emits `SET LOCAL statement_timeout` from its deadline. This is the **only** bound that actually stops server-side work and returns the pool slot — a client-side abort sends no CancelRequest, so the statement runs to completion regardless ([POOLING.md](./POOLING.md) B8a). Costs one extra round trip — measured **+0.40 ms on a 3.0 ms entity save (13%)** — so it is on by default for transactions, where it is paid once for the whole write; bare statements are opt-in per call (`serverTimeout: true`, used by the studio endpoints and projection backfill/reconcile) because wrapping one costs +0.95 ms / 3.7×. Never applied to DDL (`CREATE INDEX CONCURRENTLY` cannot run in a transaction) or to a caller-supplied transaction handle (`SET LOCAL` is transaction-scoped, so it would outlive our savepoint and change yours). Skipped under PGlite. `off` reverts to client-side bounds only — a bisection switch, not a supported production setting. **Bare statements outside a transaction are still unbounded by this: that is what `ALTER ROLE <user> SET statement_timeout` is for.** |
| `DB_DDL_TIMEOUT` | `600000` (ms) | Budget for schema DDL — `CREATE INDEX [CONCURRENTLY]`, `ALTER TABLE`, projection table creation, `ANALYZE`. Separate from `DB_QUERY_TIMEOUT` because DDL is long-running **by design**: a concurrent index build on a large table routinely outlives 30 s. Giving DDL the query budget aborts the build, and per [POOLING.md](./POOLING.md) B8a the abort does not reach Postgres — so the index keeps building while the framework logs a failure and may retry against a table already being indexed. 10 minutes is a *bound*, not a target: it exists so a wedged DDL statement eventually releases its admission permit. |
| `BUNSANE_STUDIO_DB_TIMEOUT` | `15000` (ms) | Wall-clock budget for **one Studio request**, shared across every query it issues — not a per-query timeout. Studio handlers run in the `background` lane, so admin tooling cannot occupy the pool ahead of user traffic, and the budget covers waiting for capacity as well as running. A shared budget is what bounds handlers that issue a data-dependent number of statements (`/studio/archetypes/*` loops until it fills a page; `/studio/components` is one sample query per component name) — per-query timeouts would bound each statement and the request as a whole not at all. Capacity failures answer **503 + `Retry-After`**, not 500. |
| `BUNSANE_STUDIO_TOKEN` | unset | Bearer token for the Studio admin surface (SEC-01). Studio is **deny-by-default**: nothing under `/studio` is served until the app calls `app.enableStudio({ token })` (or sets this env var and calls `enableStudio()`). Minimum 16 characters; refusal to enable without one is logged at error. Requests must present the token as `Authorization: Bearer <token>` or `x-studio-token`. With studio disabled, every `/studio/*` path answers 404; with it enabled, bad credentials answer 401. Framework tables (`components`, `entities`, …) are excluded from both the listing and direct `/studio/api/table/<name>` access, and archetype-scoped deletes refuse entity ids that do not belong to the named archetype. |
| `BUNSANE_STUDIO_QUERY` | unset (off) | Opt-in for the ad-hoc SQL runner at `POST /studio/api/query` (SEC-02). Set `on`/`true` to enable; **anything else — including an unset value and any NODE_ENV — keeps the endpoint 404**. When enabled, every query is vetted as a single read-only statement (literal/comment-aware keyword blacklist covering SET/CALL/VACUUM/MERGE/…), wrapped so results are bounded server-side to 500 rows regardless of comments, and failures are returned as short classified messages rather than raw Postgres internals. Still subject to the studio bearer token when configured. |
| `rateLimit({ trustProxy })` | `false` | Rate-limiter option (SEC-05). The default key is the socket IP from `server.requestIP` (copied into middleware context by `App.start`). Client `X-Forwarded-For` / `X-Real-IP` headers key the bucket **only** when `trustProxy: true`. If the socket IP is unavailable and `trustProxy` is off, the limiter fails open (one warning) instead of sharing one `'anonymous'` bucket. |
| `setCors()` | — | CORS policy (SEC-04). `credentials: true` together with `origin: "*"` now **throws at configuration time** (previously warned, then reflected every request Origin — allowing credentialed cross-origin reads from anywhere). Defence in depth: even if such a config object is constructed directly, no `Access-Control-Allow-Origin` is emitted for it. List explicit origins instead. **Breaking change** for apps relying on the old reflected behaviour. |
| `BUNSANE_ABORT_MODE` | `cancel` | `cancel` (request cancellation on abort, then reject) or `off` (reject without touching the query). **Temporary** diagnostic switch for isolating whether `cancel()` is implicated in pooled connections that never return; will be removed. Note the two modes are now known to be equivalent from the server's side — `cancel()` issues no CancelRequest (POOLING.md B8a) — so this can only bisect client-side effects. |
| `DB_STATEMENT_TIMEOUT` | unset (opt-in, ms) | Server-side `statement_timeout` appended to the connection URL as the `options` startup parameter. Skipped under PGlite. **Inert behind PgBouncer**, which drops `options` — the boot probe logs at error when it did not stick. Behind a pooler use `ALTER ROLE … SET statement_timeout` instead. |
| `DB_DISABLE_PREPARE` | `false` | `true` disables Bun SQL's automatic server-side prepared statements (driver default is on). **Required behind PgBouncer in transaction pooling mode** — see [PgBouncer deployment](#pgbouncer-deployment) below. |
| `DB_SAVE_PROFILE` | `false` | `true` logs per-phase `Entity.save` timings (`db`, `cache`, `hooks`, `total`). |

### Automatic timestamptz migration

On startup `DatabaseHelper` runs an idempotent migration that converts any
`timestamp without time zone` columns on the base tables to `timestamptz`.
The affected columns are `created_at`, `updated_at`, and `deleted_at` on both
`entities` and `components`. Fresh databases created by this version already
use `TIMESTAMPTZ` DDL, so the migration is a no-op for them. Existing stored
values are interpreted as UTC — the framework only ever writes timestamps via
`NOW()` / `CURRENT_TIMESTAMP`, which follow the session timezone; UTC is the
correct assumption for any database run in UTC.

On the partitioned `components` table PostgreSQL propagates the type change to
every partition, which triggers a one-time table rewrite with a brief exclusive
lock per column altered. This is a one-time cost on the first boot after
upgrading from a build that used bare `timestamp`.

There is no env var to control this migration; it runs automatically and is
required for `Query.sortByCreatedAt()` / `Query.sortByUpdatedAt()` to produce
correct results. Those methods read `entities.created_at` / `entities.updated_at`
directly, and timezone-aware ordering is only possible when the columns are typed
`timestamptz`.

## Health checks

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_DB_WRITE_PROBE` | `true` (on) | Inside `deepHealthCheck`, run a real **write** probe through the same `db.transaction()` path `Entity.save` uses, so a wedged write pool fails liveness. Set `false` to fall back to read-only `SELECT 1`. `BUNSANE_HEALTH_PROBE=read` skips the write probe at the HTTP endpoints before this flag is consulted. |
| `DB_HEALTH_WRITE_TIMEOUT` | `5000` (ms) | Independent, short timeout for the write probe so a wedge is detected fast rather than blocking on the 30s request timeout. |
| `BUNSANE_HEALTH_PROBE` | `write` | `read` skips the DB write probe. Liveness still runs `SELECT 1` and the cache ping. Default stays `write`. |
| `BUNSANE_HEALTH_CACHE_MS` | `5000` | Cache TTL for `/health` and `/health/ready`. `0` disables the cache. Concurrent misses share one probe. |
| `BUNSANE_HEALTH_MAX_RPS` | `20` | Token bucket for `/health` and `/health/ready`. Excess returns 429 without a DB call. `0` disables the limiter. |

See [Liveness & the write probe](#liveness--the-write-probe).

## Application / HTTP

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `3000` | HTTP listen port. |
| `NODE_ENV` | unset | `development` \| `production` \| `test`. Unset is fail-closed: error details are masked, HSTS stays off, and `/metrics`, `/health/remote`, `/docs`, and `/openapi.json` answer 404 unless a token or explicit public opt-in is set. `development` enables verbose errors and, unless overridden, GraphQL introspection and GraphiQL. `production` alone does **not** send HSTS. A boot warning names the affected behaviours; `BUNSANE_STRICT_ENV` promotes it to a startup failure. |
| `SHUTDOWN_GRACE_PERIOD_MS` | framework default | Max time to drain in-flight requests on SIGTERM/SIGINT before forced shutdown. Also `app.setShutdownGracePeriod(ms)`. |
| `REQUEST_TIMEOUT_MS` | `30000` | Wall-clock request timeout in milliseconds. `0` disables. Also `app.setRequestTimeout(ms)` or `AppConfig.requestTimeoutMs`. `/health` and `/health/ready` never use this timer and are not cloned for it. |
| `JSON_BODY_LIMIT` | `1048576` (1MB) | Max `Content-Length` for non-multipart bodies. Oversize returns 413 before the body is read. Also `app.setJsonBodyLimit(bytes)` or `AppConfig.bodyLimits.json`. |
| `MULTIPART_BODY_LIMIT` | `MAX_REQUEST_BODY_SIZE` (50MB) | Multipart `Content-Length` cap. Also `app.setMultipartBodyLimit(bytes)` or `AppConfig.bodyLimits.multipart`. |
| `MAX_REQUEST_BODY_SIZE` | `52428800` (50MB) | Absolute `Bun.serve` cap and the default multipart cap. Does **not** raise the JSON limit. Also `app.setMaxRequestBodySize(bytes)` or `AppConfig.bodyLimits.max`. Chunked multipart with no `Content-Length` is still bounded only by this Bun cap. |
| `BUNSANE_METRICS_TOKEN` | unset | Bearer token, or `x-metrics-token`, for `/metrics` and `/health/remote`. Minimum 16 characters. Unset, and not public, answers 404. Also `app.setMetricsAccess({ token })`. |
| `BUNSANE_METRICS` | unset | `public` serves `/metrics` and `/health/remote` without a token. `off` is accepted by validation and does not open the endpoints. |
| `BUNSANE_DOCS_TOKEN` | unset | Bearer token, or `x-docs-token`, for `/docs`, `/docs/swagger-init.js`, and `/openapi.json`. Minimum 16 characters. Also `app.setDocsAccess({ token })`. |
| `BUNSANE_DOCS` | unset | `public` serves those docs routes without a token. `off` does not open them. |
| `BUNSANE_HSTS` | `off` | `on` sends `Strict-Transport-Security`. `NODE_ENV=production` alone does not. |
| `BUNSANE_TLS` | `off` | `on` also enables HSTS. This declares that the deployment is behind TLS; it does not terminate TLS. |
| `BUNSANE_STRICT_ENV` | `off` | `on` or `true` promotes boot warnings to a startup failure: unset `NODE_ENV`, production Redis without a password on a non-loopback host, and `REDIS_TLS=true` (validated but not applied by the client). |

`securityHeaders` and `requestId` are registered in `start()` unless opted out with `setSecurityHeaders(false)` / `setRequestId(false)`, or the matching `AppConfig` fields, before start. `app.use()` after `start()` throws. A second `start()` is a no-op (warning).

## GraphQL

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPHQL_MAX_DEPTH` | `15` | Max query depth. When set, an integer `>= 15` (`app.setGraphQLMaxDepth` / `AppConfig.graphql.maxDepth`). Below 15 throws. `0` does not disable. `graphqlSetup` passes the configured number through and rejects a non-integer or a value `< 1`. |
| `GRAPHQL_MAX_COMPLEXITY` | `1000` | Max query complexity. Integer `>= 1` (`app.setGraphQLMaxComplexity`). `0` does not disable. `first` / `limit` / `take` use coerced variables, not only literals. Per-operation alias cap is 50. Each `__` field costs 10. Fragment spreads are charged at each use site. |
| `GRAPHQL_INTROSPECTION` | unset | `on` or `off`. Unset follows `isVerboseErrors()` (only `NODE_ENV=development`). Also `app.setGraphQLIntrospection(boolean)` / `AppConfig.graphql.introspection`, which win over the env var. |
| `GRAPHQL_GRAPHIQL` | unset | `on` or `off`. Unset follows the same verbosity gate. Off: GraphiQL and the Yoga landing page are disabled; `GET /graphql` with `Accept: text/html` returns 404. Also `app.setGraphQLGraphiQL(boolean)`. |

## Distributed locking & scheduler

Controls the lock primitive behind `withLock()` and the scheduler's
single-execution gating. See [Locking & connection pooling](LOCKING.md) for the
full guide.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUNSANE_LOCK_BACKEND` | `auto` → `postgres` | Lock backend: `auto` \| `in-process` \| `postgres` \| `redis` \| `advisory`. `postgres` is a **pooler-safe lease table** (`bunsane_locks`) — the correct default behind PgBouncer transaction pooling. `in-process` = single instance only (no cross-process exclusion). `advisory` = legacy `pg_advisory_lock`; **only safe on a session-pinned connection** (see below). Also `scheduler.lockBackend`. |
| `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK` | `false` | `true` bypasses the first-use session-affinity probe that otherwise throws `UnsafeAdvisoryPoolingError` when the `advisory` backend is detected behind a transaction pooler. Override at your own risk — advisory locks strand silently there (BUNSANE-1). |

> **Default changed:** the lock backend is now the pooler-safe `postgres` lease.
> The old `pg_advisory_lock` primitive is opt-in (`advisory`) because it breaks
> silently behind a transaction pooler. Single-instance deploys may opt down to
> `in-process` to avoid the per-lock DB round trips.

Scheduled queries with no `maxEntitiesPerExecution` are limited to 1000 entities (`Query.take`) unless the query already has a smaller `.take()`. A warning is logged once per task when a run returns that many rows. Set `maxEntitiesPerExecution` on the task to raise the cap.

Scheduler locks use the postgres-lease backend by default (`BUNSANE_LOCK_BACKEND=auto`). The lease is renewed while the task runs (about every TTL/3, minimum 1s). Lease TTL is at least the task timeout plus 5 seconds. If the wrapper times out, the lock is held until the underlying task promise settles, so another instance cannot acquire it mid-run.

## Query engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BUNSANE_DEFAULT_QUERY_LIMIT` | `10000` | Default `LIMIT` on `Query.exec()` that never called `.take()`. `0` disables. When the returned page is full, `query.getLastRouteInfo().truncatedByDefaultLimit` is `true`. In `NODE_ENV=development` that call throws instead of returning a silently truncated page. Production logs one warning per process (`H-QUERY-1`) and returns the capped rows. Explicit `.take(n)` does not set the flag. |
| `BUNSANE_USE_LATERAL_JOINS` | `true` | Use LATERAL joins for multi-component queries (PG12+). |
| `BUNSANE_PARTITION_STRATEGY` | `list` | Component partition strategy: `list` or `hash`. ⚠ Changing on an existing DB is guarded against data loss. |
| `BUNSANE_USE_DIRECT_PARTITION` | `true` | Query partition tables directly. |
| `BUNSANE_FORCE_PARTITION_RECREATE` | `false` | ⚠ Destructive — recreates partitions. Dev/migration use only. |
| `BUNSANE_DB_SLOW_MS` | framework default | Slow-query log threshold (ms). |
| `BUNSANE_COMPONENTS_DATA_GIN` | `false` | `true` creates the whole-`data` GIN index (`idx_components_data_gin`) on the `components` table. Off by default: the Query layer serves all filters/sorts from per-field indexes and never emits top-level `data @>` / `data ?` containment, so this index is pure write amplification and blocks HOT updates. Enable **only** if you run raw SQL doing top-level JSONB containment on the whole component payload. A pre-existing DB that still has it: `DROP INDEX CONCURRENTLY IF EXISTS idx_components_data_gin;`. |
| `BUNSANE_MEMBERSHIP_SOURCE` | `components` | Component membership source table (internal). |
| `BUNSANE_ORNODE_SINGLE_PASS` | `1` (on) | OR queries over a required base (`.with(X).with(or([...]))`) scan the base set **once** and combine branches as a disjunction of `EXISTS` predicates, instead of embedding the base in every branch and `UNION`-ing (which forced an N× base scan + a per-branch cartesian nested-loop). Parity-proven against the legacy shape; ~20× faster on a 3-branch OR. Kill-switch: set to `0`/`false` to revert to the legacy `UNION` shape instantly (no redeploy). |
| `BUNSANE_RELATION_TYPED_COLUMN` | — | Typed relation column toggle (internal). |

The framework `PreparedStatementCache`, `Query.getCacheStats()`, and `BUNSANE_QUERY_CACHE_SIZE` are removed. Bun SQL prepares statements per connection. `Query.noCache()` no longer refers to a statement cache; `noCache({ component: true })` still bypasses the component cache. `/metrics` has no `preparedStatements` key.

## Query Surface Planner (experimental)

| Variable | Default | Effect |
|----------|---------|--------|
| `BUNSANE_QSP` | `off` | single master knob: `off` (zero footprint, byte-identical to pre-QSP) \| `shadow` (auto-project lazily + verify parity, never serve rm_) \| `route` (auto-project + auto-shadow + auto-promote to serving). Read at query time — flip without redeploy. |
| `BUNSANE_QSP_ARCHETYPES` | (empty) | optional CSV scope limiter of archetype names eligible for projection. **Empty/unset = ALL archetypes eligible** (wide dual-write blast radius — prefer scoping for first production rollout). |
| `BUNSANE_QSP_COUNT` | `exact` | count strategy on rm_: `exact` \| `n_plus_1` (page boundary) \| `estimate`. Prefer `n_plus_1` for list UIs. |
| `BUNSANE_QSP_PROMOTE_MIN` | `50` | clean shadow comparisons required before a SHADOW projection auto-promotes to READY (route mode only) |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | backfill batch size |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | inter-batch sleep (ms) |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | enable the R1 generic entities accelerator (P5) |
| `BUNSANE_QSP_HYDRATE` | `off` | when `on`, serve fully-columnar components from the `rm_` row instead of re-reading `components` (id-set routing still works with hydrate off) |
| `BUNSANE_QSP_HYDRATE_SHADOW` | `off` | when `on`, observe data-parity (rm_ hydrate vs legacy) without serving; does **not** feed READY auto-promotion |

`BUNSANE_QSP` defaults to `off`; with it unset, framework behavior is byte-for-byte identical to pre-QSP (no `projection_state` table, no hooks). Setting it to `shadow`/`route` turns on the **autopilot**: the first covered list-query for an eligible archetype lazily creates its read model and drives it through the `NONE → BACKFILLING → SHADOW → READY` lifecycle automatically (see `docs/QSP_OPERATIONS.md`). Replaces the removed `BUNSANE_QSP_ENABLED` + `BUNSANE_QSP_MODE` pair.

**Coverage limits (not optional):** routing requires an **exact match** between the query’s `.with` component set and the archetype’s **projected** columns. Empty tag components (no `@CompData`) are not projected — including them in `.with()` forces legacy. Multi-archetype joins, `.without`, OR, ILIKE, and spatial filters are never covered. List-only archetypes (stable core comps, no tags/optionals) are the production pattern — see `docs/QSP_OPERATIONS.md` and `docs/QUERY_LIST_GUIDE.md`.

**Reconcile:** when `BUNSANE_QSP` is `shadow` or `route`, `App.init()` starts `startReconcileSweep()` (default interval 300s) and shutdown stops it. Do not start a second sweep from application code. `off` does not start it.

**Legacy list pagination (independent of QSP):** explicit `.take(N)` fetches `LIMIT N+1` and sets `query.getLastRouteInfo().hasNextPage`. Exact `.count()` remains available when called. Plain `.cursor(entityId)` cannot be combined with `.sortBy()` — use `.sortedCursor(token)` (`docs/READ_PATH_PERFORMANCE.md` §8).

## Cache

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_ENABLED` | `false` | Master switch for caching. Also `app.setCacheConfig({...})`. |
| `CACHE_PROVIDER` | `memory` | `memory` \| `redis` \| `multilevel` \| `noop`. |
| `CACHE_DEFAULT_TTL` | `3600000` (ms) | Default TTL (1h). |
| `CACHE_MAX_MEMORY` | `104857600` | Memory cache cap in bytes (100MB). |
| `CACHE_STRATEGY` | `write-invalidate` | `write-through` \| `write-invalidate`. |
| `CACHE_ENTITY_ENABLED` | `true` | Entity-level cache (`false` to disable). |
| `CACHE_ENTITY_TTL` | `3600000` | Entity cache TTL (1h). |
| `CACHE_COMPONENT_ENABLED` | `true` | Component cache. |
| `CACHE_COMPONENT_TTL` | `1800000` | Component cache TTL (30m). |
| `CACHE_COMPONENT_NEGATIVE_ENABLED` | `true` | Cache "component missing" results as tombstones (default ON since 0.6.2; set `false` to disable). A later save of that component overwrites the tombstone immediately. |
| `CACHE_COMPONENT_NEGATIVE_TTL` | `min(CACHE_COMPONENT_TTL, 60000)` | Negative component cache TTL in ms. |
| `CACHE_RELATION_NEGATIVE_ENABLED` | `false` | Cache empty relation results. |
| `CACHE_RELATION_NEGATIVE_TTL` | `60000` | Negative relation cache TTL (60s). |
| `CACHE_QUERY_ENABLED` | `true` | Query result cache. |
| `CACHE_QUERY_TTL` | `1800000` | Query cache TTL (30m). |
| `CACHE_QUERY_MAX_SIZE` | `10000` | Max cached query results. |
| `BUNSANE_CACHE_INVALIDATION_SECRET` | unset | HMAC-SHA256 secret for cross-instance L1 invalidation pub/sub. Set the same value on every instance that should apply remote invalidations. Unset: pub/sub stays disabled and a **warn** is logged at startup (not info). Unsigned messages are not accepted. Multi-instance apps that leave it unset serve stale L1 entries until TTL. |
| `BUNSANE_CACHE_INVALIDATE_MAX` | `10000` | Cap on keys matched by `invalidatePattern` before the call aborts without deleting. The pattern must have a literal prefix (after `REDIS_KEY_PREFIX`). |

### Redis (when `CACHE_PROVIDER=redis`/`multilevel`, or for Remote)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis host. |
| `REDIS_PORT` | `6379` | Redis port. |
| `REDIS_PASSWORD` | — | Redis password. |
| `REDIS_DB` | `0` | Redis DB index. |
| `REDIS_KEY_PREFIX` | `bunsane:` | Key prefix. |
| `REDIS_MAX_RECONNECT_ATTEMPTS` | `20` | Capped reconnect attempts (prevents infinite spin, C03). |
| `REDIS_ENABLE_OFFLINE_QUEUE` | `false` | Offline command queue. Off by default to bound heap (C02). |
| `REDIS_TLS` | unset | Validated as `true` or `false`. **Not applied by the Redis client** — do not treat it as transport security. `true` logs a boot warning, and fails startup under `BUNSANE_STRICT_ENV`. Isolate Redis on the network and set `REDIS_PASSWORD`. |

## Remote RPC trust model

Redis Streams RPC and the transactional outbox have no network authentication of their own. Redis MUST be authenticated (`REDIS_PASSWORD`) and not reachable from untrusted networks. Signing is an extra bar for a shared or multi-tenant Redis, not a substitute for network isolation.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUNSANE_RPC_SECRET` | unset | HMAC-SHA256 secret for RPC request, RPC response, direct emit, and outbox envelopes. Unset = unsigned (legacy) plus one startup warning. Set = producers sign and consumers ACK-drop unsigned or tampered envelopes (fail-closed). Drops increment `security.signatureRejected` on the remote metrics snapshot. |
| `BUNSANE_RPC_CONSUMER_CONCURRENCY` | `8` | Max in-flight stream messages per `StreamConsumer`. `RemoteManager` config `consumerConcurrency` overrides this. ACK remains per message id. Positive integer when set. |

`replyTo` on an RPC request must be `rpc:responses:<instanceId>`, where the instance id is 1–128 characters of `[A-Za-z0-9._-]`. Any other target is rejected before the handler runs (`security.replyToRejected`).

Outbox publish is at-least-once: the worker claims rows (`claim_token` / `claimed_at`, 60s lease), commits, then `XADD`s. A crash between `XADD` and `published_at` republishes the same logical event under a new Redis id. The envelope `correlationId` is the outbox row id. Consumers drop a duplicate `(sourceApp, correlationId)` for 10 minutes in memory (not across process restart; `security.duplicateDropped`). `sourceApp` is stamped from server config, never from the row payload.

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level: `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. |
| `LOG_PRETTY` | unset | `true` pretty-prints via optional `pino-pretty` (installed by default; omitted by `bun install --omit=optional`). If that package is not installed, the logger falls back to JSON and logs a warning — startup does not throw. Leave unset for JSON logs. Avoid `true` in production: pretty output is much slower than JSON. |
| `DEBUG` | `false` | Framework debug mode. |

## S3 / file uploads (opt-in)

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_BUCKET` | — | Bucket name. When set, `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` are required (or use IAM roles and omit `S3_BUCKET`). |
| `S3_REGION` | — | Region. |
| `S3_ENDPOINT` | — | Custom endpoint (MinIO/R2). |
| `S3_ACCESS_KEY_ID` | — | Access key. |
| `S3_SECRET_ACCESS_KEY` | — | Secret key. |

## Testing

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_PGLITE` | — | `true` runs against in-memory PGlite. Use the `tests/pglite-setup.ts` wrapper, not this var directly. |

### Real-PostgreSQL test runner (tests/pg-setup.ts)

PGlite is the zero-infrastructure default but it cannot exercise real-PG-only
paths: the `?|` / `?&` JSONB operators, `CREATE INDEX CONCURRENTLY`, real LIST
partitioning, and real Bun SQL parameter binding against a live backend. Bugs
in those paths sail past the default PGlite run — the `?|`/`?&` "malformed
array literal" regression is a concrete example that PGlite silently masked.
`tests/pg-setup.ts` provisions an ephemeral scratch database on a real Postgres
server, runs `bun test` against it with prepared statements **enabled** on a
**direct connection** (not PgBouncer), then drops the scratch DB on exit.

**Two connection modes must not be used for the test suite:**

- **PgBouncer (`:6432`) with `DB_DISABLE_PREPARE=true`** — Bun SQL with
  `prepare:false` serializes a JS object parameter to the literal string
  `"[object Object]"`, causing JSONB inserts to fail with
  `invalid input syntax for type json`. The suite must run on a direct port
  with prepared statements on.
- **The shared application DB** — the default `list` partition strategy lazily
  creates one partition per component type. The suite must own its schema
  (hence the ephemeral scratch DB); using the shared app DB causes component
  partitions from unrelated data to collide and break test isolation.

The wrapper automatically removes `DB_DISABLE_PREPARE` from the child
environment and substitutes the scratch DB name, so both issues are bypassed
without any manual configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_TEST_URL` | (derived) | Test-role connection string on a direct Postgres port. The database name is ignored — the runner substitutes an ephemeral scratch DB. If unset, derived from `DB_CONNECTION_URL` with the port swapped to `PG_DIRECT_PORT`. |
| `PG_DIRECT_PORT` | (none) | Direct Postgres listener port that bypasses PgBouncer. Used only when deriving `PG_TEST_URL` from `DB_CONNECTION_URL`. |
| `PG_ADMIN_URL` | (derived) | Superuser (CREATEDB) connection URL targeting the `postgres` maintenance database. Used to CREATE/DROP the scratch DB. If unset, derived from `BUNSANE_PG_DOCKER_CONTAINER`. |
| `BUNSANE_PG_DOCKER_CONTAINER` | (none) | Name of a Docker Postgres container (e.g. `infra-postgres`). When `PG_ADMIN_URL` is unset, admin credentials are read from the container via `docker exec printenv POSTGRES_USER` / `POSTGRES_PASSWORD`. |

All four variables fall back to the matching key in the gitignored `.env.test`.

| npm script | Directories covered |
|------------|---------------------|
| `test:pg` | `tests/unit` + `tests/integration` + `tests/graphql` |
| `test:pg:unit` | `tests/unit` |
| `test:pg:integration` | `tests/integration` |
| `test:pg:graphql` | `tests/graphql` |

---

## PgBouncer deployment

**Prefer `pool_mode = session` scoped to the application's user/database** (or a
direct connection). PgBouncer supports per-user and per-database `pool_mode`, so
this is usually possible even on shared pooler infrastructure — check
`pool_size` / `max_db_connections` for that pool so the app's session-pinned
connections do not starve other consumers. Session affinity makes every caveat
below disappear.

Running behind **transaction pooling** (`pool_mode=transaction`) is supported but
several things then fail *silently*; the settings below are the minimum, and
[POOLING.md](POOLING.md) is the full matrix.

### 1. Disable prepared statements — `DB_DISABLE_PREPARE=true`

Bun's native SQL driver auto-creates **server-side named prepared statements
per connection** (`prepare: true` by default). In transaction pooling, each
transaction may land on a *different* backend connection, so a prepared
statement created on connection A is absent on connection B — yielding
`prepared statement "..." does not exist` / `already exists` errors. Such an
error can leave the pooled client in an aborted-transaction state that the
driver's pool does not recover, so every subsequent `Entity.save` waits and
times out after `DB_QUERY_TIMEOUT` (30s) — a process-internal wedge that looks
healthy at the database layer (no locks, no idle-in-transaction).

Setting `DB_DISABLE_PREPARE=true` passes `prepare: false` to the Bun SQL client
and removes the incompatibility. The cost is a small per-query planning
overhead — negligible next to the outage it prevents, and prepared statements
are unusable under transaction pooling anyway.

> **Note:** `?prepare=false` in the URL is *postgres.js* syntax and is **not**
> reliably honored by Bun's driver. Use `DB_DISABLE_PREPARE=true`.
>
> The framework `PreparedStatementCache` class is removed. `DB_DISABLE_PREPARE` only toggles Bun SQL's per-connection `prepare` flag.

> ⚠️ **Counter-evidence from the field, unresolved.** One production deployment
> (Bun + PgBouncer 1.25.1, transaction mode) reported `DB_DISABLE_PREPARE=true`
> making things *worse*: `unnamed prepared statement does not exist` and
> `bind message supplies 3 parameters, but prepared statement "" requires 0`,
> where `prepare: true` had produced `bind message has N result formats but query
> has M columns` instead. Lowering PgBouncer `max_prepared_statements` to 0 did
> not help either. So both modes can desync through this Bun/PgBouncer pair, and
> the advice above is not a guarantee — it is the better of two bad options on
> the evidence available. This is the strongest argument for the session-mode
> lane at the top of this section. If you hit either signature, record which mode
> and which versions; the framework cannot currently detect this state, and that
> gap is tracked.

### 2. Server-side statement timeout (set on the role, not the app)

`DB_STATEMENT_TIMEOUT` is always sent as the `options` startup parameter — the
framework cannot detect a pooler from the URL, and PgBouncer **drops** `options`
(it must be in `IGNORE_STARTUP_PARAMETERS` or connections fail outright), so
behind a pooler the setting is accepted and has no effect. This is now verified
at boot: `probeConnection()` reads `SHOW statement_timeout` back and logs at
**error** when it did not stick. Set the timeout server-side so PostgreSQL kills
runaway queries even when the app cannot:

```sql
ALTER ROLE myapp SET statement_timeout = '15s';
ALTER ROLE myapp SET idle_in_transaction_session_timeout = '30s';
```

And on PgBouncer, lower `query_wait_timeout` (e.g. `30`) so a drained pool
fails fast rather than hanging.

> Full support matrix (what is safe, what is inert, what throws) behind
> `pool_mode = transaction`: [POOLING.md](POOLING.md). Running migrations /
> backfills / cleanups as standalone scripts:
> [STANDALONE_SCRIPTS.md](STANDALONE_SCRIPTS.md).

### 3. Session-bound features break under transaction pooling

Transaction pooling multiplexes each *transaction* onto a different backend, so
anything that relies on **server-session state surviving across statements** is
unsafe:

| Feature | Why it breaks | Safe option |
|---------|---------------|-------------|
| `pg_advisory_lock` (the `advisory` lock backend) | lock and unlock land on different backends → lock strands, next acquire fails → `withLock` silently skips its critical section (BUNSANE-1) | Default `postgres` lease backend — see below. |
| `sql.reserve()` for session pinning | pins client→PgBouncer, **not** PgBouncer→backend | Don't rely on it for session affinity behind a pooler. |
| Session-level `SET` / GUCs, `LISTEN`/`NOTIFY` | session state/notifications don't persist across pooled transactions | Use a direct/`session`-mode lane for these. |

**Locks are pooler-safe by default.** `BUNSANE_LOCK_BACKEND=postgres` (the
default) uses a lease-row table where every acquire/renew/release is a single
transaction — no session affinity required. If you explicitly opt into
`advisory`, the backend runs a **session-affinity probe on first use** and
throws `UnsafeAdvisoryPoolingError` (failing loud, never silently skipping) when
it detects a transaction pooler — unless you set
`BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`. Advisory is only appropriate on a
direct connection or a `session`-mode PgBouncer port.

See [Locking & connection pooling](LOCKING.md) for backend selection and the
full rationale.

### Recommended PgBouncer env block

```env
DB_CONNECTION_URL=postgres://myapp:***@pgbouncer:6432/mydb
DB_DISABLE_PREPARE=true
DB_CONNECTION_TIMEOUT=5
# DB_STATEMENT_TIMEOUT intentionally unset — set statement_timeout on the PG role
# Lock backend defaults to the pooler-safe 'postgres' lease — no extra config needed.
# Pool recycling defaults (seconds) are correct as-is; override only with cause:
#   DB_POOL_IDLE_TIMEOUT=30
#   DB_POOL_MAX_LIFETIME=600
```

Remember that **no client-side timeout frees a pooled slot** — on any topology,
not just behind a pooler (POOLING.md B8a). The role's `statement_timeout` is what
actually stops the work. `DB_CONNECTION_TIMEOUT=5` does *not* make callers fail
fast at a busy pool either: measured, a caller queued ~4.9 s waiting out the
statements ahead of it before succeeding. It bounds connection **establishment**;
bounding the wait for capacity is the execution seam's job.

---

## Liveness & the write probe

The `/health` endpoint exercises a **real database write** (a temp-table
`INSERT` inside `db.transaction()`, dropped on commit — no persistent side
effect) using the same connection-acquisition path as `Entity.save`. A read-only
`SELECT 1` cannot detect a wedged *write* pool because it runs on any idle read
connection — exactly the scenario where a timed-out container kept reporting
"healthy" and was never restarted.

If the write probe fails or times out (`DB_HEALTH_WRITE_TIMEOUT`, default 5s),
`/health` returns **503**.

Responses omit `uptime` and per-check `latency_ms` (status and check status remain). Successful probes are cached for `BUNSANE_HEALTH_CACHE_MS` (default 5s); a flood above `BUNSANE_HEALTH_MAX_RPS` (default 20) returns 429 without a DB call. `/health` and `/health/ready` are not subject to `REQUEST_TIMEOUT_MS`.

**Point your container's liveness probe at `/health`** (not a static route) so a
wedge auto-recovers via restart:

```yaml
# Kubernetes
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 10
  failureThreshold: 3
```

```dockerfile
# Docker
HEALTHCHECK --interval=10s --timeout=8s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
```

| Endpoint | Purpose |
|----------|---------|
| `/health` | Liveness: DB read + write probe (unless `BUNSANE_HEALTH_PROBE=read` or `HEALTH_DB_WRITE_PROBE=false`) + cache. Status and check status only. Cached and rate-limited. Not subject to `REQUEST_TIMEOUT_MS`. |
| `/health/ready` | Readiness — 503 until `init()` completes and while shutting down; otherwise the same deep check, cache, and rate limit. |
| `/health/remote` | Remote subsystem health (only when `app.enableRemote()` is used). 404 unless `BUNSANE_METRICS_TOKEN` matches or `BUNSANE_METRICS=public`. |
| `/metrics` | Process + cache + DB stats (JSON). Same token gate as `/health/remote`. No `preparedStatements` key. |
| `/docs`, `/openapi.json` | Swagger UI and the OpenAPI spec. 404 unless `BUNSANE_DOCS_TOKEN` matches or `BUNSANE_DOCS=public`. |
