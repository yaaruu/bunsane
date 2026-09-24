# Changelog

All notable changes to bunsane are documented here.

## 0.8.0 — 2026-09-24

### Breaking

- **Multipart requests without `Content-Length` get 411** (`{ error, code: "LENGTH_REQUIRED", limit }`) before the body is read, on REST uploads and `/graphql`. Browsers and `fetch(url, { body: formData })` send the header; in-process tests that build `new Request(url, { body: formData })` must set it. `parseFormData` / `handleUpload` throw `LengthRequiredError` under the same rule.
- **FK-less relations fail schema build unless unambiguous.** `@HasMany` / `@HasOne` / `@BelongsTo` without `foreignKey` must match exactly one `user_id` or `parent_id` property on the owning archetype; otherwise set `foreignKey: 'component.prop'`. `relationsByEntityField` is removed.
- **`REDIS_TLS=true` now opens TLS** on cache and remote clients (was a no-op). `REDIS_USERNAME` is sent when set.
- **`sortedCursor()` token width must match the sort key count**, and `sortedCursor()` without a sort throws.
- **Identifier guards (SEC-17):** `withIndexHint` names must match `^[A-Za-z0-9_]+$`; schema DSL and operation-input names must be GraphQL identifiers; `sqlTimeBucketFromTs` only accepts identifier / `$n` / known column expressions. Advisory lock tokens are random per acquisition; re-acquiring a key this instance already holds returns `null`.
- `BUNSANE_STRICT_ENV=on` fails boot for production Redis on a non-loopback host without TLS.
- **M3 read-model pages must be ordered.** `ReadModel(T).rows()` / `.listPage()` throw when `.limit()` or `.offset()` is set without `.orderBy(...)`; ordered reads always append `left_entity_id, right_entity_id` as a tiebreaker. Unbounded `.rows()` is unchanged.
- **M3 GraphQL list fields return `${Name}Page { nodes, hasNextPage }`** instead of `[${Name}!]!`, with new optional args `offset`, `orderBy` (defaults to `leftEntityId`) and `direction`. `offset + limit` must be ≤ 10000.
- **M3 read models and projection/read-model maintenance run through the DB gateway.** M3 reads (`count`/`countBy`/`rows`/`sum`/`avg`), M3 write-through on save/delete and QSP `setStatus` get request-lane admission and deadline, so a query that previously ran unbounded can now fail with `DbStatementTimeoutError` / `DbAdmissionTimeoutError`. Full M3 rebuilds and pool-side `rm_*` / `m3_*` DDL run on the background lane with `DDL_TIMEOUT_MS`. Statements on a caller-supplied `trx` stay on that handle and take no extra permit.

### Added

- **Multi-key keyset pagination.** `sortedCursor` works for several `sortBy` keys (same or different components), `sortByCreatedAt` + `sortByUpdatedAt`, and OR + multi-sort, with mixed ASC/DESC, per-key NULLS placement, and `'before'`. `Query.encodeSortedCursor([k1, k2, …], id)`; existing single-key tokens still decode. Multi-key component sorts keep the leaf-driven `ORDER BY expr1, expr2, …, entity_id LIMIT n` scan.
- **Batched `@ArcheTypeFunction({ batch: true })`.** Parents are collected per request (one batch per distinct args) and the method is called once with `(parents: Entity[], ctx, args?)`, returning a `Map` keyed by entity id. Non-batch methods unchanged.
- `REDIS_TLS_SERVERNAME`, `REDIS_TLS_REJECT_UNAUTHORIZED`; shared ioredis options builder (`buildRedisConnectionOptions`); explicit `RedisCache` config and `redisFactory` still win over env.
- M3 `.orderBy(field, 'ASC' | 'DESC')`, `.offset(n)` and `.listPage()` (`limit + 1` probe → `{ nodes, hasNextPage }`).
- **Real-PostgreSQL before/after benchmark** (`bun run bench:pg:compare`, gate `bench:pg:gate` at +50% and +2 ms p50, baseline `tests/benchmark/baseline/md-pg.json`). 0.6.2 → 0.7 on 100k entities, p50: single-field top-N sort −87…88%, keyset next page −89%, GraphQL list with relation + computed field −81%, two filters + sort −19%, `sortByCreatedAt` −14…15%, populate −3% (noise). A `batch: true` computed field cuts that GraphQL list from 54 statements to 5 (p50 5.5 → 3.7 ms). Method, plans and raw numbers: `docs/internal/BENCHMARK_0.7.md`. PGlite baselines refreshed.

### Fixed

- FK-less relations query with `type_id` pinned (one partition) instead of scanning every component partition.
- Importing `bunsane` no longer registers the local storage provider or logs; registration happens on first upload use.
- The DB-seam test now catches pool fallbacks written as `(trx ?? db).unsafe(…)` / `(trx || db).unsafe(…)`; the M3 reader, `ReadModelManager`, read-model `DDL`, `ProjectionManager.setStatus` and `DDLGenerator` sites it found are routed (the `DDLGenerator` allow-list waiver is gone).

## 0.7.0 — 2026-09-24

Includes the previously unreleased 0.6.2-era work below the overhaul section.

### Framework overhaul (2026-09-24) — correctness, list performance, DX, security

#### Breaking

