# Read-Path Performance: Filtered + Sorted + Paginated List Queries

**Status:** Canonical analysis + measurement guide + shipped roadmap (0.6.x)
**Date:** 2026-08-07 (updated for Wave A/B engine work + product guidance)
**Scope:** The query READ path only (`Query` builder → SQL → hydrate). Writes (`Entity.save`) are out of scope except QSP dual-write.
**Audience:** framework maintainers **and** app authors building list/admin endpoints.
**Related:** `docs/QSP_OPERATIONS.md`, `docs/QUERY_LIST_GUIDE.md`, `docs/internal/TICKETS_READ_PATH_PERF_2026-08.md`, `docs/CONFIGURATION.md`

---

## 1. TL;DR

Writes are fast. The pain is the **filtered + sorted + paginated list read** — the "page 3 of open orders for gold-tier customers, sorted by total" query behind every ERP/CRM/admin list screen.

Root cause is structural: a logical record's fields are scattered across **multiple JSONB component rows** (one partition row per component type). A predicate that a relational schema serves with **one composite-index range scan** becomes, in the ECS model, **N index probes + a set INTERSECT + a join**. Postgres cannot build a single covering index over fields that live in different physical rows.

### Shipped engine fixes (2026-08, see tickets RP-01…07)

| Item | Status | What changed |
|------|--------|--------------|
| **BUG-1** numeric partial index unused | **Fixed (RP-04)** | Filters/sorts restate `IS NOT NULL` + numeric regex via `database/numericJsonField.ts` so `idx_*_numeric` is planner-eligible |
| **BUG-2** N EXISTS per same-component filter | **Fixed (RP-03)** | One predicate group per component; INTERSECT/CTE membership pushdown; sort-driven EXISTS dedupe |
| Legacy **hasNextPage** without second `count()` | **Shipped (RP-01)** | Explicit `.take(N)` → SQL `LIMIT N+1`, trim, `getLastRouteInfo().hasNextPage` |
| Plain **cursor(id) + sortBy** footgun | **Throws (RP-06b)** | Use `sortedCursor(token)` for sorted lists |
| CTE wasted inner `ORDER BY` | **Fixed (RP-07)** | CTE orders only when it owns final order |
| Relation list N+1 gate | **Shipped (RP-05)** | `RelationsByComponentFkLoader` regression: `dbQueryCount` must not scale with N |
| QSP (~80× on covered lists, real PG17) | **Engine ready; ops (RP-02)** | Default `BUNSANE_QSP=off`; staged `shadow` → `route` — see `QSP_OPERATIONS.md` |

### Still expensive / not fixed by engine SQL alone

- **Exact `.count()`** for total pages — still a full second scan when the app calls it. Prefer `hasNextPage` (RP-01) or `BUNSANE_QSP_COUNT=n_plus_1` / `estimate` on QSP.
- **Deep OFFSET** — use `sortedCursor` for component-sorted lists.
- **GraphQL / service N+1** — `entity.get` and nested `new Query()` per list row. Fix with `eagerLoadComponents` / `populate` / request DataLoaders, not INTERSECT tuning. Diagnose with per-request `dbQueryCount`.
- **QSP coverage limits** — exact projected component-set match to **one** archetype; empty **tag** components and multi-archetype / `.without` queries stay on legacy (see §11 and `QSP_OPERATIONS.md`).

Practical app patterns: **`docs/QUERY_LIST_GUIDE.md`**.

---

## 2. How a read compiles (mechanism)

Data model:

- `entities(id uuid pk, created_at timestamptz, updated_at timestamptz, deleted_at)` — real indexed columns.
- `components(id, entity_id, type_id text, data jsonb, created_at, updated_at, deleted_at)` — LIST-partitioned by `type_id`. One row per (entity, component-type). Component fields live inside `data`. This is the single membership source.

