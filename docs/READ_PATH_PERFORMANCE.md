# Read-Path Performance: Filtered + Sorted + Paginated List Queries

**Status:** Analysis + measurement guide + incremental roadmap
**Date:** 2026-07-08
**Scope:** The query READ path only (`Query` builder → SQL). Writes (`Entity.save`) are out of scope and are not the bottleneck.
**Audience:** framework maintainers optimizing the ECS-on-Postgres query engine.

---

## 1. TL;DR

Writes are fast. The pain is the **filtered + sorted + paginated list read** — the "page 3 of open orders for gold-tier customers, sorted by total" query behind every ERP/CRM/admin list screen.

Root cause is structural: a logical record's fields are scattered across **multiple JSONB component rows** (one partition row per component type). A predicate that a relational schema serves with **one composite-index range scan** becomes, in the ECS model, **N index probes + a set INTERSECT + a join**. Postgres cannot build a single covering index over fields that live in different physical rows.

On top of the structural cost sit issues that are **fixable now**:

- **BUG-1 (numeric index):** the numeric functional index is created as a *partial* index whose predicate the emitted query never restates, so numeric filters likely fall back to sequential scans.
- **BUG-2 (per-filter EXISTS):** multiple filters on the *same* component emit one `EXISTS` subquery each — N re-scans of that partition instead of one grouped predicate.
- **Exact `count()`** for "total pages" runs a second full-cardinality query on every list request — frequently the single most expensive operation on the endpoint.