- **Entity reads throw on failure.** `get()` / `getOrThrow()` throw `ComponentLoadError` on DB errors or aborts instead of returning `null`; confirmed absence still throws `ComponentMissingError` (same message). Relation DataLoaders reject instead of resolving `[]`.
- **`remove()` of an unloaded component** returns `true` and deletes the row on `save()` (it used to return `false` and leave the row).
- **`updated_at` moves.** Dirty saves set `entities.updated_at` and `components.updated_at` to `NOW()`; `sortByUpdatedAt` is no longer creation order for component-only edits.
- **Query typing.** `Query<TComponents, TPopulated>`: `componentData` is typed as loaded only after `.populate()`. `.with(Ctor, { filters })` rejects field names that are not keys of that component. `Query.getCacheStats()` removed.
- **`NODE_ENV=development`:** an unbounded `exec()` that fills `BUNSANE_DEFAULT_QUERY_LIMIT` throws. Production keeps the one-time warning and sets `getLastRouteInfo().truncatedByDefaultLimit`.
- **Boolean filters** compare JSON text (`data->>'f' = 'true'`); PG-liberal casts (`'yes'`, `'1'`, `'t'`) stored as strings no longer match.
- **GraphQL schema build fails loudly** on: unrecognised `@GraphQLOperation` output (was `String` / `[Any]`), unregistered relation targets, `@ArcheTypeFunction` without a usable return type. Date scalar only from `z.date()` / `Date` props (the `*_at` / `date*` name heuristic is gone). `id: ID` only on archetype `id` fields, not every `id: String`.
- **GraphQL limits:** default max depth 15; `setGraphQLMaxDepth(n < 15)` and `setGraphQLMaxComplexity(n < 1)` throw; 0 no longer disables. Introspection and GraphiQL are off unless `NODE_ENV=development` or `GRAPHQL_INTROSPECTION` / `GRAPHQL_GRAPHIQL=on` (SEC-09).
- **Deny-by-default info endpoints (SEC-10):** `/metrics`, `/health/remote`, `/docs`, `/openapi.json` return 404 without `BUNSANE_METRICS_TOKEN` / `BUNSANE_DOCS_TOKEN` or `BUNSANE_METRICS=public` / `BUNSANE_DOCS=public`. `/health` drops uptime/latency fields.
- **Body limits (SEC-14):** non-multipart bodies default to 1 MB (413 by `Content-Length`).
- **App lifecycle:** `use()` after `start()` throws; second `start()` is a no-op. `securityHeaders` + `requestId` middleware on by default (SEC-15); HSTS requires `BUNSANE_HSTS=on` or `BUNSANE_TLS=on`.
- **Cross-instance cache invalidation requires `BUNSANE_CACHE_INVALIDATION_SECRET`** on every instance (SEC-11). Unset: pub/sub disabled with a startup warning — multi-instance apps must set it or serve stale L1 entries until TTL. `invalidatePattern` needs a literal prefix and is capped by `BUNSANE_CACHE_INVALIDATE_MAX` (SEC-13).
- **Hooks:** `async: true` hooks are no longer awaited on the save path (errors logged; shutdown still drains them).
- **Scheduler:** queries without `maxEntitiesPerExecution` are capped at 1000 entities.
- **Uploads:** removed never-implemented `generateThumbnails`, `imageProcessing`, `scanForMalware` flags; `UploadManager` defaults now match `DEFAULT_UPLOAD_CONFIG`.
- **Removed modules/exports:** `BatchLoader`, `PreparedStatementCache`, `core/app/preparedStatementWarmup.ts`, `DatabaseHelper.UpdateComponentIndexes`, `core/decorators/ScheduledTask.ts` (use `scheduler`), `gql/ArchetypeOperations.ts`, `TypeGenerationStrategy`, `InputTypeBuilder`, `TypeDefBuilder`, `GraphQLFieldTypes`, `TypeFromGraphQL`, `ResolverInput`, the import-time `yoga` export, `enableArchetypeOperations`, `rest/Generator.ts`, `types/app.types.ts`. Downgrade tools moved to `database/maintenance.ts`.
- **Default `db` export is a lazy proxy** (not `=== getDb()`, not `instanceof SQL`). Use `getDb()` when you need the instance.
- **`@HasOne` is nullable in SDL** unless `nullable: false`; the child is resolved on the related archetype's foreign key (batched), and a missing child returns `null`.

#### Fixed

- **A rolled-back `Entity.save()` looked persisted** — flags and removal sets now change only after the transaction (incl. QSP/read-model sync) commits, so a retry reissues every write.
- `LoadComponents` / `LoadMultiple` / eager load revive `@CompData` `Date` fields; `serializableData()` accepts valid ISO strings.
- `or()` on partitions built its own predicates: booleans were cast `::numeric` and numeric filters skipped the RP-04 index predicate. OR branches now use `FilterBuilder`.
- Archetype field / relation / `@ArcheTypeFunction` resolvers are attached at schema build (no `registerFieldResolvers` call needed; it stays idempotent). Resolvers return already-populated parent data synchronously instead of re-fetching.
- `@GraphQLOperation` accepts archetype classes as `output`.
- `getEntityWithID` `includeComponents` / `excludeComponents` match archetype property keys.
- `sortedCursor(token, 'before')` works for single-key component sort, `sortByCreatedAt` / `sortByUpdatedAt`, and OR + sort.
- `LoadComponents(skipCache)` is honored and writes absence tombstones.
- Scheduler locks renew while a task runs (TTL ≥ timeout + 5 s) and are not released on wrapper timeout until the task settles.
- Bare `get()` / `reload()` go through the DB gateway (admission, timeout, metrics).
- Shutdown exits non-zero when a drain step fails, releases the DB singleton (`closeDatabase()`) so a later use opens a fresh pool, and clears the server handle so `start()` can run again.
- Studio: missing `studio/dist` is detected (was always "present"); `index.html` is cached.
- `LOG_PRETTY=true` without `pino-pretty` installed falls back to JSON with a warning.

#### Performance

- Single-component `.with(A).sortBy(A, f).take(n)` with no filters uses a leaf-driven `ORDER BY expr, entity_id LIMIT n` scan (was a correlated sort of the whole set).
- `sortByCreatedAt` / `sortByUpdatedAt` walk `entities` in order with `EXISTS` membership probes + `LIMIT` instead of materializing the id set.
- CTE multi-filter path no longer re-probes membership or `DISTINCT`s after `INTERSECT`; unique membership scans drop `DISTINCT`; `OFFSET` omitted when 0.
- Indexed boolean filters use the existing `(data->>'f')` btree.
- Multi-type `.populate()` reads partition leaves (`UNION ALL`) instead of the parent table.
- Component DataLoader fetches exact `(entity_id, type_id)` pairs; cache fill no longer blocks the response; misses are single-flighted; L2→L1 promotion is one batched write; gzip threshold 1 KB → 8 KB.
- `Entity.saveMany()` — one transaction, batched inserts/upserts (500-row chunks); `EntityManager` pending saves use it.
- Hook dispatch fast-paths events with no hooks; component-target sets precompiled.
- Schema build weaves archetypes once (memoized) instead of twice per rebuild, with no per-archetype `printSchema`.
- Resolver path: static upload-guard import, sweep skipped when args contain no `File`/`Blob`, `@Middleware` chain composed once.
- Boot: sequential partition attach, one partition-strategy lookup, one `pg_indexes` query, `ANALYZE` only when something was created; partition DDL failure fails boot.
- Request timeout configurable (`REQUEST_TIMEOUT_MS`, 0 = off); `/health` skips the timer and Request clone. Health write probe cached (5 s) and rate-limited.
- Remote stream consumer runs with bounded concurrency (default 8); outbox claims, commits, then `XADD`s outside the PG transaction.