`.with(A).with(B)` → **INTERSECT** of per-type membership selects. **After RP-03**, each component’s field filters are **pushed into that component’s membership branch** (and same-component filters are a single AND group — not one `EXISTS` per filter). Outer filter `EXISTS` is skipped when membership already applied the group (`filtersAppliedInMembership`).

```sql
-- .with(Order,{status='open', total>100}).with(Customer,{tier='gold'})  -- post RP-03 shape
SELECT entity_id FROM components_order   -- or parent + type_id when not direct partition
  WHERE deleted_at IS NULL
    AND data->>'status' = $1
    AND data->>'total' IS NOT NULL
    AND data->>'total' ~ '^-?[0-9]…'     -- restates partial numeric index (RP-04)
    AND (data->>'total')::numeric > $2
INTERSECT
SELECT entity_id FROM components_customer
  WHERE deleted_at IS NULL
    AND data->>'tier' = $3
```

**Historical (pre-RP-03):** membership was type-only, then N outer `EXISTS` — one per filter, including two for the same Order component. That shape is gone on the legacy INTERSECT/CTE path.

**Index reality:** `@CompData({ indexed: true })` routes by field type (`database/IndexingStrategy.ts:pickScalarIndexType`):

| Field | Index emitted | Serves |
|---|---|---|
| text | btree-expr `(data->>'f')` | `=`, `<`, `LIKE 'prefix%'`, `ORDER BY` |
| Number | partial numeric `((data->>'f')::numeric) WHERE data->>'f' ~ '^-?[0-9]…'` | range/`=` **when query restates predicate (RP-04)** |
| array/object | GIN `(data->'f') jsonb_path_ops` | `@>`, `<@` containment only |

A **single** field predicate can use an index. A **GIN on whole `data` cannot serve `->>` scalar filters** — only `@>`. **No composite/covering index across fields is ever auto-created.**

Path selection (`query/QueryDAG.ts:buildBasicQuery`, `query/ComponentInclusionNode.ts`):

- **Sort-driven scan** (`canUseSortDrivenScan`): exactly 1 sort key, ≥2 required components, no `findById`, no plain `cursor(id)` (`cursorId`), no OR. Drives FROM the sort component's table, probes others via `EXISTS`, walks the sort-expression index, stops at `LIMIT`. **This is the fast path.** It *does* support filters on other components, OFFSET, and **`sortedCursor()`** (composite keyset — `sortedCursor` nulls `cursorId` and injects the keyset into the fast scan). Plain `.cursor(id)` disables this path.
- **Single-pass filter+sort** (`applySinglePassFilterSort`): 1 component, 1 sort, all filters on that component. One scan.
- **Scalar-subquery ORDER BY** (`applySortingWithComponentJoins`): the fallback for everything else — multi-key sort, OR + component sort, plain `cursor(id)` + component sort, CTE path. `ORDER BY (SELECT data->>'f' … LIMIT 1)` forces materializing the full match set, computing the key per row, sorting, then `LIMIT`. **No index serves ordering here.**

---

## 3. Cost centers

| # | Cost center | What happens | Severity |
|---|---|---|---|
| **A** | Cross-component filters can't share an index | `order.status AND customer.tier` = INTERSECT + separate EXISTS probes joined by `entity_id`. One composite seek becomes N probes + join. Selectivity estimation on `data->>'x'` expression indexes is also weaker than on real columns. | High — structural |
| **B** | Same-component multi-filter not coalesced | **Fixed (RP-03):** one predicate group per component; INTERSECT/CTE pushdown. | Was high |
| **C** | Component sort in an ineligible shape → scalar-subquery ORDER BY | Full match-set materialize + sort. Triggers on OR + component sort, **plain `cursor(id)`** + component sort, multi-key sort, CTE path. **`sortedCursor` does not trigger this** — it rides sort-driven scan. | High — narrow |
| **D** | Exact `count()` for "total pages" | `SELECT COUNT(*) FROM (<full id query>)`, strips LIMIT/sort → full cardinality every request. A second full scan, often the most expensive. | Highest ROI to kill |
| **E** | Deep OFFSET pagination | O(offset) scan-and-discard. Prefer **`sortedCursor`** for component-sorted lists (fast path). Single-key `sortedCursor`, including `before`, is implemented; multi-key still throws (F-01 partial). | Medium |
| **F** | Numeric partial-index mismatch | **Fixed (RP-04):** queries restate `IS NOT NULL` + numeric regex via `database/numericJsonField.ts` so partial `idx_*_numeric` is eligible. | Was high |

