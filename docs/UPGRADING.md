# Upgrading

## 0.8 → 0.9 (unreleased)

Some call sites throw, and tie order changes. Indexing and list plans also change on first boot. Details: [CHANGELOG.md](../CHANGELOG.md) `## Unreleased`. npm `latest` is still 0.6.1; this section is unreleased `main` (`package.json` still says `0.8.0`).

### Code that throws or changes order

| Change | What to look for |
|---|---|
| `.cursor(id)` with `sortByCreatedAt` / `sortByUpdatedAt` throws | Calls that paged an entity-timestamp sort by id. Use `sortedCursor` and `Query.encodeSortedCursor`. (`.sortBy().cursor(id)` already threw in 0.8.) |
| Ties follow the sort direction | Equal sort values are ordered by entity id in that direction (`DESC` breaks ties by `entity_id DESC`; 0.8 always used ASC). Applies to component sorts, `sortByCreatedAt` / `sortByUpdatedAt`, OR + sort, multi-key sorts (the last key's direction), and QSP `rm_` routes. A 0.8 cursor that ends inside a tie group may repeat or skip rows of that group once. |
| Entity timestamps are UTC milliseconds on every page | `sortByCreatedAt` / `sortByUpdatedAt` page 1 used raw microseconds and keyset pages used milliseconds. Both now use milliseconds. Sub-millisecond ties fall to entity id, in the sort direction. |
| Entity-timestamp sorts with membership exclude soft-deleted entities | `sortByCreatedAt` / `sortByUpdatedAt` combined with `.with()`, OR, or `.without()` now require `entities.deleted_at IS NULL`. A list that showed soft-deleted rows drops them. |
| Non-numeric text in a numeric field is NULL | Sorting or filtering a number field that holds `"n/a"` used to fail with `invalid input syntax for type numeric`. It now sorts and filters as a missing value. |
| DESC keyset under NULLS LAST includes rows with no value | Pages after a non-null cursor used to end before the NULL tail. They now return those rows (component sorts, OR + sort, QSP). |
| Sorting by a field with no key index | Still a full scan plus top-N. In development a one-time warning names the field. Add `@CompData({ indexed: true })`, or `@CompositeIndex(["status", "total"])` when you filter on one field and sort or range on the next field of the same component. `@CompositeIndex` is a root-barrel export and needs at least two fields. An unknown field fails boot. |

### What happens on first boot

- `init()` creates `bunsane_num_v1` (IMMUTABLE numeric-or-NULL; never `CREATE OR REPLACE`) and a `bk_<slug>_<hash>` key index for every scalar `@CompData({ indexed: true })` and `@IndexedField("btree" | "numeric")` field, plus `created_at` / `updated_at` keys on `entities`. The index is `((key), entity_id)`, not partial, so the planner keeps expression statistics. `@IndexedField` is not on the root barrel (`bunsane/core/decorators/IndexedField`). Its default type is `"gin"`, which is not a sort key.
- The index reconciler (`database/indexReconciler.ts`) creates missing `bk_` indexes (`CONCURRENTLY` on real PostgreSQL, not PGlite), rebuilds invalid ones, and drops a legacy `idx_<leaf>_<field>_btree` / `_btree_date` / `_numeric` (and scalar `_gin`) index only after a valid `bk_` replacement exists. QSP's `idx_rm_<archetype>__cover` is dropped the same way. Indexes without the `bk_` prefix are left alone, except those known legacy names. An explicit `@IndexedField("gin")` on a key field survives boot.
- Tables estimated below `BUNSANE_INDEX_SYNC_MAX_ROWS` (100 000) are indexed during `init()`. Bigger tables, and unanalyzed tables larger than 64 MB, are indexed by a background task after `init()` under `withLock("bunsane:index-reconcile")` (one instance at a time). Lists stay correct but are not yet fast until that finishes (logged at info). Shutdown does not wait past the grace budget. A component `register()` after boot still gets key indexes.
- Plan for the disk and I/O of one index build per indexed field on large tables. `CREATE INDEX CONCURRENTLY` does not block writes.
- Invalid `BUNSANE_INDEX_SYNC_MAX_ROWS` or `BUNSANE_ENTITY_SORT_PROBE` fails `init()`. See [CONFIGURATION.md](CONFIGURATION.md#query-engine).

These helpers are removed: `ensureNumericIndex`, `ensureCompositeIndex`, `ensureLegacyIndexedFields`, `pickScalarIndexType`, `createCoveringIndex`, and `database/numericJsonField.ts`.

### Query plans

Call sites stay the same. The SQL does not.

- A single-key sort on a key field walks the index and stops at the limit: two ordered branches (non-null keys, then NULL keys, or the reverse when `nullsFirst` is set) and row-comparison keyset predicates.
- Unsorted multi-component pages and `count()` use a driving leaf plus `EXISTS`. They no longer emit `INTERSECT`.
- `sortByCreatedAt` / `sortByUpdatedAt` with no `.with()`, OR, or `.without()` is index-driven (`getLastRouteInfo().entitySortPlan === 'index'`), including both timestamps together. With membership, a single entity sort runs an adaptive probe over `min(cap, max(64, ceil(4 × pageLimit / componentShare)))`, capped by `BUNSANE_ENTITY_SORT_PROBE` (default 5000). The probe is kept (`'probe'`) when that window is exhausted or the page is full, so a short page from an exhausted window is the answer. It falls back to hash join plus top-N (`'fallback'`) only when the window was not exhausted and the page did not fill. `OFFSET > 0`, an estimate over the cap, and `sortByCreatedAt()` plus `sortByUpdatedAt()` together with membership skip the probe and are `'fallback'`. When the component's rows are clustered in time, that fallback is the 0.8 plan plus ~10% (see CHANGELOG `## Unreleased`); use QSP for that list.
- QSP `rm_` routes use the same ordering and keyset builder and per-column `bk_` indexes. `before` cursors and keyset plus `nullsFirst` now route when the query is otherwise covered. Multi-key sorts still do not route.
- Numeric filters compare `bunsane_num_v1(data->>'f')` instead of restating a regex predicate.

### Other behavior changes

- **Scoped QSP rollout auto-backfills.** If you set `BUNSANE_QSP_ARCHETYPES`, those archetypes used to be pre-registered `DISABLED` at boot and stayed that way until you called `runBackfill` by hand. They now backfill automatically on the boot that registers them (a new `projection_state` row starts `BACKFILLING`), same as the unscoped lazy path. An existing row — including one already `DISABLED` from before this fix — keeps its status; `runBackfill("<Archetype>")` (or `UPDATE projection_state SET status='BACKFILLING' WHERE archetype='<Archetype>'` plus a restart) still picks it up by hand. See `docs/QSP_OPERATIONS.md`.
- **Caller-transaction saves wait for the caller's commit.** `entity.save(trx)` / `saveMany(..., { trx })` where `trx` came from `db.transaction` / `db.begin` / `getDb().transaction|begin` / `dbTransaction`, or from `trx.savepoint(...)` on one of those: cache invalidation and `entity.created`/`entity.updated` hooks now run after the outer transaction's `COMMIT`, and are skipped if that transaction (or the savepoint the save ran in) rolls back. A rollback also restores the entity's dirty/persisted flags so a retried `save()` reissues every statement, instead of silently seeing a "clean" entity. This does not apply to untracked handles (`sql.reserve()`, a transaction handle used after it already ended), which behave as before.

---

## 0.6.x → 0.8

0.7.0 and 0.8.0 were cut on the same day. There is no reason to stop at 0.7. This section covers both. If you are moving onto current `main`, finish this section and then apply the 0.8 → 0.9 section above. npm `latest` is still 0.6.1; v0.7.0 and v0.8.0 are GitHub tags. The full list is in [CHANGELOG.md](../CHANGELOG.md) (`## 0.8.0`, `## 0.7.0`).

No manual SQL migration is needed. `App.init()` creates the new read-model tables it needs; existing tables are unchanged. What does need attention is configuration (several endpoints and features are now closed by default), a handful of code patterns that now throw instead of silently doing the wrong thing, and the rollout order if you run more than one instance.

### Checklist

1. [Set the new environment variables](#1-environment) before deploying.
2. Install the GitHub tag (`bun add github:yaaruu/bunsane#v0.8.0`) or `main` for unreleased 0.9, then `bunx tsc --noEmit` and [fix what the compiler finds](#2-code-changes-the-compiler-finds).
3. Boot once with `NODE_ENV=development` and [fix what schema build and queries throw](#3-code-changes-that-throw-at-boot-or-at-runtime).
4. [Update your tests](#4-tests).
5. [Tell GraphQL/HTTP clients](#5-client-visible-changes) what changed.
6. [Roll out in the right order](#6-rolling-out-to-several-instances) if you run more than one instance.

---

### 1. Environment

Full reference: [CONFIGURATION.md](CONFIGURATION.md).

#### Always set `NODE_ENV`

Unset `NODE_ENV` is now treated as fail-closed (errors masked, info endpoints closed) and logs a boot warning. Set it explicitly: `production`, `development`, or `test`.

#### Endpoints that are now closed by default

| Endpoint | 0.6 | 0.8 | To reopen |
|---|---|---|---|
| `/metrics`, `/health/remote` | open | 404 | `BUNSANE_METRICS_TOKEN=<16+ chars>` (send `Authorization: Bearer …` or `x-metrics-token`), or `BUNSANE_METRICS=public` |
| `/docs`, `/openapi.json` | open | 404 | `BUNSANE_DOCS_TOKEN=<16+ chars>` (`Authorization: Bearer …` or `x-docs-token`), or `BUNSANE_DOCS=public` |
| GraphQL introspection, GraphiQL | on | on only in `NODE_ENV=development` | `GRAPHQL_INTROSPECTION=on`, `GRAPHQL_GRAPHIQL=on` |

If Prometheus or another scraper reads `/metrics`, give it the token before you deploy, or its scrapes will get 404.

`/health` no longer returns `uptime` or per-check `latency_ms`. Status fields are unchanged. Liveness probes keep working.

#### Multi-instance apps: cache invalidation secret

```bash
BUNSANE_CACHE_INVALIDATION_SECRET=<same random value on every instance>
```

Cross-instance L1 invalidation over Redis pub/sub is now HMAC-signed. **Without the secret, pub/sub is disabled** (one warning at boot) and each instance serves its own L1 entries until TTL. Single-instance apps can ignore this.

#### Remote/RPC: envelope signing (optional, but read §6 first)

`BUNSANE_RPC_SECRET` signs RPC and outbox envelopes. Once it is set, consumers **ACK-drop** unsigned envelopes, and ACK-dropped messages are lost. Do not set it until every producer and consumer is on 0.8. See [§6](#6-rolling-out-to-several-instances).

#### Redis TLS now actually applies

In 0.6, `REDIS_TLS=true` did nothing. In 0.8 it connects the cache and remote clients over TLS with certificate verification on. If you had `REDIS_TLS=true` set against a plaintext Redis, the connection now fails. Remove the variable, or set `REDIS_TLS_REJECT_UNAUTHORIZED=false` / `REDIS_TLS_SERVERNAME=…` for self-signed or SNI setups. `REDIS_USERNAME` is sent when set.

#### Request limits

| Limit | 0.6 | 0.8 | Knob |
|---|---|---|---|
| JSON / non-multipart body | 50 MB | **1 MB** (413 by `Content-Length`) | `JSON_BODY_LIMIT`, `app.setJsonBodyLimit()` |
| Multipart body | 50 MB | 50 MB; **411 without `Content-Length`** | `MULTIPART_BODY_LIMIT`, `app.setMultipartBodyLimit()` |
| Request wall clock | 30 s, fixed | 30 s, configurable | `REQUEST_TIMEOUT_MS` (`0` = off), `app.setRequestTimeout()` |
| GraphQL depth | configurable, `0` disabled | default 15; values `< 15` throw; `0` no longer disables | `GRAPHQL_MAX_DEPTH`, `app.setGraphQLMaxDepth()` |
| GraphQL complexity | `0` disabled | `0` no longer disables | `GRAPHQL_MAX_COMPLEXITY` |

Raise `JSON_BODY_LIMIT` if you accept large JSON payloads, such as bulk imports or base64 uploads. Browsers and `fetch(url, { body: formData })` always send `Content-Length`, so the 411 rule only affects hand-rolled streaming clients.

#### Rate limiting behind a proxy

`rateLimit()` now keys by the socket IP by default and ignores `X-Forwarded-For`. Behind a load balancer every request has the proxy's IP, so all clients share **one bucket**. If you are behind a trusted proxy that sets `X-Forwarded-For`, opt in:

```ts
app.use(rateLimit({ max: 100, windowMs: 60_000, trustProxy: true }));
```

#### HSTS

`NODE_ENV=production` no longer sends `Strict-Transport-Security` by itself. Set `BUNSANE_HSTS=on` (or `BUNSANE_TLS=on`) if you relied on it.

#### Negative component cache is on

`CACHE_COMPONENT_NEGATIVE_ENABLED` now defaults to `true`. Absent optional components are cached as tombstones (60 s default TTL, overwritten by the next save). Set it to `false` to restore 0.6 behaviour.

#### Strict mode (recommended for production)

`BUNSANE_STRICT_ENV=on` turns the boot warnings above into startup failures: unset `NODE_ENV`, production Redis without a password, or production Redis on a non-loopback host without TLS.

---

### 2. Code changes the compiler finds

Run `bunx tsc --noEmit`. Expect errors in these places.

#### Imports

Most app code can now import from the package root:

```ts
import { App, Entity, BaseComponent, Component, CompData, BaseArcheType, ArcheType,
         ArcheTypeField, Query, FilterOp, BaseService, GraphQLOperation, t,
         type InferInput, logger, withLock, ScheduledTask, rateLimit } from "bunsane";
```

Deep paths still resolve (`bunsane/core/...`, `bunsane/database`, …). These modules and exports were **removed**:

| Removed | Use instead |
|---|---|
| `core/decorators/ScheduledTask.ts` | `ScheduledTask` from `"bunsane"` (or `bunsane/scheduler`) |
| `BatchLoader`, `PreparedStatementCache`, `core/app/preparedStatementWarmup.ts` | nothing; request DataLoaders and the driver cover it |
| `gql/ArchetypeOperations.ts`, `enableArchetypeOperations` | explicit `@GraphQLOperation` methods |
| `TypeGenerationStrategy`, `InputTypeBuilder`, `TypeDefBuilder`, `GraphQLFieldTypes`, `TypeFromGraphQL`, `ResolverInput` | `t.*` schema DSL |
| the import-time `yoga` export | the app builds Yoga in `init()` |
| `rest/Generator.ts`, `types/app.types.ts` | — |
| `DatabaseHelper.UpdateComponentIndexes` | indexes are managed at boot |
| downgrade helpers in `DatabaseHelper` | `bunsane/database/maintenance` |
| `Query.getCacheStats()` | — |
| upload flags `generateThumbnails`, `imageProcessing`, `scanForMalware` (never implemented) | delete them from your config |
| `relationsByEntityField` | FK-less relations are resolved by component FK (see §3) |

#### `db` is a lazy proxy

The default export of `bunsane/database` is created on first use. Calls work unchanged, but `db === getDb()` is false and `db instanceof SQL` fails. When you need the real instance (identity checks, passing it to a library that inspects it), use `getDb()`:

```ts
import { getDb } from "bunsane/database";
```

#### Typed `Query`

`Query<TComponents, TPopulated>` now tracks what was loaded. `componentData` is typed as fully loaded only after `.populate()`; otherwise every component is optional. Two consequences:

```ts
// Chain it: populate() returns the populated type.
const rows = await new Query().with(Profile).populate().take(20).exec();
rows[0].componentData.Profile.name; // typed, loaded

// This loses the type (and reads as optional):
const q = new Query().with(Profile);
q.populate();
const rows2 = await q.exec();
rows2[0].componentData.Profile?.name;
```

Filter field names are checked against the component's keys. Build filter lists with `Query.filters(...)` so literal types survive:

```ts
.with(Order, Query.filters(Query.filter("status", FilterOp.EQ, "paid")))
```

#### Typed `@GraphQLOperation`

With a `t.*` input, the method is type-checked against the input and output. Use `InferInput`:

```ts
const input = { id: t.id().required() };

@GraphQLOperation({ type: "Query", input, output: User })
async user(args: InferInput<typeof input>) { … }
```

Archetype classes are accepted as `output`. String-map and Zod inputs still work, but they log a deprecation warning and will be removed before 1.0. Move them to `t.*` now.

#### Batched `@ArcheTypeFunction` has its own signature

This is opt-in (see [§7](#7-worth-adopting)). If you add `batch: true`, the method must be `(parents, ctx, args?) => Promise<Map<entityId, value>>`; the compiler rejects the per-entity form.

---

### 3. Code changes that throw at boot or at runtime

These compile but fail when run. Boot once with `NODE_ENV=development` to surface them.

#### GraphQL schema build fails loudly

0.6 guessed a type (`String`, `[Any]`) and moved on. 0.8 throws at schema build when:

- a `@GraphQLOperation` `output` is not a recognised type (archetype class, archetype name, `t.*` schema, or a scalar);
- a relation points at an archetype that is not registered;
- an `@ArcheTypeFunction` has no usable return type (set `returnType`);
- a `t.*` input or operation-input name is not a valid GraphQL identifier.

SDL generation also changed in ways clients can see ([§5](#5-client-visible-changes)): the `Date` scalar is used only for `z.date()` / `Date` properties (no more guessing from names like `*_at`), and `ID` is used only for archetype `id` fields.

#### Relations without `foreignKey`

`@HasMany` / `@HasOne` / `@BelongsTo` without `foreignKey` must now match **exactly one** `user_id` or `parent_id` property. The search runs over the components of the archetype that holds the key: the related archetype for `@HasMany` / `@HasOne` / `@BelongsToMany`, and this archetype for `@BelongsTo`. Zero or several matches fail schema build with a message naming the relation and the candidates. Fix it by being explicit. The part before the dot is the **archetype field** that holds the component, not the component class name:

```ts
@ArcheType()
class OrderArch extends BaseArcheType {
    @ArcheTypeField(OrderInfo) order!: OrderInfo;   // OrderInfo has @CompData() userId
}

@ArcheType()
class UserArch extends BaseArcheType {
    @HasMany("OrderArch", { foreignKey: "order.userId" })   // "<field on OrderArch>.<property>"
    orders!: OrderArch[];
}
```

`@HasOne` is nullable in SDL unless you pass `nullable: false`. The child is resolved through the related archetype's foreign key (batched), and a missing child resolves to `null`.

#### Entity reads throw on failure

| Call | 0.6 | 0.8 |
|---|---|---|
| `entity.get(C)` on a DB error or abort | `null` | throws `ComponentLoadError` |
| `entity.getOrThrow(C)`, component absent | throws | throws `ComponentMissingError` (same message) |
| relation DataLoader on a DB error | `[]` | rejects |

Code that treated `null` as "absent **or** failed" now sees the failure. Catch `ComponentLoadError` where a fallback is actually correct:

```ts
import { ComponentLoadError } from "bunsane/core/entity/errors";
```

#### Other behaviour changes

- **`entity.remove(C)` on a component that was never loaded** now returns `true` and deletes the row on `save()`. In 0.6 it returned `false` and left the row.
- **`updated_at` moves.** Saves that change components bump `entities.updated_at` and `components.updated_at`. `sortByUpdatedAt` now means last modified, not creation order.
- **Unbounded `Query.exec()` in development.** A query without `.take()` that fills `BUNSANE_DEFAULT_QUERY_LIMIT` (10000) **throws** under `NODE_ENV=development`. Production logs once and sets `getLastRouteInfo().truncatedByDefaultLimit`. Add `.take(n)` or paginate.
- **Boolean filters compare JSON text.** `data->>'f' = 'true'`. Values stored as the strings `"yes"`, `"1"`, `"t"` no longer match `true`. To find stragglers:

  ```sql
  SELECT entity_id, data->'active' FROM components
  WHERE data ? 'active' AND jsonb_typeof(data->'active') <> 'boolean';
  ```

- **Sorted cursors.** `sortedCursor(token)` requires one value per sort key, and calling it without a sort throws. Existing single-key tokens still decode, so clients holding cursors across the deploy keep working. `.sortBy(...).cursor(entityId)` (id cursor with a sort) throws; use `sortedCursor`.
- **App lifecycle.** `app.use()` after `start()` throws. Register middleware before `init()` / `start()`. A second `start()` is a no-op.
- **Hooks.** `async: true` hooks are no longer awaited on the save path. Errors are logged, and shutdown still drains them. If a caller depended on the hook having finished when `save()` resolved, make that hook synchronous.
- **Scheduler.** `@ScheduledTask` queries without `maxEntitiesPerExecution` process at most 1000 entities per run. Set it explicitly for bigger batches.
- **Locks.** Advisory lock tokens are random per acquisition. Re-acquiring a key this instance already holds returns `null`.
- **`withIndexHint`** names must match `^[A-Za-z0-9_]+$`.
- **Cache.** `invalidatePattern` needs a literal prefix and aborts past `BUNSANE_CACHE_INVALIDATE_MAX` keys (10000).
- **Timeouts on previously unbounded paths.** M3 read-model reads and write-through now go through the DB gateway, so they can fail with `DbStatementTimeoutError` / `DbAdmissionTimeoutError` (from `bunsane/database/gateway`) under the request-lane deadline.

#### M3 read models (`@ReadModel`)

- `ReadModel(T).rows()` / `.listPage()` throw when `.limit()` or `.offset()` is set without `.orderBy(...)`:

  ```ts
  await ReadModel(InvoiceReport).orderBy("issuedAt", "DESC").limit(50).offset(100).rows();
  const { nodes, hasNextPage } = await ReadModel(InvoiceReport).orderBy("total", "DESC").limit(50).listPage();
  ```

- GraphQL list fields return a page instead of a list (see [§5](#5-client-visible-changes)).

---

### 4. Tests

- **Multipart in-process requests need `Content-Length`.** `new Request(url, { body: formData })` built in-process has no length header, so it gets 411. Serialize the form first:

  ```ts
  const draft = new Request(url, { method: "POST", body: formData });
  const contentType = draft.headers.get("content-type")!; // read before consuming the body
  const bytes = await draft.arrayBuffer();
  const req = new Request(url, {
      method: "POST",
      body: bytes,
      headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
  });
  ```

- **Introspection is off under `NODE_ENV=test`.** Tests that introspect the schema over HTTP need `GRAPHQL_INTROSPECTION=on` or `app.setGraphQLIntrospection(true)`.
- **Close the pool between test files** that start and stop an app: `await closeDatabase()` (from `bunsane/database`). App shutdown does this for you. A later file then opens a fresh pool instead of hitting a closed one.
- **Info endpoint tests** (`/metrics`, `/docs`) need the token or the `public` switch.

---

### 5. Client-visible changes

Share this with frontend and integration owners.

| Change | Impact |
|---|---|
| Introspection off outside development | GraphQL codegen or IDE plugins pointed at production fail. Point them at a development instance, or set `GRAPHQL_INTROSPECTION=on` for that environment. |
| `@HasOne` fields are nullable | Generated client types become optional. |
| `ID` only on archetype `id` fields | Other `id: String` fields stay `String`, which may change generated types. |
| `Date` scalar only for real `Date` properties | Fields that were `Date` because of their name (`*_at`, `date*`) become `String` unless typed as `Date` / `z.date()`. |
| M3 list fields return `XPage { nodes, hasNextPage }` | Queries must select `nodes { … }`. New args: `offset`, `orderBy`, `direction`; `offset + limit ≤ 10000`. |
| JSON body limit 1 MB | Larger bodies get 413. |
| Multipart without `Content-Length` | 411 `{ "error": "Length Required", "code": "LENGTH_REQUIRED", "limit" }`. |
| Depth ≥ 15 always enforced | Very deep queries that passed with depth disabled now fail. |
| Unrecognised `@GraphQLOperation` output | Schema build throws instead of emitting `String` / `[Any]`. Fix the `output` before clients can query. |

---

### 6. Rolling out to several instances

Old and new instances can serve traffic side by side, with two exceptions.

1. **Cache invalidation.** 0.8 instances accept only signed invalidations (and only when the secret is set); 0.6 instances send unsigned ones. During the rollout, do not expect invalidations to cross versions: an entry cached on one side can be stale until its TTL (`CACHE_COMPONENT_TTL`, 30 min by default). Keep the rollout window short, or lower the TTL for the deploy. Set `BUNSANE_CACHE_INVALIDATION_SECRET` on **every** 0.8 instance, to the same value.
2. **RPC / outbox signing.** Deploy 0.8 everywhere **without** `BUNSANE_RPC_SECRET` first. One variable controls both signing and verifying, so turning it on is a second rollout with its own mixed window: instances that already have the secret ACK-drop the unsigned envelopes still sent by instances that don't. Those messages are lost, not retried. To avoid loss, flip it on every instance at once (stop and start, not rolling), or pause remote producers while the rollout runs.

---

### 7. Worth adopting

Not required, but these are where most of the 0.7 performance gains are. Measurements: [internal/BENCHMARK_0.7.md](internal/BENCHMARK_0.7.md). Headlines on 100k entities: single-field sorted lists −88% p50, keyset next page −89%, GraphQL lists with relations −81%.

- **Batched computed fields.** One call per request instead of one per parent (a 50-row list went from 54 statements to 5):

  ```ts
  @ArcheTypeFunction({ returnType: "number", batch: true })
  async orderCount(parents: readonly Entity[], ctx: unknown): Promise<Map<string, number>> {
      const counts = await countOrdersByUser(parents.map((p) => p.id)); // one grouped query
      return new Map(parents.map((p) => [p.id, counts.get(p.id) ?? 0]));
  }
  ```

  A parent missing from the map resolves to `null`. Function fields are nullable; there is no option that makes a missing key an error. If the method throws, every parent in the batch rejects.
- **Multi-key keyset pagination.** `sortedCursor` supports several sort keys, mixed directions, and `'before'`. Encode with `Query.encodeSortedCursor([k1, k2], lastId)`.
- **Drop `registerFieldResolvers` calls.** Field, relation, and function resolvers attach at schema build. The call is still harmless.
- **`Entity.saveMany(entities)`** saves in one transaction with batched writes.
- **`AppConfig`**: `new App({ … })` instead of chains of setters, merged over env.
- **`t.*` inputs** everywhere, before the string-map and Zod forms are removed.

---

### 8. After the upgrade

- `bunx tsc --noEmit` is clean.
- Boot logs have no warnings about `NODE_ENV`, the cache invalidation secret, Redis TLS, or `rateLimit` failing open.
- `/health` returns 200. `/metrics` returns 200 when the request carries `BUNSANE_METRICS_TOKEN`. With that token configured, a missing or wrong header is 401. 404 is only when no token is configured and the route is not `public`.
- A GraphQL smoke query over your main lists returns the same data as before. Compare statement counts via `/metrics` if you track them.
- In development, look for `truncatedByDefaultLimit` throws on list endpoints and add `.take()` where they fire.