#### Added

- Root barrel: `import { App, Entity, BaseComponent, Component, CompData, BaseArcheType, Query, FilterOp, BaseService, GraphQLOperation, t, logger, withLock, ScheduledTask, … } from "bunsane"`; `package.json` `exports` (deep paths still resolve), `types`, `engines.bun`.
- Typed `@GraphQLOperation` / `@GraphQLSubscription`: method checked as `(input: InferInput<I>, ctx, info) => Out`; `t` / `InferInput` exported from `gql`.
- `HasMany` / `BelongsTo` / `HasOne` / `BelongsToMany` accept a class or `() => Class`.
- `entity.hasPersisted(Ctor)`; `AppConfig` object for `new App({...})` merged over env; `setRequestTimeout`, `setJsonBodyLimit`, `setMultipartBodyLimit`; `closeDatabase()`, `isDatabaseInitialized()`.
- Rate limiter keys by socket IP (`server.requestIP`) by default.
- Optional HMAC signing for RPC envelopes (`BUNSANE_RPC_SECRET`, SEC-12); `replyTo` restricted to `rpc:responses:*`.
- QSP reconcile sweep starts automatically when `BUNSANE_QSP` is `shadow` / `route` (F-11).
- `validateEnv` covers SEC-16 variables; `BUNSANE_STRICT_ENV=on` turns boot warnings into failures.
- README hello world + consumer tsconfig; `docs/README.md` index (internal RFCs/tickets moved to `docs/internal/`, not published).

#### Changed

- String-map and Zod `@GraphQLOperation` inputs log a deprecation warning (use `t.*`).
- Single CORS implementation in the framework wrapper (Yoga CORS disabled).
- `pino-pretty` is an optional dependency. `test:all` excludes stress/benchmark.

### Fixed (2026-09-05, read-path N+1 quick wins)

- **Archetype component-field resolvers re-queried absent optional components.** When the request DataLoader answered null for a `nullable: true` component, the resolver fell through to a bare `entity.get()` — one un-batched `SELECT` per parent per absent field on every list request (measured 40 of 51 statements on a 20-row order list). The loader's null is now authoritative. Same fix applied to the `belongsTo` foreign-key fallback and the related-entity fallback.
- **Bare `entity.get()` now consults the shared cache.** The non-loader path (auth, schedulers, reconcile sweeps, `@ArcheTypeFunction` bodies outside a request scope) went straight to SQL, ignoring cached rows and tombstones. It now reads the same `component:<entity>:<type>` key the DataLoader path uses, writes through on miss, and tombstones absences. Skipped inside an explicit transaction.
- **`logger.error({ error })` printed `error: {}`.** Pino serializers for `err` and `error` added so message/stack/type reach the log.

### Changed

- **`CACHE_COMPONENT_NEGATIVE_ENABLED` defaults to `true`.** Absent optional components are the common case in ECS; tombstones (60 s default TTL, overwritten by the next save) stop every request re-probing them. Set `false` to restore the old behaviour.
- **Cache boot self-check.** `CacheManager.initialize()` waits for a remote provider to report ready (3 s) and pings it; an unreachable Redis now logs one clear warning at startup instead of failing silently per call. New optional `CacheProvider.waitReady()`.

### Added

- **M3 `@ReadModel` Stage A** — cross-entity derived tables (`m3_*`, not QSP `rm_*`), write-through on `Entity.save` / `doDelete`, SQL `where` / range / `IN` / `count` / `avg` / `groupBy`+`sum`, covering + timestamptz indexes, read-only GraphQL Query resolvers. Docs: `QUERY_LIST_GUIDE` reports section replaces `take(50000)` + JS as the report path.
- **`Query.maxBy` / `minBy` / `avgIntervalMinutesBy`** — SQL `GROUP BY` + `MAX`/`MIN` (timestamptz default, `{ cast: "numeric"|"text" }`) and `AVG(end − start)` in minutes for two Date JSON fields. **`FilterOp.IS_NULL` / `IS_NOT_NULL`** treats missing / JSON null / `''` as blank. Last-order and open-assignment reports no longer need `take(50000)` + JS.

### Documentation (2026-08-07)

- **Read-path / list Query docs aligned with 0.6.x engine work:** RP-01…07 status,
  filter pushdown + numeric index, `hasNextPage`, `cursor`+`sortBy` throw,
  N+1 diagnosis, QSP coverage limits (exact set, empty tags, multi-archetype).
  - `docs/READ_PATH_PERFORMANCE.md` — canonical analysis updated
  - `docs/QSP_OPERATIONS.md` — coverage rules, hydrate flags, reconcile not
    auto-started, first-archetype checklist
  - `docs/QUERY_LIST_GUIDE.md` — **new** app-author guide
  - `docs/CONFIGURATION.md` — `BUNSANE_QSP_HYDRATE*`, coverage notes
  - `docs/TICKETS_READ_PATH_PERF_2026-08.md` — RP-06b done + product follow-ups

### Fixed (0.6.1 verification follow-through)

Everything below came out of a downstream verification of 0.6.1 that reached three
wrong conclusions — and every one of them traced back to something this repo
either stated inaccurately or left unasserted. No behaviour change.

### Fixed

- **`armGateway()` is called by `App.init()`, not `App.start()`.** Four comments
  and docs said `start()`; the call is at `core/App.ts:219` inside `init()`,
  which begins at :159 while `start()` begins at :401. "Will the serving process
  be armed?" is exactly the question a deploy has to answer, and the comment sent
  the reader to the wrong method.

- **`probeConnection()` no longer reports "not transaction-pooled" when it simply
  could not tell.** PgBouncer returns connections LIFO, so on an idle pool every
  probe statement lands on the same backend and a transaction-pooled deployment
  is indistinguishable from a session-pooled one. That read as
  `transactionPooling: false` twice — once at 0.5.10 boot on production, once as
  a first-run flake after a vendor swap. New `poolingOutcome:
  'proven' | 'unproven-idle-pool' | 'skipped'` alongside the boolean (same shape
  as `cancelEffective: boolean | null`), and the unproven case now logs that it
  must not be read as "no pooler". Detecting harder was considered and rejected:
  issuing the statements concurrently across pool connections yields distinct
  backends under session pooling too, trading a false negative for a false
  positive that would wrongly demand `DB_DISABLE_PREPARE=true`.