The roadmap in §6 evolves the working system (Gall's Law); it does not propose a rewrite.

---

## 2. How a read compiles (mechanism)

Data model:

- `entities(id uuid pk, created_at timestamptz, updated_at timestamptz, deleted_at)` — real indexed columns.
- `components(id, entity_id, type_id text, data jsonb, created_at, updated_at, deleted_at)` — LIST-partitioned by `type_id`. One row per (entity, component-type). Component fields live inside `data`. This is the single membership source.

`.with(A).with(B)` → **INTERSECT** of per-type membership selects; each `.filter()` bolted on as a separate `EXISTS` (or `CROSS JOIN LATERAL`) subquery:

```sql
-- .with(Order,{status='open', total>100}).with(Customer,{tier='gold'})
SELECT entity_id FROM components WHERE type_id=$order      -- broad membership
INTERSECT
SELECT entity_id FROM components WHERE type_id=$customer   -- broad membership
-- then on the intersected id-set:
WHERE EXISTS (SELECT 1 FROM components c WHERE c.entity_id=base.id
              AND c.type_id=$order AND c.data->>'status'=$1)                 -- filter 1
  AND EXISTS (... c.type_id=$order AND (c.data->>'total')::numeric > $2)     -- filter 2 (SAME comp → 2nd EXISTS)
  AND EXISTS (... c.type_id=$customer AND c.data->>'tier'=$3)                -- filter 3
```

The base set is **membership-broad** (all orders ∩ all customers), then narrowed by field filters afterward — backwards for selectivity.

**Index reality:** `@CompData({ indexed: true })` routes by field type (`database/IndexingStrategy.ts:pickScalarIndexType`):

| Field | Index emitted | Serves |
|---|---|---|
| text | btree-expr `(data->>'f')` | `=`, `<`, `LIKE 'prefix%'`, `ORDER BY` |
| Number | partial numeric `((data->>'f')::numeric) WHERE data->>'f' ~ '^-?[0-9]…'` | range/`=` **(see BUG-1)** |
| array/object | GIN `(data->'f') jsonb_path_ops` | `@>`, `<@` containment only |

A **single** field predicate can use an index. A **GIN on whole `data` cannot serve `->>` scalar filters** — only `@>`. **No composite/covering index across fields is ever auto-created.**

Path selection (`query/QueryDAG.ts:buildBasicQuery`, `query/ComponentInclusionNode.ts`):

- **Sort-driven scan** (`canUseSortDrivenScan`): exactly 1 sort key, ≥2 required components, no `findById`, no cursor, no OR. Drives FROM the sort component's table, probes others via `EXISTS`, walks the sort-expression index, stops at `LIMIT`. **This is the fast path.** It *does* support filters on other components and OFFSET.
- **Single-pass filter+sort** (`applySinglePassFilterSort`): 1 component, 1 sort, all filters on that component. One scan.
- **Scalar-subquery ORDER BY** (`applySortingWithComponentJoins`): the fallback for everything else — multi-key sort, OR + component sort, cursor + component sort, CTE path. `ORDER BY (SELECT data->>'f' … LIMIT 1)` forces materializing the full match set, computing the key per row, sorting, then `LIMIT`. **No index serves ordering here.**

---

## 3. Cost centers

| # | Cost center | What happens | Severity |
|---|---|---|---|
| **A** | Cross-component filters can't share an index | `order.status AND customer.tier` = INTERSECT + separate EXISTS probes joined by `entity_id`. One composite seek becomes N probes + join. Selectivity estimation on `data->>'x'` expression indexes is also weaker than on real columns. | High — structural |
| **B** | Same-component multi-filter not coalesced | 2 filters on `Order` = 2 separate `EXISTS`, each re-scanning the order partition. `ComponentInclusionNode.ts:1016-1017,1144`. | High — fixable (**BUG-2**) |
| **C** | Component sort in an ineligible shape → scalar-subquery ORDER BY | Full match-set materialize + sort, no index for ordering. Triggers on OR + component sort, cursor + component sort, multi-key sort, CTE path. (Narrower than first thought: plain different-component-filter + OFFSET still uses the fast sort-driven scan.) | High — narrow |
| **D** | Exact `count()` for "total pages" | `SELECT COUNT(*) FROM (<full id query>)`, strips LIMIT/sort → full cardinality every request. A second full scan, often the most expensive. | Highest ROI to kill |
| **E** | Deep OFFSET pagination | O(offset) scan-and-discard. Keyset exists (`sortedCursor`) but single-key, forward-only, no NULLS FIRST; multi-key throws. | Medium |
| **F** | Numeric partial-index mismatch | Index built with `WHERE data->>'f' ~ '^-?[0-9]…'`; query emits plain `(data->>'f')::numeric > $1` with no matching predicate → planner can't prove partiality → **index unused**, and can error on dirty non-numeric JSON. `IndexingStrategy.ts:219-222`. | High — latent (**BUG-1**) |

**Additional planner notes:**

- **Base INTERSECT is unselective:** membership branches (`type_id=$X`) produce broad inputs before field filters apply. Pushing each component's filters *into* its INTERSECT branch shrinks the inputs and lets composite indexes matter.
- **work_mem spill:** the scalar-subquery ORDER BY + exact count both risk external sorts / large scans; `LIMIT` does not save a sort whose key is computed for all candidates.
- **Partition pruning:** LIST partitioning helps only when the query hits a leaf. `BUNSANE_USE_DIRECT_PARTITION=true` names the leaf table directly and is materially better for hot list paths than a generic `type_id=$1` against the parent.
- **HOT-update bloat:** frequent component updates reduce index-only-scan reliability (visibility map churn) even when a covering index exists.

---

## 4. Worst-case combo (the endpoint that melts)

`.with(Order,{2 filters}).with(Customer,{1 filter}).sortBy(Order,'total').sortedCursor(token)` + `count()`:

1. Cursor makes sort-driven scan **ineligible** → CTE + INTERSECT (broad membership).
2. Filters as N `EXISTS` on the intersected set (BUG-2 doubles same-component ones).
3. Component sort via **scalar subquery** → full materialize + sort (cost center C).
4. `count()` → **second full query**, full cardinality (cost center D).

Three expensive passes for one screen.

---

## 5. Two confirmed bugs (ticket now)

**BUG-1 — numeric partial index unused.** `IndexingStrategy.ts:219-222` builds a partial index whose `WHERE … ~ '^-?[0-9]…'` predicate the query never restates. Fix options: restate the predicate in the emitted SQL, drop the partial `WHERE` (index all rows), or back it with a generated column (§6 step 4). Confirm with `EXPLAIN` on a numeric filter over a seeded partition — look for `Seq Scan` where an `Index Scan` on `idx_<t>_<f>_numeric` was expected.

**BUG-2 — same-component filters → N EXISTS.** `ComponentInclusionNode.ts:1016-1017` iterates per-filter. Group filters by `compId` and emit one predicate group (one `EXISTS`, or inline on the driving table) per component.

---

## 6. Roadmap (ROI-ranked, evolve-don't-rewrite)

Each step ships alone and improves the worst case. §7 defines how to measure each one.

**Step 1 — Kill exact count by default (biggest win, smallest change).**
Fetch `LIMIT page_size + 1`, derive `hasNextPage` from the extra row. Make exact `count()` opt-in. Removes one full pass from every list request. For real totals: short-TTL cache keyed by query signature, or a planner estimate via `EXPLAIN (FORMAT JSON)` labeled as estimate (not `pg_class.reltuples` — whole-partition only; `Query.estimatedCount` already does this and is not valid for filtered sets).

**Step 2 — Push filters into INTERSECT branches + coalesce same-component filters (fixes BUG-2).**
```sql
SELECT entity_id FROM components_order
  WHERE deleted_at IS NULL AND data->>'status'=$1 AND (data->>'total')::numeric>$2
INTERSECT
SELECT entity_id FROM components_customer
  WHERE deleted_at IS NULL AND data->>'tier'=$3
```
Smaller set-op inputs, per-component composite indexes now matter, better cardinalities. Local engine change, large upside.

**Step 3 — Fix numeric index (BUG-1) + declared composite/covering indexes.**
Give a declarative per-component list-shape index (equality cols → range/sort key → `entity_id` tiebreak):
```sql
CREATE INDEX CONCURRENTLY ON components_order
  ((data->>'status'), ((data->>'total')::numeric),
   ((data->>'updatedAt')::timestamptz) DESC, entity_id)
  WHERE deleted_at IS NULL;
```
Declared first; auto-recommend from telemetry later.

**Step 4 — Generated projected columns for hot scalar fields.**
```sql
ALTER TABLE components_order
  ADD COLUMN proj_status text    GENERATED ALWAYS AS (data->>'status') STORED,
  ADD COLUMN proj_total  numeric GENERATED ALWAYS AS ((data->>'total')::numeric) STORED;
```
Emit `c.proj_status=$1 AND c.proj_total>$2`. Fixes cast fragility, the BUG-1 partial-index problem, planner stats (real typed columns beat expression indexes), and SQL simplicity. This is the M1 tier of `RFC_MATERIALIZED_READ_MODELS.md`; pair it with the index from step 3 (the Phase-0 benchmark showed the *index*, not the column, is the win).

**Step 5 — Keyset default + opt-in projection tables for hot screens.**
Make keyset (`sort_expr, entity_id`) the default for component-sorted lists; OFFSET becomes legacy/explicit. For the handful of genuinely hot list views, a flat projection table (one row per entity, columnar) turns filter+sort+count into ordinary relational SQL served by one composite index. Components stay source of truth; the projection is **disposable — rebuild, don't migrate**. M2/M3 tiers of the read-models RFC.

**Projection failure modes:** sync lag (recently-saved entity missing — update in the write transaction or tolerate eventual consistency), write amplification (a `Customer.tier` change fans out to every order projection row), schema drift (rename/type change → DDL + backfill), partial projections (a non-projected field must fall back to ECS or hard-error — silent fallback re-introduces the cliff), reconciliation on soft-delete/component-removal (where most bugs live). Treat it as a rebuildable cache, never as source data.

**What is already good (don't touch):** sort-driven scan LIMIT pushdown, INTERSECT over GROUP-BY-HAVING, entity-column sort on real `entities.created_at/updated_at`, OrNode single-pass, keyset scaffolding, per-field btree/numeric routing, SQL-identifier allow-listing.

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

2. **Framework-level (per-request cost):** the instrumented DB layer (`database/instrumentedDb.ts`) counts `dbQueryCount` per request via the `perRequest` counter threaded through `exec/count`. Access/timeout logs report it. Use it to catch N+1 fan-out and count how many round-trips one list endpoint costs. `DB_SAVE_PROFILE=true` profiles the write path (not reads) — do not use it for query timing.

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

---

## 8. References

- Query builder: `query/Query.ts`, `query/ComponentInclusionNode.ts`, `query/CTENode.ts`, `query/QueryDAG.ts`, `query/OrNode.ts`
- Indexing: `database/IndexingStrategy.ts`, `core/decorators/IndexedField.ts`, `core/components/Decorators.ts`
- Benchmark harness: `tests/benchmark/scripts/{generate-db,run-benchmarks}.ts`, `tests/benchmark/scenarios/`
- Real-PG harness: `tests/pg-setup.ts`
- Related: `docs/RFC_MATERIALIZED_READ_MODELS.md`, `docs/RFC_ECS_PG_SORT_DENORMALIZATION.md`, `docs/SCALABILITY_PLAN.md`, `docs/QUERY_SORT_PAGINATION_PLAN.md`

## P0 ceiling-proof result (real PG17)

Worst-case archetype list query (filter + sort + keyset + count), hand-built rm_order with a partial covering index vs the legacy INTERSECT+EXISTS+scalar-subquery path, measured on a real PG17 scratch DB:
- Page query: 52.55ms -> 0.66ms (79.8x).
- Count query: 59.14ms -> 0.71ms (83.9x).
- AFTER plan: Index Only Scan, Heap Fetches: 0, zero SubPlan in ORDER BY, no Seq Scan.

Gate (>=5x page, >=10x count): PASS. Proceeding to P1.