**Additional planner notes:**

- **Base INTERSECT is unselective:** membership branches (`type_id=$X`) produce broad inputs before field filters apply. Pushing each component's filters *into* its INTERSECT branch shrinks the inputs and lets composite indexes matter.
- **work_mem spill:** the scalar-subquery ORDER BY + exact count both risk external sorts / large scans; `LIMIT` does not save a sort whose key is computed for all candidates.
- **Partition pruning:** LIST partitioning helps only when the query hits a leaf. `BUNSANE_USE_DIRECT_PARTITION=true` names the leaf table directly and is materially better for hot list paths than a generic `type_id=$1` against the parent.
- **HOT-update bloat:** frequent component updates reduce index-only-scan reliability (visibility map churn) even when a covering index exists.

---

## 4. Worst-case combo (the endpoint that melts)

**Still expensive today:**

`.with(Order,{2 filters}).with(Customer,{1 filter}).sortBy(Order,'total').cursor(id)` + `count()`:

1. **Plain `cursor(id)`** makes sort-driven scan ineligible → CTE + INTERSECT.
2. Component sort via **scalar subquery** → full materialize + sort (cost center C).
3. Exact `count()` → **second full query** (cost center D).

**Not the melt path (corrected 2026-08):**  
`.sortedCursor(token)` keeps the sort-driven fast path (composite keyset). Prefer it for sorted pages. After RP-03, multi-filter same-component coalesce + INTERSECT pushdown also shrink membership cost when not on the fast path.

---

## 5. Historical bugs (fixed)

**BUG-1 — numeric partial index unused.** **Fixed 2026-08-07 (RP-04):** index DDL and query emission share `database/numericJsonField.ts`. Filters/sorts restate `IS NOT NULL` + numeric regex so partial `idx_*_numeric` is planner-eligible. Dirty non-numeric JSON is excluded, not cast-errored. Confirm on real PG with `EXPLAIN`: expect Index Scan on `idx_<t>_<f>_numeric`. Tests: `tests/unit/query/NumericIndexPredicate.test.ts`, `tests/integration/query/Query.numericFilter.test.ts`.

**BUG-2 — same-component filters → N EXISTS.** **Fixed 2026-08-05 (RP-03):** filters are AND-coalesced per component; membership INTERSECT/CTE branches push field filters when non-legacy; sort-driven path dedupes presence EXISTS when filter EXISTS already proves membership. Tests: `tests/unit/query/FilterPushdown.test.ts`, `tests/integration/query/Query.filterPushdown.test.ts`.

---

## 6. Roadmap (ROI-ranked) — status as of 0.6.x / 2026-08

Each step ships alone. §7 defines how to measure. Full ticket text: `docs/internal/TICKETS_READ_PATH_PERF_2026-08.md`.

| Step | Status | Notes |
|------|--------|-------|
| **1 — hasNextPage / avoid default exact count** | **Done (RP-01)** for explicit `.take(N)`. Exact `.count()` still available when apps call it. GraphQL list schemas that always twin `exec+count` are app-layer. |
| **2 — filter coalesce + INTERSECT pushdown** | **Done (RP-03)** | |
| **3a — numeric index usable** | **Done (RP-04)** | |
| **3b — declared composite list-shape indexes** | Open (F-02) | Equality → range/sort → `entity_id` |
| **4 — generated projected columns (M1)** | Open (RP-08) | `@CompData({ projected: true })` — deferred |
| **5a — keyset ergonomics** | **Partial (RP-06 + F-01)** | Docs + throw on `cursor(id)+sortBy`. Single-key `before` works; multi-key keyset still throws. |
| **5b — QSP projection tables for hot screens** | **Engine ready; ops open (RP-02)** | `rm_<archetype>`; see `QSP_OPERATIONS.md` |
| **N+1 instrumentation gate** | **Done (RP-05)** | Relation FK loader batching |