### Added

- **`tests/integration/db-admission-shedding.test.ts`** — the real-PG saturation
  numbers quoted in `gateway.test.ts` and `docs/CONFIGURATION.md` were a
  measurement readers had to trust. They are assertions now: 20 concurrent
  `pg_sleep(2)` against `admissionLimit = 3`, at an 800 ms budget (majority shed
  before reaching the server, nothing completes) and at 30 s (nothing shed, all
  20 complete, drain several times a single statement). Shed-at-the-door
  (`DbAdmissionTimeoutError`) and killed-after-admission
  (`DbStatementTimeoutError`) are counted separately, because collapsing them
  hides which bound fired.

- **`tests/unit/database/poolingProbe.test.ts`** — covers the tri-state above,
  including that observing no PIDs at all stays `skipped` rather than
  collapsing into `unproven`.

### Documentation

- **`DB_REQUEST_TIMEOUT` is a total deadline, and the docs now say what that
  costs.** `gateway.ts` and `CONFIGURATION.md` already stated it covers "the
  wait for a permit AND the query", but not the consequence: a 500 ms request
  budget also kills any *admitted* query slower than 500 ms. It is not a
  queue-only knob, and it should be sized against the slowest legitimate request.
  It bounds the CALLER; reclaiming the pool SLOT remains the server-side
  `statement_timeout`'s job (B8a) — different guarantees, both wanted.

## 0.6.1 — 2026-07-27

Two gaps found by measuring 0.6.0's own admission against a saturated pool.
Behaviour is byte-identical to 0.6.0 out of the box: both new settings are unset
by default.

### Added

- **`DB_REQUEST_TIMEOUT` / `DB_BACKGROUND_TIMEOUT` — per-lane deadlines.**
  0.6.0's admission bounds the QUEUE, which is what `DB_CONNECTION_TIMEOUT`
  provably does not do. It does not SHED. Measured through the real `dbExec`
  seam (real PG 17, `poolMax 4` -> `admissionLimit 3`, 20 concurrent
  `pg_sleep(2)`, identical direct and through PgBouncer):

  | request-lane budget | rejected | reached the server | drained |
  |---|---|---|---|
  | 800 ms | **17 / 20** | 3 | **2063 ms** |
  | 30 000 ms (what 0.6.0 shipped) | **0 / 20** | 20 | **14056 ms** |
  | admission off (control) | 0 / 20 | 20 | 10034 ms |

  No framework call site passes a per-call `timeoutMs`, so every lane inherited
  the 30 s `DB_QUERY_TIMEOUT`. A default deployment therefore got bounded,
  observable queueing — callers waiting 4.3 s on average and 12.0 s at worst —
  and no shedding, with drain *worse* than admission-off because the seam caps
  concurrency at `admissionLimit` while the raw pool ran at `poolMax`.

  One global value cannot serve both lanes: a request wants to fail in seconds,
  while backfill and reconcile legitimately run far longer on the same pool.
  **Request-facing deployments should set `DB_REQUEST_TIMEOUT` to a few
  seconds.** It is left unset because shortening it changes which requests fail
  under load — a deployment's decision, not a patch release's.

  There is deliberately no `DB_HEALTH_TIMEOUT`: `admit()` exempts the health lane
  outright, so it would bound only the query and never the queue.

- **`getGatewayStats().unarmedCalls`** — queries that bypassed admission because
  nothing had armed the gateway. `armGateway()`'s only caller is `App.init()`,
  after migrations, so anything using the framework database without booting an
  App got no admission and nothing said so. A mitigation that is absent and
  silent is worse than one that is absent and loud: the metrics look calm
  precisely because nothing is being measured. A process still unarmed 60 s after
  start now warns once; `armGateway()` silences it permanently, because
  migrations on a cold database can legitimately exceed a minute and a warning
  that fires during a normal slow boot is one people learn to ignore.

### Fixed

- `docs/POOLING.md` and `docs/CONFIGURATION.md` claimed framework admission was
  the answer to unbounded pool-wait without distinguishing bounding from
  shedding. Both now carry the measurement and a three-bounds table: role
  `statement_timeout` bounds the STATEMENT, admission bounds the QUEUE,
  `DB_REQUEST_TIMEOUT` is the only one that SHEDS.

## 0.6.0 — 2026-07-27

The release 0.5.11 was a hotfix for: it gives the framework somewhere to put a
policy about its own database traffic, and then puts two there.

### Added

- **The DB execution seam (`database/gateway.ts`).** Framework DB traffic used to
  reach Postgres through ~111 raw `.unsafe(` call sites plus ~47 tagged
  templates, of which a handful carried a timeout, a signal or a metric. There
  was consequently nowhere to bound concurrency, propagate a deadline, keep
  background work off user traffic, or even count queries accurately — each
  would have meant editing every call site. That is the structural reason a slow
  database became a wedged application: the framework had no place to say "no".

  Everything now routes through `dbExec` / `dbRun` / `dbTransaction`, which own:

  - **Lanes.** `request` may use the whole admission limit; `background`
    (scheduler, outbox, projection backfill/reconcile, studio endpoints) is
    capped at half so it cannot starve user traffic; `health` is never admitted,
    because a probe that queues behind saturation reports "wedged" when the truth
    is "busy" and the orchestrator restarts a healthy container.
  - **Admission per TRANSACTION, never per statement.** A transaction already
    holds its pooled connection; making it queue for a permit to issue its *next*
    statement is a nested-acquire deadlock that presents exactly like the outage
    this work came from. Exemption follows the async call tree via
    AsyncLocalStorage, plus an explicit `callerOwnsConn` for handles arriving from
    outside the framework (`Query.withTrx`, `saveEntity(entity, trx)`).
  - **One deadline covering the wait AND the query.** Two independent 30 s clocks
    is how a request stalls for a minute before failing.
  - **Our own queue, deliberately.** `DB_CONNECTION_TIMEOUT` was assumed to bound
    waiting for a busy pool; measured, a caller queued 4860 ms against a 1 s
    setting and then succeeded. It is the connection *establishment* timeout.
  - Per-label metrics, slow log, and `/metrics.dbAdmission`.

  `tests/unit/db-seam.test.ts` keeps the seam closed by grepping the tree, with
  an allow-list where every entry states why it cannot be routed — boot DDL whose
  tagged templates change wire protocol if converted, lock renewal that must
  never queue, health probes, and statements on a caller-supplied transaction.
  Two further tests fail if an entry goes stale or loses its reason.

  Admission engages via `armGateway()` *after* boot migrations, so DDL is never
  serialized behind a limit derived before the pool is warm. `BUNSANE_DB_ADMISSION=off`
  makes the whole thing a passthrough; `DB_ADMISSION_HEADROOM` (default 1) keeps
  connections outside the limit for the health lane.

