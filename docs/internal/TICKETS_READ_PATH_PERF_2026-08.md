# Tickets: Read-Path Performance (Filter + Sort + Pagination)

**Status:** Wave A+B engine complete; RP-02 ops open (staging soak); RP-08 deferred; F-01, F-09, F-11 done (post-0.7.0)
**Date:** 2026-08-07 (status refreshed 2026-09-24)
**Basis:** `docs/READ_PATH_PERFORMANCE.md` + product sample review + Opus ticket review  
**Scope:** List-read path only (`Query` → SQL → hydrate). Writes out of scope unless a ticket explicitly dual-writes.  
**App-facing guides:** `docs/QUERY_LIST_GUIDE.md`, `docs/QSP_OPERATIONS.md`

### Consensus priorities

| Order | Ticket | Effort | Impact | Depends on |
|------:|--------|--------|--------|------------|
| 1 | **RP-01** Legacy `hasNextPage` / kill default exact count ✅ DONE | S | Highest | — |
| 2 | **RP-02** QSP shadow → route rollout + hydrate validation — **OPEN** (needs staging soak) | M (ops + code) | Highest for hot lists | — |
| 3 | **RP-03** Coalesce same-component filters (BUG-2) + INTERSECT pushdown ✅ DONE | M | High | — |
| 4 | **RP-04** Fix numeric partial index (BUG-1) ✅ DONE | S | High (numeric filters/sorts) | — |
| 5 | **RP-05** Service-layer / GraphQL N+1 instrumentation + hard gates ✅ DONE (gate) | S | High (prod incident class) | — |
| 6 | **RP-06** Keyset docs + cursor/sortBy guard ✅ DONE (06a+06b) | S | Medium | — |
| 7 | **RP-07** Drop wasted CTE internal `ORDER BY` under outer sort ✅ DONE | S | Medium | — |
| 8 | **RP-08** Generated projected columns (M1) for legacy surfaces — **OPEN** | L | High long-term | RP-04 preferred first |

Each ticket ships alone. Measure before/after with `Query.explainAnalyze(true)` and the e-commerce bench harness (`bun run bench:run:md` on **real PG** for index claims; PGlite is not representative).

---

## RP-01 — Legacy list pagination: `hasNextPage` without exact `count()`

**Status: DONE 2026-08-07**

Shipped: explicit `.take(N)` only → SQL `LIMIT N+1`, trim, `getLastRouteInfo().hasNextPage`. Default framework LIMIT does not n+1. QSP path unchanged (already n+1). Tests: `Query.hasNextPage.test.ts`.

### Problem
Every list screen that calls `.count()` for total pages runs a **second full-cardinality** query (`Query.doCount` strips LIMIT/sort and wraps the full DAG in `COUNT(*)`). QSP already does `LIMIT n+1` → `hasNextPage` on the routed path; **legacy does not**.

### Goal
Make “page of results + is there another page?” the default list shape without a second scan. Exact totals remain available but opt-in / explicit.

### Files
| Path | Change |
|------|--------|
| `query/Query.ts` | Mirror QSP `doExecRouted` n+1 fetch on **legacy** `doExec`: when `limit !== null`, fetch `limit+1`, trim, set `_lastRouteInfo.hasNextPage` (or a dedicated `_lastPageInfo` if route info is QSP-only). |
| `query/Query.ts` | Document that bare `.count()` remains exact; add optional `count({ strategy: 'exact' \| 'estimate' })` or env `BUNSANE_QUERY_COUNT=exact\|estimate` for legacy (mirror `BUNSANE_QSP_COUNT`). |
| `docs/CONFIGURATION.md` | Document new flag / API if added. |
| GraphQL list resolvers / archetype CRUD (if they auto-`count`) | Stop calling exact count for default connection payloads; expose `hasNextPage` / `pageInfo` only. Locate via grep for `.count()` in `core/archetype`, `gql/`. |