**Still recommended product defaults (not automatic):**

- Prefer `hasNextPage` over exact `count()` for infinite scroll / “load more”.
- Prefer `sortedCursor` over deep OFFSET for sorted lists.
- Index every field you filter/sort (`@CompData({ indexed: true })`).
- For hot multi-component lists with a stable shape, declare a **list archetype** and turn on QSP (`shadow` → `route`).

**Projection failure modes (QSP):** sync lag, write amplification, schema drift, partial projections, soft-delete reconciliation. Treat `rm_` as a rebuildable cache, never as source of truth. Components remain SoT.

**What is already good (don't regress):** sort-driven scan LIMIT pushdown, INTERSECT over GROUP-BY-HAVING, entity-column sort on real `entities.created_at/updated_at`, OrNode single-pass (`BUNSANE_ORNODE_SINGLE_PASS`), keyset scaffolding, per-field btree/numeric routing, SQL-identifier allow-listing, RP-03/04/07 SQL shapes.

---

## 7. How to benchmark and measure

Performance claims here are **hypotheses until measured**. This section defines the measurement stack, the harness, its caveats, and a per-cost-center protocol with pass/fail signatures. **Measure before and after every roadmap step.**

### 7.1 Three measurement layers

1. **Plan-level (truth about index usage):** `EXPLAIN (ANALYZE, BUFFERS)` on the exact emitted SQL. The only way to prove a filter uses an index vs seq-scans. Use `Query.explainAnalyze()`:
   ```ts
   const plan = await new Query()
     .with(Order, { filters: [Query.filter('status', '=', 'open')] })
     .sortBy(Order, 'total', 'DESC').take(20)
     .explainAnalyze(true /* BUFFERS */);
   console.log(plan);
   ```
   Read the node types (see §7.5). This is per-query and deterministic — the primary tool.

2. **Framework-level (per-request cost):** the instrumented DB layer (`database/instrumentedDb.ts`) counts `dbQueryCount` per request via the `perRequest` counter threaded through `exec/count` and `createRequestLoaders(..., perRequest)`. Access/timeout logs report it. Use it to catch N+1 fan-out and count how many round-trips one list endpoint costs. **Diagnosing N+1:** if `dbQueryCount` scales with page size (or relation count) while SQL plans look fine, fix batching (`RequestLoaders` / DataLoader), not INTERSECT. Regression gate: `tests/integration/database/RelationsByComponentFkLoader.test.ts` (“RP-05”). `DB_SAVE_PROFILE=true` profiles the write path (not reads) — do not use it for query timing.

3. **Macro-level (throughput/latency):** the benchmark harness (§7.2) and the k6 load harness (`tests/load/`, see the `k6-load-harness` memory) for full HTTP-stack numbers. Report p50/p95/p99, not mean.

### 7.2 The existing benchmark harness

E-commerce fixture (`BenchUser/BenchProduct/BenchOrder/BenchOrderItem/BenchReview`), deterministic seed (42), tiers in `tests/benchmark/scripts/generate-db.ts`:

| Tier | Users | Products | Orders | Items | Reviews | ~Total entities |
|---|---|---|---|---|---|---|
| xs | 1k | 2k | 3k | 3k | 1k | 10k |
| sm | 5k | 10k | 15k | 15k | 5k | 50k |
| md | 10k | 20k | 30k | 30k | 10k | 100k |
| lg | 50k | 100k | 150k | 150k | 50k | 500k |
| xl | 100k | 200k | 300k | 300k | 100k | 1M |

```bash
bun run bench:generate:md          # generate the md-tier PGlite DB (once, cached on disk)
bun run bench:run:md               # run tests/benchmark/scenarios/ against it
bun tests/benchmark/scripts/generate-db.ts lg --force   # regenerate a tier
```

Scenario definitions live in `tests/benchmark/scenarios/`; add new list-view scenarios there.

### 7.3 Caveats — the existing harness measures the UN-indexed, single-table baseline

**Do not read the PGlite bench numbers as production behavior.** The harness (`run-benchmarks.ts`) sets:

- `USE_PGLITE=true` — PGlite planner, **no real LIST partitioning**, no `?|`/`?&`, different cost model than PG17.
- `BUNSANE_USE_DIRECT_PARTITION=false` — every query hits the single `components` table; partition pruning is not exercised.
- `BUNSANE_USE_LATERAL_JOINS=false`.
- The generator's schema (`generate-db.ts:initializeSchema`) creates **only** `idx_components_entity_id`, `idx_components_type_id`, `idx_components_name`. **No per-field btree/numeric/GIN indexes exist** — `@CompData` index creation never runs in the generator.

Consequence: filter benchmarks on the bench DB measure the **sequential-scan worst case**. That is useful as a floor and for A/B of query-*shape* changes (steps 1, 2), but it **cannot** measure index wins (steps 3, 4) or partition effects. For those, use real PG (§7.4).

### 7.4 Real-Postgres measurement (mandatory for index/partition claims)

Use the real-PG harness (`tests/pg-setup.ts`) — provisions an ephemeral scratch DB on a real PG17 server, **direct connection, prepared statements enabled**, framework migrations + `ensureLegacyIndexedFields` run on startup so the real per-field indexes exist:

```bash
bun tests/pg-setup.ts path/to/perf-scenario.test.ts     # single scenario on real PG
bun run test:pg:integration                             # integration suite on real PG
```

Config (env or gitignored `.env.test`): `PG_TEST_URL` / `PG_DIRECT_PORT` (direct listener, bypasses PgBouncer) and `PG_ADMIN_URL` (superuser CREATEDB). **Never** benchmark through PgBouncer (`:6432`) + `DB_DISABLE_PREPARE=true`: `prepare:false` serializes JS-object params to `"[object Object]"` and JSONB inserts fail; seeding breaks. See the `staging-db-access` / `real-pg-integration-harness` memories for exact ports.

For index-effect A/B on real PG: seed the scratch DB at a tier, capture `EXPLAIN (ANALYZE, BUFFERS)` with the index present, `DROP INDEX`, re-capture, diff the plan + timing.

### 7.5 Reading the plan — pass/fail signatures

| Look for | Meaning | Verdict |
|---|---|---|
| `Index Scan` / `Index Only Scan` on `idx_<t>_<f>_*` | Filter/sort served by the intended index | PASS |
| `Bitmap Heap Scan` + `BitmapAnd` | Multiple single-field indexes ANDed (no composite) | OK, but a composite index would beat it |
| `Seq Scan` on a `components*` table with a `Filter:` on `data->>` | The predicate found no usable index | **FAIL** (indexing gap or BUG-1) |
| `Sort` node with `Sort Method: external merge Disk` | work_mem spill on the sort | FAIL — sort not index-served (cost center C) |
| `rows removed by filter` ≫ `rows returned` | Broad scan then discard (deep OFFSET, unselective INTERSECT) | investigate cost center A/E |
| `SubPlan` in an `Order By` | Correlated scalar-subquery sort (the C fallback) | FAIL for large sets |
| `actual rows` on the sort input ≫ `LIMIT` | LIMIT not pushed down; full set sorted before limiting | FAIL |

`BUFFERS`: compare `shared hit/read`. A cold index scan reads few buffers; a seq scan reads the whole relation. Run each query **twice** and report the warm (2nd) run to factor out cold-cache noise; note cold numbers separately.

### 7.6 Metrics to record per scenario

- **Latency:** p50 / p95 / p99 over ≥50 warm iterations (not mean).
- **Plan signature:** top scan node type + whether the target index was used (§7.5).
- **Selectivity waste:** `rows scanned` (actual rows on the scan node) vs `rows returned`.
- **Round-trips:** `dbQueryCount` for the request (§7.1 layer 2).
- **Buffers:** warm `shared hit` vs cold `shared read`.
- **Count cost:** time of the `count()` query *separately* from the page query (cost center D is invisible if you only time the page).

Record the env matrix with every result: engine (PGlite vs PG17), tier, `BUNSANE_USE_DIRECT_PARTITION`, `BUNSANE_USE_LATERAL_JOINS`, `BUNSANE_ORNODE_SINGLE_PASS`, `BUNSANE_DEFAULT_QUERY_LIMIT`, whether field indexes exist.

### 7.7 Per-cost-center measurement protocol

Each row: the query to run, what to capture, and the pass criterion after the corresponding roadmap step.

| Cost center | Scenario query | Capture | Pass after step |
|---|---|---|---|
| **A** cross-component filter | `.with(Order,{status})..with(Customer,{tier})` filtered both sides | plan: is base INTERSECT filtered or membership-broad? rows scanned vs returned | Step 2: filters pushed into branches; scanned≈returned·k |
| **B** same-component multi-filter | `.with(Order,{status, total>N})` | count of `EXISTS` / SubPlan nodes for Order | Step 2/BUG-2: single grouped predicate on Order |
| **C** component sort fallback | `.with(A).with(B).sortBy(A,f)` **+ cursor**, and a 2-key sort | `SubPlan` in ORDER BY? external-merge Sort? | Step 5: keyset single-key uses sort-driven scan / index |
| **D** exact count | `.count()` on a filtered multi-component query | count() latency **alone**, at each tier | Step 1: endpoint no longer calls exact count by default |
| **E** deep OFFSET | same page query at `offset 0`, `1k`, `10k`, `100k` | latency vs offset curve (should be flat with keyset) | Step 5: keyset flat; OFFSET curve documented |
| **F** numeric index | `.with(Order,{total > N})` numeric filter | plan: `Index Scan idx_order_total_numeric` vs `Seq Scan` | Step 3/BUG-1: index used |

### 7.8 A/B methodology

1. Fix the seed (generator uses 42) and tier so the dataset is identical across runs.
2. Warm the cache (discard run 1) unless explicitly measuring cold.
3. Change **one** variable (a flag, an index, a query-shape patch) between A and B.
4. Capture the full §7.6 metric set for both.
5. For engine-shape changes (steps 1, 2) PGlite bench is acceptable; for index/partition changes (steps 3, 4, 5) **real PG only**.
6. Keep the `EXPLAIN` output — a latency delta without a plan delta is noise; a plan-node change is the real signal.

### 7.9 The regression gate (0.5.11+)

Hand-written `targetP95: 100` thresholds answer "is this fast enough on whichever
machine the number was picked on". The gate answers the question a refactor
actually needs: **did this change cost throughput?**

```bash
bun run bench:baseline:md    # record a baseline for this engine + tier
bun run bench:gate           # compare; non-zero exit on regression
BENCH_MARGIN_PCT=15 bun run bench:gate      # tighter margin
BENCH_ITERATIONS=80 bun run bench:gate      # more samples per scenario
```

Baselines live in `tests/benchmark/baseline/<tier>-<engine>.json` and are
committed, so a regression shows up as a diff rather than as folklore. Mechanism
in `tests/benchmark/runners/BaselineGate.ts`:

- **Gated on the median, not p95.** p95 over 20 iterations is effectively the max
  and is dominated by GC and Windows' ~15 ms timer granularity — two runs of
  identical code differed **+40 %** at p95. p95 is still recorded, for reading.
- **Calibration-normalized.** Every run includes `calibration-single-row` (a
  bounded 200-row scan); each scenario is compared as `median / calibrationMedian`,
  which removes *some* host and load sensitivity. The calibration query is
  deliberately not trivial: a `take(1)` version measured ~0.4 ms and its own
  jitter dominated every ratio.
  This is **not** a cross-machine portability claim — same-machine drift is
  already 18.2 %, so a different host cannot be assumed better. A platform
  mismatch is reported as *incomparable* and does not produce a verdict: every
  machine (including CI) records its own baseline, and the gate answers
  "before vs after **on this host**", which is what a refactor actually asks.
  The committed `*-pglite.json` baselines were recorded on Windows/x64.
- **Absolute floor.** A regression must also move the raw median by ≥ 0.5 ms, and
  agree in sign with the ratio — otherwise a shrinking denominator reports
  scenarios that got *faster* as regressions (observed: +4.2 % ratio, −1.28 ms raw).
- **Environment-fingerprinted.** Engine, tier, pool size, framework and Bun
  version are recorded, and a cross-engine comparison is refused rather than
  silently producing nonsense.

**Known limits — do not oversell this gate.** Measured on PGlite/Windows against
a single-run baseline, worst-case drift on identical code is **18.2 %**, and some
scenarios drift *reproducibly* (`count-products` +14.1 % then +14.2 %), which
more iterations does not fix — 20 → 80 barely moved it. Hence the 25 % default
margin: the gate catches structural regressions (an added round trip per query, a
lost batch, a new serialization point — 2× events), not 10 % tuning questions.
Two tracked follow-ups would tighten it: make the baseline the median of K suite
runs, and record the authoritative baseline on **real Postgres**. PGlite is
single-connection, so nothing it reports describes pool behaviour at all.

### 7.10 Saturation and recovery (`tests/load/pool-saturation.ts`)

The load harness that the B8 outage needed. Drives the pool past capacity and
asserts the framework fails fast and **returns to full capacity**:

```bash
POOL_TEST_URL=postgres://user:pw@host:5432/db bun run test:pool-saturation
# knobs: POOL_SIZE [3] SLOW_SECONDS [5] CONN_TIMEOUT_SECONDS [1]
```

- **phase 1** — exhaustion must fail inside the connection-timeout budget and be
  classified as capacity (`ERR_POSTGRES_CONNECTION_TIMEOUT` → 503), not as a
  query error.
- **phase 2** — every slot must be usable again afterwards, not just one. A pool
  that never returns to `max` is exactly the B8 failure.
- **phase 3** — *measures* whether a client-side abort returns the slot early or
  whether it stays pinned until the statement ends by itself. Run this against
  the real topology: on a session-affine connection cancel frees the slot, behind
  `pool_mode = transaction` it does not (B8a), and the script reports which
  world you are in instead of assuming.

---

## 8. List pagination API (current)

```ts
// Preferred list page (legacy + QSP when covered):
const items = await new Query()
  .with(OrderStatus, Query.filters(Query.filter('status', Query.filterOp.EQ, 'open')))
  .with(OrderInfo)
  .with(OrderTimeline)
  .sortBy(OrderTimeline, 'createdAt', 'DESC')
  .take(20) // explicit take → LIMIT 21; result trimmed to 20
  .exec();

const { hasNextPage, routed, surface, archetype } = query.getLastRouteInfo();
// hasNextPage: true iff a 21st row existed (RP-01). Framework default LIMIT (no .take) does NOT n+1.

// Next page on a sorted list — keep sort-driven / QSP keyset path:
const last = items[items.length - 1]!;
const token = Query.encodeSortedCursor(
  /* sort value from last row's component data */,
  last.id
);
await new Query()
  .with(/* same */)
  .sortBy(OrderTimeline, 'createdAt', 'DESC')
  .take(20)
  .sortedCursor(token)
  .exec();

// THROWS (RP-06b):
// .sortBy(...).cursor(entityId)  — plain id cursor is not sort order
// Use sortedCursor, or drop sortBy to page by entity_id only.
```

Exact totals: still `.count()` (full scan). QSP: `BUNSANE_QSP_COUNT=n_plus_1|estimate|exact`. Planner estimate via `Query.estimatedCount` is **not** valid for filtered multi-component sets (whole-partition-ish).

---

## 9. N+1 vs bad SQL (how to tell)

| Signal | Likely cause | Fix |
|--------|--------------|-----|
| One slow statement; `EXPLAIN` shows Seq Scan / external Sort / huge rows scanned | Membership/filter/sort plan | Indexes, sort-driven shape, filter pushdown (shipped), QSP for hot archetype |
| `dbQueryCount` scales with page size N | Per-row `get` / nested Query / unbatched relations | `eagerLoadComponents` / `.populate()` / request DataLoaders; batch FK `IN` queries |
| Fast SQL + still multi-second request | Field resolvers / `@ArcheTypeFunction` per row | Batch loaders; avoid Query-per-parent in list GraphQL |

Instrumentation: `database/instrumentedDb.ts` + `createRequestLoaders(..., perRequest)`. Gate: `tests/integration/database/RelationsByComponentFkLoader.test.ts` (RP-05).

---

## 10. QSP coverage limits (summary)

Full runbook: **`docs/QSP_OPERATIONS.md`**. Product patterns: **`docs/QUERY_LIST_GUIDE.md`**.

| Query shape | Routes on QSP? |
|-------------|----------------|
| `.with` set **exactly equals** one archetype’s **projected** component set; supported ops (`= != > < >= <= IN NOT IN`); ≤1 sort; keyset `after` | Yes when READY |
| Empty **tag** component in `.with()` | **No** — tags emit no projected columns, set equality fails |
| Optional components on full archetype but not on most entities | Under-counts if projected as membership — use a **list-only archetype** without optionals |
| Multi-archetype join / cross-entity | **No** on QSP. Use `@ReadModel` (`m3_*`) or app-side FK `IN` |
| `.without` / excluded components / OR / spatial / ILIKE | **No** — legacy (OR may still use single-pass OrNode) |
| `BUNSANE_QSP=off` (default) | Always legacy |

---

## 11. References

- Query builder: `query/Query.ts`, `query/ComponentInclusionNode.ts`, `query/CTENode.ts`, `query/QueryDAG.ts`, `query/OrNode.ts`, `query/FilterBuilder.ts`
- Numeric predicates: `database/numericJsonField.ts`, `database/IndexingStrategy.ts`
- QSP: `query/planner/SurfacePlanner.ts`, `database/projection/*`, `docs/QSP_OPERATIONS.md`
- App list guide: `docs/QUERY_LIST_GUIDE.md`
- Tickets: `docs/internal/TICKETS_READ_PATH_PERF_2026-08.md`
- Benchmark: `tests/benchmark/scripts/{generate-db,run-benchmarks}.ts`
- Real-PG: `tests/pg-setup.ts`
- Related RFCs: `internal/RFC_MATERIALIZED_READ_MODELS.md`, `internal/RFC_QUERY_SURFACE_PLANNER.md`, `internal/RFC_QSP_ROW_HYDRATION.md`, `internal/QUERY_SORT_PAGINATION_PLAN.md`

---

## Appendix A — P0 ceiling-proof result (real PG17)

Worst-case archetype list query (filter + sort + keyset + count), hand-built `rm_order` with a partial covering index vs the legacy INTERSECT+EXISTS+scalar-subquery path, measured on a real PG17 scratch DB:

- Page query: 52.55ms → 0.66ms (**79.8×**).
- Count query: 59.14ms → 0.71ms (**83.9×**).
- AFTER plan: Index Only Scan, Heap Fetches: 0, zero SubPlan in ORDER BY, no Seq Scan.

Gate (≥5× page, ≥10× count): **PASS**. This is the QSP promise for **covered** list shapes only.