- **Server-side deadline enforcement.** `dbTransaction` now emits
  `SET LOCAL statement_timeout` derived from its own deadline, so every write
  path (`entity.save`, `entity.delete`, studio bulk deletes) carries a bound the
  *server* honours. Until now every timeout in the framework was client-side,
  and a client-side abort does not stop Postgres — the statement runs to
  completion and holds its pool slot for its real duration. That is the outage
  mechanism, and this is the fix for the transaction half of it.

  Measured cost on real PG 17, 200 interleaved samples: **+0.40 ms on a 3.0 ms
  entity save (13%)** — one extra round trip, paid once per transaction. That
  was a local Docker Postgres: the round trip is the portable unit, the
  percentage is not — it scales with your RTT and with how many statements your
  save already issues. (An
  earlier micro-benchmark on a bare `BEGIN`/`SELECT 1`/`COMMIT` suggested
  +0.12 ms; a real save pays the full round trip, and the end-to-end number is
  the one that counts. Issuing the `SET LOCAL` unawaited so the driver might
  pipeline it was tried and made no difference — Bun serializes a connection's
  queue.) Wrapping a *bare* statement in a transaction to carry the setting
  costs **+0.95 ms (3.7×)** against a 0.35 ms baseline, so bare statements are
  **opt-in** (`dbExec(..., { serverTimeout: true })`) — taken by the studio
  endpoints and projection backfill/reconcile, not by the read path. Bare
  statements that do not opt in remain covered only by
  `ALTER ROLE <user> SET statement_timeout`, which is why that stays
  load-bearing.

  Not applied to DDL (`CREATE INDEX CONCURRENTLY` cannot run inside a
  transaction block) or to a caller-supplied transaction handle (`SET LOCAL` is
  transaction-scoped, not savepoint-scoped, so it would silently outlive our
  savepoint and change the caller's setting). Skipped under PGlite, as
  `DB_STATEMENT_TIMEOUT` already is. Kill switch: `BUNSANE_DB_SERVER_TIMEOUT=off`.

  A server-side kill is re-thrown as `DbStatementTimeoutError` with the lane,
  label and budget attached, rather than the bare `canceling statement due to
  statement timeout` — otherwise the new bound would be less legible than the
  client-side one it replaces.

- **The boot probe measures cancel effectiveness instead of inferring it.**
  Whether a timeout reclaims its connection was previously deduced from pooling
  mode, which was wrong twice over: cancellation is a property of the driver,
  and pooling mode does not predict it. `probeConnection()` now runs a ~150 ms
  `pg_sleep`, aborts it through the framework's own `runWithSignal` path — so
  `BUNSANE_ABORT_MODE=off` is reported honestly — and watches the *statement*,
  not the caller, to see when it really ended.

  Reports at **error** when an ineffective cancel coincides with no server-side
  `statement_timeout`. That conjunction is the outage precondition: nothing can
  stop a slow query, so the pool is lost one slot at a time while the database
  sits idle. Either condition alone is a warning.

  `cancelEffective` is `boolean | null`, and `null` means unproven — a skipped or
  failed probe must never read as "fine". A live `statement_timeout` killing the
  probe's own statement is detected by message text rather than credited as a
  working cancel (both are SQLSTATE 57014), and the probe declines to run under a
  bound too tight to fit beneath. Knobs: `BUNSANE_PROBE_CANCEL=off`,
  `BUNSANE_PROBE_CANCEL_SLEEP_MS`. Exported as `probeCancelEffectiveness()` so
  `runDoctor()` can re-run it with a longer, more conclusive sleep than boot
  should pay for.

- `entity.save()` / `entity.delete()`: the client-side timer now fires
  `SAVE_CLIENT_BACKSTOP_MS` (2 s) **after** the deadline it hands the gateway,
  instead of at the same instant. Both derived from `QUERY_TIMEOUT_MS`, so which
  one fired was a race — and they raise different types, making a caller that
  matches on `DbStatementTimeoutError` catch it only sometimes. They are not
  peers: the server bound stops the work and releases the slot, the client timer
  only stops waiting. The server bound is now the primary; the client timer
  remains the backstop for PGlite, `BUNSANE_DB_SERVER_TIMEOUT=off`,
  caller-supplied transactions, and time spent between statements.

### Corrected

- **B8a is a driver property, not a pooling one — `pool_mode = session` does NOT
  fix it.** 0.5.11 (below) explained the pinned pool slot as a cancel request
  that the pooler could not forward. Re-measured on PostgreSQL 17.10 with Bun
  1.4.0-canary.1, running the same harness against both topologies: a direct
  connection reacquired the slot at **5010 ms** and pgbouncer
  `pool_mode = transaction` at **5009 ms**, for a 5000 ms statement. Identical,
  so the pooler is not in the loop.

  Watching the backend from a second connection shows the actual mechanism:
  after `cancel()` at 415 ms it stays `active` at every sample through 7717 ms
  and the query **resolves — does not reject —** at 8018 ms, its natural end.
  `query.cancel()` issues no Postgres CancelRequest at all. Re-run with three
  pool slots free (capacity confirmed live) to rule out the cancel channel
  queueing behind the query it targets; same result.

  **If you are moving to `pool_mode = session`, keep doing it** — it is still
  required for advisory locks, the `options` startup parameter, and server-side
  prepared statements (B1/B6). But it buys nothing for B8a, so
  **`ALTER ROLE <user> SET statement_timeout` is now load-bearing rather than
  supplementary**: it is the only thing that bounds a statement that is not
  wrapped in a transaction. Shipping session mode *without* it reproduces the
  outage signature.

- **`DB_CONNECTION_TIMEOUT` does not fast-fail a busy pool.** 0.5.11 advised
  request-facing deployments to set `5` so callers fail instead of queueing.
  Measured: with `connectionTimeout: 1`, a caller arriving at a full pool queued
  **4860 ms (direct) / 4862 ms (pooled)** and then succeeded — it waited out the
  statements ahead of it. Bun documents the option as the connection
  *establishment* timeout, and that is all it is. `5` remains reasonable as an
  establishment bound; it is not admission control. Bounding the wait is the
  execution seam's job (`database/gateway.ts`).

- The bound that does work, on both topologies: `SET LOCAL statement_timeout`
  killed a 6 s statement at ~1214 ms with the slot reusable 1–2 ms later. Use
  `SET LOCAL`, never plain `SET` — under transaction pooling a session-level
  `SET` leaks to the next client of that pooled server connection.

### Fixed

- `tests/pg-setup.ts` discovers the direct Postgres port from
  `docker port <container> 5432` per run instead of trusting a pinned
  `PG_DIRECT_PORT`. Docker reassigns that host port on every container recreate,
  and a stale pin fails as `ERR_POSTGRES_CONNECTION_REFUSED` — which reads as
  "no real Postgres available" and silently skips the real-PG test tier.

## 0.5.11 — 2026-07-26

Hotfix for the downstream B8 report: a ~7 h production outage where the API
wedged with an **idle** database — Postgres at 0 % CPU, no locks, pgbouncer
reporting 0 queries/s — because the client-side pool lost one slot at a time
across a business day and never got any back.

0.5.10's theme was "fail loudly". This release corrects a case where the *fix
itself* was documented as delivering a property it does not have:
`docs/POOLING.md` claimed wall-clock timeouts were safe behind a pooler because
they cancel the statement, so the backend is released. Measurement says
otherwise, and nothing tested the claim. Docs rows now cite a measurement or a
boot probe.

### Fixed

- **Bun SQL pool timeouts are SECONDS; the framework passed milliseconds.**
  `idleTimeout: 30000` and `maxLifetime: 600000` meant ~8 h 20 m and ~6.9 days,
  not 30 s and 10 min — so **no pooled connection was ever recycled on age or
  idleness** within a container's life. An idle pool never shrank (holding `max`
  server-side connections after any burst), and a connection in a degraded state
  had no age-based escape. Now 30 s / 600 s, overridable via
  `DB_POOL_IDLE_TIMEOUT` / `DB_POOL_MAX_LIFETIME`.
  Units verified empirically on Bun 1.4.0 (`idleTimeout: 2` → `onclose
  ERR_POSTGRES_IDLE_TIMEOUT` at t=2016 ms), not inferred from a comment.
  ⚠️ This is proven for *idle* connections. Whether the corrected `maxLifetime`
  can also evict a connection stuck on an abandoned query is **unmeasured**, so
  it is not claimed as the whole explanation for the lost slots.