### Acceptance criteria
- [x] `new Query().with(C).take(20).exec()` issues **one** primary SELECT (no companion `COUNT(*)`).
- [x] When limit is set, `getLastRouteInfo().hasNextPage` is `true` iff a 21st row existed; result length ≤ 20.
- [x] When limit is null/unset, behavior unchanged (no n+1 fetch). Explicit `.take` only.
- [x] Exact `.count()` still works.
- [x] Unit/integration: `tests/integration/query/Query.hasNextPage.test.ts`.

### Out of scope
Changing GraphQL connection schema shapes beyond wiring `hasNextPage` if the field already exists; full Relay cursor rewrite (see RP-06).

### Measure
Instrument `dbQueryCount` per list request before/after. Target: list endpoint that currently does `exec + count` drops from **≥2** heavy queries to **1**.

---

## RP-02 — QSP production rollout (shadow → route) + hydrate validation

**Status: OPEN.** Needs a staging soak (`BUNSANE_QSP=shadow`, then `route`) and hydrate validation. Not closed by the 2026-09-24 overhaul. The reconcile sweep itself is started by `App.init()` when QSP is on (F-11, done).

### Problem
QSP is implemented and measured (~80× on real PG17 for covered lists) but defaults to `BUNSANE_QSP=off`. Routed exec still hydrates from `components` unless `BUNSANE_QSP_HYDRATE` is validated on — partial win only for id-set + count.

### Goal
Turn on QSP for real hot list archetypes with safe promotion, zero wrong results, and a measured hydrate path.

### Files / ops surfaces
| Path | Change |
|------|--------|
| `docs/QSP_OPERATIONS.md` | Already the runbook — follow it; add a “first production archetype” checklist if missing. |
| Env (deploy) | `BUNSANE_QSP=shadow` → soak → `route`; optionally scope `BUNSANE_QSP_ARCHETYPES`. |
| `BUNSANE_QSP_COUNT` | Prefer `n_plus_1` for list UIs. |
| `query/planner/*`, `query/Query.ts` | Only if hydrate flag gates or parity tests need tightening (`HydrationParity.ts`, `RmRowHydrator.ts`, `RmHydrationPlan.ts`). |
| Metrics | Ensure `qsp_shadow_divergence_total`, `qsp_route_total`, `qsp_fallback_total`, `qsp_drift_total` are scraped. |
| `ProjectionManager` / reconcile | Confirm reconcile sweep started in app boot for multi-instance. |

### Acceptance criteria
- [ ] Staging: `BUNSANE_QSP=shadow` for ≥1 hot archetype; `qsp_shadow_divergence_total=0` over soak (min `BUNSANE_QSP_PROMOTE_MIN` clean comparisons).
- [ ] Staging: flip `route`; covered queries show `getLastRouteInfo().routed === true` / surface `rm`.
- [ ] Uncovered queries and OR queries still fall through to legacy with correct results.
- [ ] Instant rollback: `BUNSANE_QSP=off` restores legacy without redeploy.
- [ ] Hydrate: either document “id-set only win” as accepted, **or** enable `BUNSANE_QSP_HYDRATE` with parity tests green (`HydrationParity`).
- [ ] Dual-write latency budget measured on save path (p95 delta acceptable for product).

### Out of scope
OR-query coverage on `rm_`; multi-archetype joins (M3 read models).

### Measure
Before/after p50/p95 on one production-like list: filter + sort + take(20) ± count. Compare `EXPLAIN` node types: expect single index scan on `rm_*` when routed.

---

## RP-03 — BUG-2: coalesce same-component filters + push filters into INTERSECT

**Status: DONE 2026-08-05**

Shipped:
- `buildComponentFilterCondition` / `buildComponentFilterGroup` in `query/FilterBuilder.ts`
- INTERSECT/CTE membership branches push field filters when non-legacy (`components` / partitions)
- Outer EXISTS/LATERAL: one group per component; skipped when `filtersAppliedInMembership`
- Sort-driven scan: coalesce multi-filter EXISTS; skip presence EXISTS when filter EXISTS implies membership
- `QueryContext.reset()` clears `filtersAppliedInMembership` / CTE flags
- Tests: `tests/unit/query/FilterPushdown.test.ts`, `tests/integration/query/Query.filterPushdown.test.ts`

