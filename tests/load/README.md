# k6 Load Test

End-to-end HTTP load test: boots a full BunSane app (`init()` → auto-serve) with
a REST service that drives the real `Entity.save` / `Query` paths, then hammers
it with [k6](https://k6.io). Measures the **whole stack** (HTTP + router +
Entity + DB), complementing the in-process `tests/stress` harness (which calls
the Query layer directly).

## Files
- `load-server.ts` — the app under test. Endpoints: `POST /load/write`,
  `POST /load/update`, `GET /load/read`, `GET /load/gin?on=true|false`,
  `POST /load/seed?n=N`, `POST /load/cleanup`.
- `k6-load.js` — three tagged scenarios (read / update / write), per-op p95
  thresholds.

## Run against a throwaway Docker Postgres (recommended)

```bash
# 1. fresh isolated PG (no risk to your dev DB)
docker run -d --name bunsane-load-pg \
  -e POSTGRES_USER=loaduser -e POSTGRES_PASSWORD=loadpw -e POSTGRES_DB=loaddb \
  -p 55432:5432 postgres:16-alpine

# 2. boot the load server (it AUTO-serves via init() — do NOT also call start())
DB_CONNECTION_URL=postgres://loaduser:loadpw@localhost:55432/loaddb \
POSTGRES_HOST=localhost POSTGRES_PORT=55432 POSTGRES_DB=loaddb \
POSTGRES_USER=loaduser POSTGRES_PASSWORD=loadpw POSTGRES_MAX_CONNECTIONS=50 \
LOG_LEVEL=warn CACHE_PROVIDER=noop CACHE_ENABLED=false \
BUNSANE_PARTITION_STRATEGY=hash BUNSANE_USE_DIRECT_PARTITION=false \
APP_PORT=19914 LOAD_SEED=2000 \
  bun tests/load/load-server.ts

# 3. load it (separate shell)
BASE_URL=http://localhost:19914 DURATION=15s VUS=20 k6 run tests/load/k6-load.js

# 4. A/B the whole-data GIN without restart
curl "http://localhost:19914/load/gin?on=true"  && k6 run tests/load/k6-load.js
curl "http://localhost:19914/load/gin?on=false" && k6 run tests/load/k6-load.js

# 5. teardown
docker rm -f bunsane-load-pg
```

## Gotchas (learned the hard way)
- **Don't call `app.start()` after `app.init()`** — `init()` drives the
  lifecycle to `APPLICATION_READY`, which auto-calls `start()`
  (`core/app/bootstrap.ts`). Calling it again double-binds `APP_PORT`
  (`EADDRINUSE`). `load-server.ts` only calls `init()`.
- **`BUNSANE_PARTITION_STRATEGY=hash` requires `BUNSANE_USE_DIRECT_PARTITION=false`.**
  Direct-partition mode reads per-component tables (`components_<name>`) that
  only exist under `list`. Under `hash`, queries must read the parent
  `components` by `type_id`. Symptom otherwise: `relation
  "components_stressuser" does not exist` on reads (writes still work).
- Use `NODE_ENV=development` to get the real error `message` in 500 bodies.

## Baseline result (2026-06-16, Docker PG, 2000 seeded, 20 VUs, 15s)
Hash partitions, cache off, ~5.2k req/s, 0% errors.

| op     | p95 (GIN off) | p95 (GIN on) |
|--------|---------------|--------------|
| read   | 7.46 ms       | 7.46 ms      |
| write  | 18.96 ms      | 18.90 ms     |
| update | 22.47 ms      | 22.10 ms     |

**Read of the A/B:** at this scale the whole-data GIN is in the noise over HTTP —
per-request overhead (HTTP + txn round-trip + `FindById` on update) dominates,
diluting the index-maintenance cost that the in-process micro-benchmark isolates
as +30%. The GIN write tax shows up under **high write throughput on large
tables / bulk ingest**, not modest mixed HTTP load. To surface it here, seed to
millions and shift the VU mix write-heavy.