- **A ms/s mix-up is now rejected at boot** rather than silently disabling the
  policy, with a **per-setting** ceiling (`DB_CONNECTION_TIMEOUT` 300 s,
  `DB_POOL_IDLE_TIMEOUT` 3600 s, `DB_POOL_MAX_LIFETIME` 86400 s). A single
  global cap would have missed the bug that shipped: 30 000 s sits under any cap
  loose enough to allow a one-day lifetime. Use `0` for "no limit".
- **Pool exhaustion answers 503, not 500.** `ERR_POSTGRES_CONNECTION_TIMEOUT`
  (the pool-wait expiring — the statement never reached the server) is now
  classified in `database/poolErrors.ts` and answered as
  `503 POOL_EXHAUSTED` + `Retry-After`, counted as `poolAcquireFailures` in
  `/metrics`. A 500 told clients their request was wrong when the server was
  merely full.
- **`PlannerCache.refresh` is bounded, single-flight and loud.** It ran
  `db.unsafe(...)` with no signal, no timeout and no metrics, fire-and-forget
  from `getState()` on the read hot path, and every query arriving during a slow
  refresh started another one. It now runs through the instrumented seam with a
  5 s timeout, shares one in-flight refresh across concurrent callers, and
  escalates to **error** after 3 consecutive failures with the staleness of the
  map it is still serving. In production this failed 523/523 times from boot at
  `warn` level and read as noise.

### Added

- **Pool-saturation readiness signal.** `/health/ready` fails with a `db_pool`
  check once the pool has been continuously saturated for
  `DB_POOL_SATURATION_READY_MS` (default 3000; `0` disables), so traffic is shed
  and the pool can drain in place. Deliberately **not** a liveness signal: a full
  pool is also what a legitimate burst looks like, and restarting mid-burst
  trades a slow minute for a cold start plus a reconnect thundering herd. A
  genuinely wedged pool still fails liveness via the `/health` write probe.
  Saturation is measured against a new `poolMax`, published by the pool
  constructor; `/metrics` gains `poolMax`, `poolSaturatedForMs` and
  `poolAcquireFailures` alongside the existing `inFlight` / `inFlightMax`.
  Caveat stated in the docs: `inFlight` counts only calls through
  `database/instrumentedDb.ts`, a subset of framework DB traffic, so it is a
  **lower bound** — a positive saturation reading is certain, a zero is
  unproven.
- **`BUNSANE_ABORT_MODE=cancel|off`** (default `cancel`, unchanged behaviour) —
  a temporary diagnostic switch so a deployment can test whether issuing
  `query.cancel()` is itself implicated in pooled connections that never
  return. There is deliberately no `destroy` mode: Bun SQL exposes no way to
  destroy one pooled connection, and a mode that cannot do what its name says is
  the exact failure pattern being removed. This switch will be deleted once the
  mechanism is identified.

### Changed — documentation now matches measurement

- `docs/POOLING.md` no longer opens with "yes, and it's what the framework is
  tuned for". **`pool_mode = session` scoped to the app's user/database (or a
  direct connection) is now the recommended topology**; transaction pooling is
  supported-but-degraded, with the caveats listed.
- The "Query/save wall-clock timeouts ✅ safe" row is now ❌ **ineffective as a
  slot-recovery mechanism**, with the measurement: aborting `pg_sleep(20)`
  through pgbouncer released the slot at **20.0 s** — the query's natural end —
  whether the client abandoned it or called `cancel()` and waited. A cancel
  request needs a server connection to be forwarded, which is precisely what is
  unavailable when the pool is exhausted. `DB_QUERY_TIMEOUT` bounds the
  **caller**, not the statement; the only real statement bound behind a pooler is
  `ALTER ROLE … SET statement_timeout`.

  > ⚠️ **The conclusion holds; the explanation above is wrong.** The slot is
  > pinned, but not because a cancel could not be forwarded — `cancel()` sends
  > nothing, and the same pinning happens on a direct connection. Corrected under
  > *Unreleased* at the top of this file; it changes what `pool_mode = session`
  > is worth.