### Problem
1. Multiple filters on the **same** component emit **one EXISTS each** (re-scan partition N times).
2. INTERSECT / CTE membership branches are **type_id only**; field filters apply afterward on a broad set.
3. Sort-driven fast path also does per-filter EXISTS and can emit a **redundant presence EXISTS** when a filter EXISTS on the same component already implies membership.

### Goal
One predicate group per component; push that group into membership/INTERSECT branches where safe; dedupe fast-path EXISTS.

### Files
| Path | Change |
|------|--------|
| `query/ComponentInclusionNode.ts` | Group `context.componentFilters.get(compId)` into a single AND group per component. Sites: filter application loops (~1016–1153), sort-driven scan (~237–274). |
| `query/CTENode.ts` | When building INTERSECT branches (~60–71), attach that component’s filter predicates to the branch (not only after INTERSECT). |
| `query/ComponentInclusionNode.ts` / membership builders | Non-CTE multi-component INTERSECT path (~497–506 area) — same pushdown. |
| `query/FilterBuilder.ts` / builders | Reuse existing condition builders; no new filter language. |
| Tests | `tests/unit/query/`, `tests/integration/query/` — multi-filter same component; multi-component filters; sort-driven + multi-filter; SQL snapshot or `explainAnalyze` asserts fewer EXISTS subplans. |

### Design notes
```sql
-- target shape
SELECT entity_id FROM components_order
  WHERE deleted_at IS NULL
    AND data->>'status' = $1
    AND (data->>'total')::numeric > $2
INTERSECT
SELECT entity_id FROM components_customer
  WHERE deleted_at IS NULL
    AND data->>'tier' = $3
```

- Prefer direct partition tables when `BUNSANE_USE_DIRECT_PARTITION` / leaf names apply.
- Preserve soft-delete (`deleted_at IS NULL`) and identifier allow-listing.
- Custom filter builders (`FilterBuilderRegistry`) must still compose into the same group.

### Acceptance criteria
- [ ] Two filters on component A → **one** EXISTS (or inline predicates), not two.
- [ ] Multi-component: each component’s filters appear **inside** its INTERSECT/membership branch (verify emitted SQL string or plan).
- [ ] Sort-driven path: no separate presence-EXISTS for a component that already has filter-EXISTS.
- [ ] Correctness: existing filter/sort/cursor/OR invariant tests pass; add cases for 2+ filters same type + cross-type.
- [ ] No change to public Query API.

### Measure
`EXPLAIN (ANALYZE, BUFFERS)` on multi-filter multi-component list: lower shared buffers / fewer nested loops; wall time regression test on seeded md/lg tier.

---

## RP-04 — BUG-1: numeric functional index actually used

**Status: DONE 2026-08-07**

Shipped: `database/numericJsonField.ts` shared by index DDL + query emission; filters/sorts restate partial-index predicate; dirty non-numeric JSON excluded. Tests: `NumericIndexPredicate.test.ts`, `Query.numericFilter.test.ts`.

### Problem
`IndexingStrategy` creates a **partial** numeric index with  
`WHERE data->>'f' ~ '^-?[0-9]…'`  
but queries emit bare `(data->>'f')::numeric …` without restating the predicate → planner often cannot use the index (seq scan + cast).

### Goal
Numeric equality/range filters and sorts use the numeric expression index on real PG.

### Files
| Path | Change |
|------|--------|
| `database/IndexingStrategy.ts` | Prefer **drop partial WHERE** (index all rows; cast-safe empties/nulls) **or** document + restate regex in every numeric SQL emission. Recommended: non-partial index (simpler, matches query shape). |
| `query/ComponentInclusionNode.ts` | If keeping partial index: restate predicate in `buildFilterCondition` / numeric cast sites (~107, ~807, ~1081). |
| Migration / ensure path | Existing `ensureNumericIndex` must recreate or CREATE INDEX CONCURRENTLY new shape without leaving orphan partials. |
| Tests | Real-PG preferred: seed numeric-indexed field, `explainAnalyze`, assert Index Scan / Bitmap Index Scan on `idx_*_numeric` (or new name). |

