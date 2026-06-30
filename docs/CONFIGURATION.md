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
| `DB_QUERY_TIMEOUT` | `30000` (ms) | Client-side wall-clock timeout for `Query.exec/count/sum/average` and `Entity.save`. **JS-side only** — raises a client error and rolls back; it does *not* kill the server-side query (see `DB_STATEMENT_TIMEOUT`). |
| `DB_CONNECTION_TIMEOUT` | `30` (s) | How long the pool waits for a free connection before rejecting. Consider `5` for user-facing services so clients fail fast instead of queueing. |
| `DB_STATEMENT_TIMEOUT` | unset (opt-in, ms) | Server-side `statement_timeout` appended to the connection URL so PostgreSQL itself kills runaway queries. **Skipped under PgBouncer** (rejects startup parameters) and under PGlite. Set it server-side on the role instead when behind PgBouncer. |
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
| `HEALTH_DB_WRITE_PROBE` | `true` (on) | The `/health` and `/health/ready` endpoints run a real **write** probe through the same `db.transaction()` path `Entity.save` uses, so a wedged write pool fails liveness and the orchestrator restarts the container. Set `false` to disable (falls back to read-only `SELECT 1`). |
| `DB_HEALTH_WRITE_TIMEOUT` | `5000` (ms) | Independent, short timeout for the write probe so a wedge is detected fast rather than blocking on the 30s request timeout. |

See [Liveness & the write probe](#liveness--the-write-probe).

## Application / HTTP

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `3000` | HTTP listen port. |
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. Affects error verbosity, security headers, logging. |
| `SHUTDOWN_GRACE_PERIOD_MS` | framework default | Max time to drain in-flight requests on SIGTERM/SIGINT before forced shutdown. Also `app.setShutdownGracePeriod(ms)`. |
| `MAX_REQUEST_BODY_SIZE` | framework default | Max request body in bytes. Also `app.setMaxRequestBodySize(bytes)`. |

## GraphQL

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPHQL_MAX_DEPTH` | `15` floor | Max query depth. Hard floor of 15 — `0` no longer disables. Also `app.setGraphQLMaxDepth(n)`. |
| `GRAPHQL_MAX_COMPLEXITY` | `1000` | Max query complexity (per-field cost × `first`/`limit`/`take`). Also `app.setGraphQLMaxComplexity(n)`. |

## Query engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BUNSANE_DEFAULT_QUERY_LIMIT` | `10000` | Default `LIMIT` applied to `Query.exec()` calls with no `.take()`. `0` disables. Emits warning `H-QUERY-1` when applied. |
| `BUNSANE_USE_LATERAL_JOINS` | `true` | Use LATERAL joins for multi-component queries (PG12+). |
| `BUNSANE_PARTITION_STRATEGY` | `list` | Component partition strategy: `list` or `hash`. ⚠ Changing on an existing DB is guarded against data loss. |
| `BUNSANE_USE_DIRECT_PARTITION` | `true` | Query partition tables directly. |
| `BUNSANE_FORCE_PARTITION_RECREATE` | `false` | ⚠ Destructive — recreates partitions. Dev/migration use only. |
| `BUNSANE_DB_SLOW_MS` | framework default | Slow-query log threshold (ms). |
| `BUNSANE_COMPONENTS_DATA_GIN` | `false` | `true` creates the whole-`data` GIN index (`idx_components_data_gin`) on the `components` table. Off by default: the Query layer serves all filters/sorts from per-field indexes and never emits top-level `data @>` / `data ?` containment, so this index is pure write amplification and blocks HOT updates. Enable **only** if you run raw SQL doing top-level JSONB containment on the whole component payload. A pre-existing DB that still has it: `DROP INDEX CONCURRENTLY IF EXISTS idx_components_data_gin;`. |
| `BUNSANE_MEMBERSHIP_SOURCE` | `components` | Component membership source table (internal). |
| `BUNSANE_ORNODE_SINGLE_PASS` | `1` (on) | OR queries over a required base (`.with(X).with(or([...]))`) scan the base set **once** and combine branches as a disjunction of `EXISTS` predicates, instead of embedding the base in every branch and `UNION`-ing (which forced an N× base scan + a per-branch cartesian nested-loop). Parity-proven against the legacy shape; ~20× faster on a 3-branch OR. Kill-switch: set to `0`/`false` to revert to the legacy `UNION` shape instantly (no redeploy). |
| `BUNSANE_RELATION_TYPED_COLUMN` | — | Typed relation column toggle (internal). |

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
| `CACHE_COMPONENT_NEGATIVE_ENABLED` | `false` | Cache "component missing" results. |
| `CACHE_COMPONENT_NEGATIVE_TTL` | unset | Negative component cache TTL. |
| `CACHE_RELATION_NEGATIVE_ENABLED` | `false` | Cache empty relation results. |
| `CACHE_RELATION_NEGATIVE_TTL` | `60000` | Negative relation cache TTL (60s). |
| `CACHE_QUERY_ENABLED` | `true` | Query result cache. |
| `CACHE_QUERY_TTL` | `1800000` | Query cache TTL (30m). |
| `CACHE_QUERY_MAX_SIZE` | `10000` | Max cached query results. |

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

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level. |
| `LOG_PRETTY` | — | Pretty-print logs (dev). |
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

Running BunSane behind PgBouncer in **transaction pooling mode**
(`pool_mode=transaction`) requires two settings, or the write path can wedge.

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
> This does **not** relate to the framework's `PreparedStatementCache` class,
> which is deprecated and a no-op on the hot path — toggling it has no effect.

### 2. Server-side statement timeout (set on the role, not the app)

`DB_STATEMENT_TIMEOUT` is skipped under PgBouncer because PgBouncer rejects the
startup parameter. Instead, set the timeout server-side so PostgreSQL kills
runaway queries even when the app cannot:

```sql
ALTER ROLE myapp SET statement_timeout = '15s';
ALTER ROLE myapp SET idle_in_transaction_session_timeout = '30s';
```

And on PgBouncer, lower `query_wait_timeout` (e.g. `30`) so a drained pool
fails fast rather than hanging.

### Recommended PgBouncer env block

```env
DB_CONNECTION_URL=postgres://myapp:***@pgbouncer:6432/mydb
DB_DISABLE_PREPARE=true
DB_CONNECTION_TIMEOUT=5
# DB_STATEMENT_TIMEOUT intentionally unset — set statement_timeout on the PG role
```

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
| `/health` | Deep health (DB read + DB write probe + cache). Drives liveness/restart. |
| `/health/ready` | Readiness — 503 until `init()` completes and while shutting down; otherwise same deep check. |
| `/health/remote` | Remote subsystem health (only when `app.enableRemote()` used). |
| `/metrics` | Process + cache + DB stats (JSON). |