- `DB_CONNECTION_TIMEOUT` default stays **30 s** on purpose. Request-facing
  deployments should set `5`, and the docs now say so — but one pool is shared
  with background work (scheduler, outbox, projection backfill/reconcile) that
  legitimately waits longer, and there is no per-lane timeout yet. Lowering the
  global default would start failing that work. Per-lane defaults land with the
  execution seam.

  > ⚠️ Setting `5` does **not** make callers fail fast at a busy pool — measured
  > since; see *Unreleased*. It bounds connection establishment only.
- `DB_DISABLE_PREPARE=true` is still the advice behind transaction pooling, now
  with the field counter-evidence recorded: one deployment saw `prepare: false`
  produce `unnamed prepared statement does not exist` where `prepare: true` had
  produced `bind message has N result formats but query has M columns`. Both
  modes can desync through that Bun/PgBouncer pairing; the advice is the better
  of two bad options, not a guarantee.

## 0.5.10 — 2026-07-26

Downstream ticket "locking, timeouts, and silent-no-op write paths"
(2026-07-25). Every item below failed **silently and in the safe-looking
direction**: a lock that reported acquired while stranded, a delete that
reported removed while writing nothing, a timeout that reported applied while
ignored, a projection that reported created while missing a column. The bias
across these fixes is to fail loudly.

### Added

- **Pluggable lock backends (B1)** — `LockBackend` with `postgres` (lease
  table `bunsane_locks`), `in-process`, and legacy `advisory` implementations,
  selected via `BUNSANE_LOCK_BACKEND` / `scheduler.lockBackend` (`auto` →
  `postgres`). The lease backend is **pooler-safe**: one autocommit statement
  per acquire/renew/release, owner-token fencing, `expires_at` crash recovery,
  heartbeat renew from `withLock`. This code was written on 2026-06-22 and
  never merged — 0.5.7–0.5.9 shipped only the advisory implementation, and the
  `docs/LOCKING.md` referenced by the changelog did not exist in the package.
  It does now.
- **Advisory-backend session-affinity guard (B1)** — `set_config` then read
  back on a separate statement; a lost value proves the connection has no
  session affinity and throws `UnsafeAdvisoryPoolingError` instead of stranding
  locks. Override with `BUNSANE_ALLOW_UNSAFE_ADVISORY_LOCK=true`.
- **Boot-time connection probe (B6)** — `probeConnection()` measures what the
  framework used to assume: `pg_backend_pid()` across separate statements
  (differing PIDs prove transaction pooling → logs what is unsafe there), and
  `SHOW statement_timeout` read back against `DB_STATEMENT_TIMEOUT` (mismatch
  logs at **error** with the `ALTER ROLE` remedy). Never throws.
- **Projection schema growth (B7)** — `SchemaSync` diffs the archetype
  descriptor against `information_schema.columns` on registration/sync, adds
  missing `rm_` columns, marks them `FILLING` in `projection_state.field_state`
  (the planner already excludes FILLING columns from coverage, filter, sort and
  hydration) and fills them for existing rows before flipping to `READY`.
  `addColumn` had existed with zero callers, so adding a projected field broke
  every dual-write on that archetype until someone ran `ALTER TABLE` by hand.