### Acceptance criteria
- [ ] On real PostgreSQL with `@CompData({ indexed: true })` Number field: filter `(field > N)` plan uses the numeric index (not seq scan of the partition).
- [ ] Dirty non-numeric JSON does not crash list queries (null-safe cast or filtered rows).
- [ ] PGlite suite still green (index creation may no-op or differ; skip plan assert under `USE_PGLITE`).
- [ ] Update stale line refs in `docs/READ_PATH_PERFORMANCE.md` §5 (219–222 → current).

### Measure
Plan-level only: Index Scan present. Wall time on large partition with selective numeric range.

---

## RP-05 — Service-layer N+1: instrument + prevent regression

**Status: DONE (gate) 2026-08-07**

Instrumentation already existed (`instrumentedDb` / `createRequestLoaders` perRequest). Added regression: N parents same-tick `relationsByComponentFk` → `dbQueryCount < N` and one relation DataLoader call. Docs: N+1 diagnosis in `READ_PATH_PERFORMANCE.md` §7.1.

### Problem
The only recorded production multi-second incident class was **thousands of statements per request** (DataLoader batch size 1 / missing batching), not a single bad INTERSECT plan. Engine SQL work does not fix this. Relation DataLoaders were fixed for `@BelongsTo`/`@HasMany` (C07) but **custom services and nested GraphQL fields** can still fan out.

### Goal
Make N+1 visible in every environment and fail tests/CI when a known-hot path exceeds a statement budget.

### Files
| Path | Change |
|------|--------|
| `database/instrumentedDb.ts` | Ensure per-request `dbQueryCount` is always available on GraphQL/HTTP context. |
| Access / timeout logs | Already report counters — confirm list routes log `dbQueryCount`. |
| `core/archetype/relationLoader.ts`, `core/App.ts` | Audit: DataLoader plugin required in default App bootstrap; document failure mode if missing. |
| Tests | Integration test: list N entities with relation field → assert `dbQueryCount ≤ f(N)` (e.g. O(1) or O(types), not O(N)). |
| `docs/READ_PATH_PERFORMANCE.md` or CONFIGURATION | “How to diagnose N+1” section pointing at counters. |
| App services (consumer repos) | Out of framework core: ticket template for gamemode/service audits. |

### Acceptance criteria
- [ ] One framework integration test fails if a relation-resolving list regresses to per-entity queries.
- [ ] Default App construction wires DataLoaders (or throws/warns clearly in dev if not).
- [ ] Documented runbook: use access log `dbQueryCount` + `Query.explainAnalyze` to split “bad SQL” vs “too many SQL”.
- [ ] No silent path that disables batching for `@BelongsTo`/`@HasMany`.

### Measure
Reproduce old shape if possible: statement count before/after. Target list+relations: **constant** query count w.r.t. page size (batched), not linear.

---

## RP-06 — Keyset default ergonomics for component-sorted lists

**Status: DONE 2026-08-07 (06a docs + 06b throw)**

Shipped:
- Docs: plain `.cursor(id)` vs `.sortedCursor()`; worst-case no longer claims sortedCursor kills the fast path (`READ_PATH_PERFORMANCE.md`, `QUERY_LIST_GUIDE.md`).
- **RP-06b:** `cursor(entityId)` + `sortBy()` throws at exec (`query/Query.ts`) with message pointing at `sortedCursor`. Entity-column sort + component `sortBy` still throws (pre-existing).

### Problem
Keyset (`sortedCursor`) already rides the **sort-driven fast path** when used correctly. OFFSET and plain `.cursor(id)` with component sort are the footguns.

### Goal
Make the safe API the easy API; document and lightly enforce.

### Acceptance criteria
- [x] Docs and examples for sorted lists use `sortedCursor` + `take`, not OFFSET.
- [x] Combining incompatible pagination modes fails loudly (no silent wrong pages).
- [x] No performance regression on sort-driven + keyset path (already eligible).