- `docs/POOLING.md` (what is and isn't safe behind `pool_mode = transaction`)
  and `docs/STANDALONE_SCRIPTS.md` (scripts are a supported execution mode —
  bootstrap and drain-before-exit).
- `Entity`-level `pendingSideEffectCount()` for drain assertions.

### Fixed

- **`Entity.delete()` silently no-oped outside the app lifecycle (B4)** —
  `EntityManager.deleteEntity` gated on a `dbReady` flag set only by the
  `DATABASE_READY` phase, which standalone scripts never emit. Deletes resolved
  `false`, wrote nothing, logged nothing — while `save()` in the same script
  worked, because it bypasses `EntityManager`. The gate is gone; `false` now
  means only "entity not persisted" and DB failures throw.
- **Post-delete side effects were unawaitable (B5)** — the delete path's
  fire-and-forget hooks + cache invalidation are now tracked in
  `pendingSideEffects`, so `Entity.drainPendingSideEffects()` and shutdown cover
  deletes. A script that deleted and exited could leave the write-through cache
  serving deleted rows.
- **Query timeouts abandoned the query instead of cancelling it (B2)** —
  `Query.exec/count/sum/average` rejected the caller's promise while the
  statement kept running server-side, holding a pooled backend and its locks;
  behind pgbouncer that compounds a slowdown into pool exhaustion. All four now
  run through `runWithTimeout`, which aborts `execSignal` (→ Bun SQL
  `query.cancel()`) before rejecting, the same mechanism the write path has
  used since `saveEntity`. Rejection messages unchanged.
- **`syncActiveProjections` logged `cannot register undefined` every 30 s
  (B3)** — rows without an archetype are skipped, and the query now passes an
  empty params array so it uses the extended protocol.

## 0.5.9 — 2026-06-30

### Fixed

- **Test-suite typecheck (`tsc --noEmit` green)** — 14 typecheck errors, all
  in test files using drifted APIs (the framework source was already clean),
  are fixed so a red typecheck can serve as a CI gate again. Notable: a
  types-only module augmentation (`tests/types/bun-test-timeout.d.ts`) restores
  the 2nd `timeout` arg on `bun:test` lifecycle hooks
  (`beforeAll`/`afterAll`/etc.), which `bun-types` declares as single-arg but
  Bun honors at runtime; `Entity.findById` → `Entity.FindById` casing fix in a
  benchmark (the old call was undefined at runtime, swallowed by a cleanup
  try/catch).

## 0.5.8 — 2026-06-29

### Fixed

- **`?|` / `?&` (`HAS_ANY` / `HAS_ALL`) JSONB array operators** — these
  builders bound a JS array directly to a `::text[]` parameter, but Bun SQL
  serializes a JS array bound to `text[]` into a brace-less CSV (`red,yellow`),
  so real PostgreSQL rejected it with `malformed array literal`. They now bind
  the values as a JSONB array parameter (the same reliable path
  `CONTAINS`/`CONTAINED_BY` already use — Bun serializes JS arrays to JSON
  reliably) and convert to `text[]` in SQL via
  `ARRAY(SELECT jsonb_array_elements_text($N::jsonb))`. The bug only ever
  surfaced on real PostgreSQL: PGlite doesn't support `?|`/`?&`, so the default
  zero-infrastructure (PGlite) test run never exercised the path. Verified on
  real PG17 (`Query.jsonbArray` 13/13 pass, was 4 failing).

### Added

- **Real-PostgreSQL test runner (`tests/pg-setup.ts`)** — PGlite cannot
  exercise real-PG-only paths (`?|`/`?&`, `CREATE INDEX CONCURRENTLY`, real
  LIST partitioning, Bun SQL parameter binding against a real backend), so
  regressions there pass the default zero-infra run — exactly how the
  `?|`/`?&` bug above stayed hidden. The new wrapper mirrors `pglite-setup.ts`:
  it provisions an ephemeral scratch database on a real Postgres server, runs
  `bun test` against it with prepared statements ENABLED over a DIRECT
  connection (never PgBouncer), then drops the scratch DB on exit. New scripts:
  `test:pg`, `test:pg:unit`, `test:pg:integration`, `test:pg:graphql`. Config
  comes from env vars `PG_TEST_URL`, `PG_DIRECT_PORT`, `PG_ADMIN_URL`,
  `BUNSANE_PG_DOCKER_CONTAINER`, all falling back to the gitignored `.env.test`.
  Full suite verified 915/915 green on real PG17.

## 0.5.7 — 2026-06-28

### Fixed

- **Type-aware indexes for legacy `@CompData({ indexed: true })` fields** —
  the historical default created a per-field GIN (`jsonb_path_ops`) for every
  indexed `@CompData` field, but that index only serves containment (`@>`), NOT
  the `data->>'field'` text equality / `ORDER BY` the Query builder actually
  emits. Scalar indexed fields therefore silently fell back to sequential scans
  — the "100× slow" symptom was a missing *usable* index, not framework
  overhead. Index creation now routes by value type: arrays/objects → GIN,
  numeric → a functional numeric index, everything else → btree on
  `(data->>'field')`. Obsolete scalar GIN indexes are dropped on startup
  (idempotent) to remove pure write amplification. No code change is required
  — existing `indexed: true` fields get the correct index automatically on next
  startup.

### Added

- **Materialized read models RFC** (`docs/RFC_MATERIALIZED_READ_MODELS.md`) —
  a CQRS read-side design for ERP/CRM workloads in three tiers (M1 `@CompData`
  projected → generated column, M2 `@ArcheType` materialize, M3 `@ReadModel`
  cross-entity). Includes a fair 3-way staging benchmark (PG17, 1M rows) that
  corrected the original headline: the 100–182× gap was the missing-index
  footgun fixed above, not a generated-column win (true M1 gain is only
  1.2–1.84×), so the index fix was re-prioritized as Phase 1.

## 0.5.5 — 2026-06-21

### Added

- **Native entity-column sort** — new Query methods sort directly on the
  `entities` table's native `created_at` / `updated_at` `timestamptz` columns,
  needing no component, no `.with()`, and no throw:
  `sortByCreatedAt(direction = "ASC", nullsFirst = false)`,
  `sortByUpdatedAt(...)`, and the general
  `sortByEntityField(field, direction, nullsFirst)`. They apply as an outer
  `ORDER BY` over the resolved id-set, so they compose with any `.with()` /
  filter combination, and are cheaper than duplicating the timestamp into a
  JSONB component and sorting `data->>'...'`. Native entity-column sort cannot
  be combined with a component `sortBy()` in the same query (throws a clear
  error).

- **Composite keyset cursor for sorted queries** —
  `Query.encodeSortedCursor(sortValue, entityId)` produces an opaque token from
  the last row of a page; `query.sortedCursor(token, direction = 'after')`
  resumes pagination via a composite keyset over `(sortValue, entityId)`.
  Covers entity-column sort and single-component `sortBy()`, ASC and DESC,
  including tie rows. Unsupported combinations throw clearly rather than
  returning silently wrong pages (OR queries, multi-key sort, `NULLS FIRST`,
  and the `'before'` direction for entity-column / component sort).

### Fixed

- **Stable sorted pagination (deterministic tiebreak)** — every sorted
  `ORDER BY` now ends in a unique `id ASC` key across all sort paths,
  eliminating duplicate or skipped rows in `OFFSET` pagination over tied sort
  keys.

## 0.5.4 — 2026-06-20

### Added

- **Single-pass OR query optimization** — a base-dependent OR query
  (`.with(X).with(or(...))`) now scans the base set ONCE and resolves the
  branches as an OR-of-`EXISTS`, instead of the previous N× base scans plus
  cartesian `UNION`. Default ON, with kill-switch env
  `BUNSANE_ORNODE_SINGLE_PASS=0`. Parity-proven; roughly 37× faster on real
  PG17 (~20× on PGlite) for the affected query shape.

- **Entity list endpoint — pagination + search** — the Studio Entity Inspector
  gained a paginated, searchable entity-listing endpoint at
  `GET /studio/api/entities`. Query parameters: `limit` (integer, clamped to
  1–1000, default 50), `offset` (integer, default 0), `search` (string,
  case-insensitive UUID substring match via `ILIKE`), and `include_deleted`
  (boolean string `"true"`, default false). Results are ordered by
  `created_at DESC NULLS LAST`; the JSON response shape is
  `{ entities, total, limit, offset }` where each entity carries
  `{ id, created_at, updated_at, deleted_at, component_count }`.

### Fixed

- **JSONB `IN` / `NOT_IN` type casting** — a new `jsonbInListCast` makes
  `FilterOp.IN` / `NOT_IN` work correctly against numeric and boolean JSONB
  values, which previously produced `text = integer` type errors (or silently
  wrong matches) in PostgreSQL; `OrNode` now uses the cast logic. Also fixes a
  pagination regression where OR query results were incorrectly limited to the
  first page.

- **Auto-migration of `timestamp` columns to `timestamptz`** —
  `DatabaseHelper` now migrates legacy `timestamp` columns to `timestamptz` on
  startup (idempotent), so entity `created_at` / `updated_at` are
  timezone-aware — required for correct native entity-column timestamp sorting
  (above).

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