### Out of scope / follow-ups
Multi-key keyset remains open (F-01). Single-key `direction: 'before'` landed (F-01 partial). GraphQL connection helpers remain app-layer.

### Measure
Deep page (e.g. page 500) latency: keyset stays flat; OFFSET grows — document in bench scenario if missing.

---

## RP-07 — Skip CTE internal `ORDER BY entity_id` when outer sort wrapper re-sorts

**Status: DONE 2026-08-07**

CTE emits `ORDER BY` + LIMIT only when it is the final ordering authority (no outer sort, filters not remaining outer). Tests: `CteOrderBy.test.ts`.

### Problem
`CTENode` always appends `ORDER BY entity_id` on the INTERSECT set (~74–80). When the outer query applies component/entity sort, that inner sort is wasted work (and can force materialization of the full intersected set before filters in some shapes).

### Goal
Emit CTE `ORDER BY` only when the CTE is the final ordering authority (unsorted list, id cursor, or pagination applied inside CTE without outer sort).

### Files
| Path | Change |
|------|--------|
| `query/CTENode.ts` | Gate `ORDER BY entity_id` on: no component/entity sort orders in context, **or** pagination finalized inside CTE without outer reorder. |
| `query/QueryContext.ts` | Expose a clear flag if needed (`hasOuterSort`, `sortOrders.length`). |
| Tests | Unsorted paginated query still deterministic by `entity_id`; sorted query plan/SQL lacks redundant inner ORDER BY. |

### Acceptance criteria
- [ ] Unsorted + LIMIT/OFFSET: still `ORDER BY entity_id` (stable pages).
- [ ] Component/entity sorted: CTE SQL has no redundant `ORDER BY entity_id` when outer ORDER BY exists.
- [ ] Invariant tests: paginate-all == unbounded set (no dupes/gaps) for unsorted and sorted.

### Measure
`EXPLAIN` on filtered multi-component sorted list: fewer Sort nodes or lower sort memory; wall time on large INTERSECT.

---

## RP-08 — Generated projected columns (M1) for fields that stay on legacy

**Status: OPEN.** Generated projected columns are not implemented.

### Problem
Expression indexes + JSONB extraction remain planner-weak vs real typed columns. Overlaps QSP for hot archetypes; still valuable for ad-hoc queries that never hit `rm_`.

### Goal
Opt-in `@CompData({ projected: true })` (or equivalent) → `GENERATED ALWAYS AS (...) STORED` on LIST leaf partitions + btree; Query emits `c.proj_field` when metadata says projected.

### Files
| Path | Change |
|------|--------|
| `core/components` decorators / metadata | `projected?: boolean` on `@CompData`. |
| `database/IndexingStrategy.ts` or migration helper | DDL for generated columns + indexes on leaf tables (LIST only; no-op + warn on HASH). |
| `query/ComponentInclusionNode.ts` | Prefer `proj_*` column in filter/sort SQL when present. |
| `docs/internal/RFC_MATERIALIZED_READ_MODELS.md` | Mark M1 implemented / link. |
| Tests | Registration creates column; filter SQL uses `proj_`; real-PG plan uses btree on projected col. |

### Acceptance criteria
- [ ] Projected Number/text fields filter/sort without `data->>'…'` in emitted SQL.
- [ ] Non-projected fields unchanged.
- [ ] Rebuild/reconcile story: drop+re-add column is safe (JSONB remains SoT).
- [ ] QSP and M1 can coexist; no double-maintenance bugs on save.

### Depends
Prefer RP-04 first if projected path still creates partial numeric indexes.

### Measure
Filter+sort on single hot component: index-only or index scan on `proj_*`; compare to expression-index baseline.

---

## Follow-ups (not scheduled as core tickets)

| ID | Item | Notes |
|----|------|--------|
| F-01 | Multi-key keyset + `direction: 'before'` | **Done (post-0.7.0):** N-key `sortedCursor` with mixed directions, per-key NULLS, and `'before'` for component sorts, `sortByCreatedAt` + `sortByUpdatedAt`, and OR + multi-sort. Legacy single-key tokens still decode. QSP still routes multi-sort to legacy. |
| F-02 | Composite list-shape indexes (equality → range → entity_id) | After RP-03/04 so SQL can use them |
| F-03 | CTE LIMIT pushdown when filters selective | Harder correctness; after RP-03 |
| F-04 | OR + component sort uses sort-driven or rm_ | Currently JOIN wrapper full sort |
| F-05 | Count result cache (short TTL by query signature) | Alternative to estimate for dashboards |
| F-06 | M2/M3 explicit `@ReadModel` for cross-entity reports | **Stage A shipped 2026-08-20** (`m3_*`, write-through, range/`IN`/`count`/`avg`, live GraphQL Query resolvers). Remaining: outbox/multi-instance, daily fact grain, typed join |
| F-07 | Tag / `.without` membership columns on `rm_*` | Empty tags currently break QSP coverage; product lists often need tags |
| F-08 | List-archetype subset / explicit `routeAs` | Route when query set matches list surface without hand-dropping tags |
| F-09 | GraphQL list hydrate / ArcheTypeFunction DataLoaders by default | **Done (post-0.7.0):** resolvers attach at schema build and short-circuit populated parents (0.7.0); `@ArcheTypeFunction({ batch: true })` runs once per request batch per distinct args. |
| F-10 | `Query.aggregate` / groupBy helpers | Kill `take(50k)` analytics patterns |
| F-11 | Wire `startReconcileSweep` from App when QSP ≠ off | **Done (2026-09-24).** `App.init()` starts the sweep when `BUNSANE_QSP` is `shadow` or `route`; shutdown stops it. `docs/QSP_OPERATIONS.md` no longer tells apps to start a second sweep. |

`docs/READ_PATH_PERFORMANCE.md` §4 row E and §6 step 5a note the F-01 partial. `docs/QSP_OPERATIONS.md` records F-11.

---

## Suggested implementation waves

### Wave A — ship this sprint (no schema drama)
1. **RP-01** hasNextPage legacy  
2. **RP-04** numeric index  
3. **RP-07** CTE ORDER BY gate  
4. **RP-06** docs + API footgun guards  

### Wave B — engine SQL shape
5. **RP-03** coalesce + INTERSECT pushdown  

### Wave C — production scale path
6. **RP-02** QSP rollout (can run **in parallel** with Wave A as pure ops once shadow-ready)  
7. **RP-05** N+1 gates (parallel anytime)  

### Wave D — structural (after A–C)
8. **RP-08** generated columns  

---

## Verification checklist (every ticket)

```bash
# Types
tsc --noEmit

# Fast suite
bun run test:pglite:unit
bun tests/pglite-setup.ts tests/integration/query/

# Real PG (required for index/plan claims: RP-03, RP-04, RP-08)
bun tests/pg-setup.ts tests/integration/query/

# Plan truth
# use Query.explainAnalyze(true) in a one-off script or test
```

Update `docs/READ_PATH_PERFORMANCE.md` §4–§6 when RP-01/03/04/06 land so the canonical analysis matches the code (especially the sortedCursor vs plain cursor distinction).

---

## Ticket one-liners (for tracker paste)

| ID | Title |
|----|--------|
| RP-01 | Legacy Query: LIMIT+1 hasNextPage; exact count opt-in only |
| RP-02 | QSP: shadow soak → route hot archetypes; validate hydrate |
| RP-03 | BUG-2: coalesce same-comp filters; push filters into INTERSECT |
| RP-04 | BUG-1: numeric indexes usable by emitted SQL |
| RP-05 | Per-request dbQueryCount gates for GraphQL list+relations N+1 |
| RP-06 | Keyset ergonomics + fix stale “cursor kills fast path” docs |
| RP-07 | CTENode: skip internal ORDER BY when outer sort exists |
| RP-08 | M1 projected generated columns for legacy list fields |
