# RFC: Query Surface Planner — Transparent Columnar Read Models

**Status:** Draft / experimental (`experimental/query-surface-planner`)
**Date:** 2026-07-08
**Depends on / reads:** `docs/READ_PATH_PERFORMANCE.md` (cost-center analysis), `docs/RFC_MATERIALIZED_READ_MODELS.md` (M1/M2/M3 tiers this supersedes as the *default* path), `docs/RFC_ECS_PG_SORT_DENORMALIZATION.md`
**Scope:** Query READ path for archetype list views (filter + sort + paginate + count). Write path changes only to synchronously maintain projections. No developer-facing API change.

---

## 1. Summary

BunSane stores each entity's fields across K JSONB component rows (`components`, LIST-partitioned by `type_id`). Reconstructing a logical record for a filtered/sorted/paginated list query forces `INTERSECT` + N `EXISTS` + a correlated scalar-subquery sort + a second full-cardinality `COUNT(*)`. Cross-component fields live in different physical rows, so **no composite covering index across them can exist** — the structural ceiling.

This RFC introduces a **Query Surface Planner**: a coverage-based router that transparently serves fully-covered archetype list queries from a **synchronously-maintained per-archetype columnar table** (`rm_<archetype>`), falling back to today's compiler for anything uncovered. The developer-facing ECS/GraphQL API is unchanged. `components` remains the authoritative write store; `rm_` tables are derived, disposable, and never a source of truth.

**Design = R4** from the architecture discussion: **R3** (per-archetype typed projection tables) as the primary surface + **R1** (a thin generic `entities` accelerator) as a narrow fallback, chosen by a cost/coverage planner.

### 1.1 Before / after (worst-case list query)

`.with(Order,{status,total>N}).with(Customer,{tier}).sortBy(Order,'total','DESC').take(20)` + `count()`:

**Before** — INTERSECT + 3× EXISTS + correlated scalar-subquery ORDER BY + separate COUNT.
**After** — routed to `rm_order`:
```sql
SELECT entity_id FROM rm_order
WHERE deleted_at IS NULL
  AND status = $1 AND customer_tier = $2 AND total > $3
  AND (total, entity_id) < ($cursor_total, $cursor_id)   -- keyset
ORDER BY total DESC, entity_id ASC
LIMIT 21;                                                 -- N+1 → hasNextPage; no separate count
```
Served by one covering index:
```sql
CREATE INDEX CONCURRENTLY idx_rm_order__status_tier_total_id
  ON rm_order (status, customer_tier, total DESC, entity_id)
  INCLUDE (created_at, updated_at)
  WHERE deleted_at IS NULL;
```

---

## 2. Goals, non-goals, invariants

### Goals
- Serve fully-covered archetype list queries from a single relational table: index-range scan, LIMIT pushdown, keyset pagination, cheap/approx count.
- Zero developer-facing API change.
- Read-after-write consistency on the default path.
- Instant, per-archetype rollback (planner flag).
- Backfill/consolidation that never blocks reads/writes and never returns wrong results.

### Non-goals
- Not a general secondary-index engine for arbitrary ad-hoc cross-archetype queries (those keep the legacy path).
- Not an async/eventually-consistent read model (default maintenance is synchronous, same-transaction).
- No non-stock Postgres extensions (no Citus, no columnar ext).

### Hard invariants
- **I1 — API immutability:** `@Component`/`@CompData`, `entity.add/set/get/save`, `Query.with/filter/sortBy/take/cursor/exec/count`, GraphQL auto-schema, relations `@BelongsTo/@HasMany` behave identically.
- **I2 — read-after-write:** save an entity, immediately query/filter it → it appears. No staleness on the default path.
- **I3 — correctness independent of projection:** an incomplete/stale/absent projection must only degrade *speed*, never produce a wrong result. Enforced by the READY gate (§7).

---

## 3. Architecture overview

```
                       ┌───────────────────────────┐
   Query.exec()  ──▶   │   Query Surface Planner    │
                       │  compute coverage set      │
                       └───────────┬───────────────┘
             fully covered?        │
         ┌──────────yes────────────┼───────────no────────────┐
         ▼                         ▼                          ▼
   rm_<archetype>            entities accel (R1)        legacy compiler
   (typed columns,          (generic hot fields)       (INTERSECT + EXISTS
    covering index)                                     + scalar-subquery sort)
         │                         │                          │
         └──────────── id-set ─────┴──────────────────────────┘
                                   │
                          hydrate from components (unchanged)
```

- **Projection surface:** `rm_<archetype>` tables (R3). Columns auto-derived from the archetype's declared component set.
- **Accelerator surface:** widened `entities` row for framework-global / declared-hot fields (R1), used when no single archetype covers the query but the predicates are global.
- **Planner:** picks a surface by *coverage* (all predicates + sort + cursor + null-ordering map to that surface's columns) and *readiness* (§7). Otherwise falls back.
- **Maintenance:** synchronous upsert/delete inside `Entity.save()`/delete transaction.
- **Consolidation:** dual-write-first + background keyset backfill + READY-gated routing (§7).

---

## 4. Data model

### 4.1 Projection table `rm_<archetype>`

One row per entity of that archetype. Columns = projected scalar fields from the archetype's components, prefixed by component to avoid collisions, plus bookkeeping.

Example — archetype `OrderListView` requiring `Order` + `Customer`:
```sql
CREATE TABLE rm_orderlistview (
  entity_id      uuid PRIMARY KEY,
  -- projected scalars (component-prefixed)
  order_status   text,
  order_total    numeric,
  customer_tier  text,
  -- entity-level columns mirrored for sort/paginate
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  deleted_at     timestamptz,
  -- bookkeeping
  shape_version  int NOT NULL,
  -- optional overflow for occasionally-needed non-projected fields
  extra          jsonb
);
```

Column rules:
- Type from `@CompData` property type: `Number → numeric`, `Date → timestamptz`, `boolean → boolean`, else `text`.
- Only **scalar** projected fields become columns. Arrays/objects stay in `components` (queried via legacy GIN path) unless explicitly projected to `extra` + expression index.
- `created_at/updated_at/deleted_at` mirror `entities` so sort/paginate/soft-delete stay on one row.
- `shape_version` gates per-row consolidation state (§7.4).

### 4.2 Which fields get projected

Auto-derived, no new required decorator. Sources, in priority:
1. `@CompData({ indexed: true })` fields of the archetype's components → projected (they're already declared "hot/filterable").
2. Fields referenced by the archetype's generated GraphQL list operation filter/sort args.
3. Optional explicit override: `@Projected()` field decorator or `@ArcheType({ project: [...] })` to add/remove.

Non-projected fields remain fully queryable via the legacy path; a query touching them simply won't route to `rm_`.

### 4.3 Index shapes

Per declared list shape (equality cols → range/sort col → `entity_id` tiebreak), partial on `deleted_at IS NULL`, covering via `INCLUDE`:
```sql
CREATE INDEX CONCURRENTLY idx_rm_orderlistview__status_tier_total_id
  ON rm_orderlistview (order_status, customer_tier, order_total DESC, entity_id)
  INCLUDE (created_at, updated_at)
  WHERE deleted_at IS NULL;
```
Plus, as needed: BRIN on `created_at` for time dashboards; extended statistics on correlated projected columns (`CREATE STATISTICS`); partition `rm_` by tenant/time where cardinality justifies.

### 4.4 Projection state table

```sql
CREATE TABLE projection_state (
  archetype       text NOT NULL,
  shape_hash      text NOT NULL,     -- hash of projected column set + types (§8)
  status          text NOT NULL,     -- DISABLED | BACKFILLING | READY | REBUILDING
  shape_version   int  NOT NULL,     -- monotonic per archetype
  watermark       uuid,              -- last entity_id backfilled (keyset resume)
  field_state     jsonb NOT NULL,    -- per-column readiness for additive changes (§7.4)
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archetype)
);
```
The planner reads `projection_state` (cached, invalidated on change) to decide routing.

### 4.5 R1 generic accelerator (`entities` widening) — optional, phase 5+

Add narrow maintained columns to `entities` for *framework-global* or declared cross-archetype-hot fields only (NOT a dumping ground). Same maintenance + gating rules. Used when a query's predicates are global but no single archetype covers it. Kept deliberately small — codex: "the global entities table must not become a thousand-column universal fact table."

---

## 5. The Query Surface Planner

### 5.1 Coverage set

On `.exec()`/`.count()`, before SQL generation, compute:
```ts
interface CoverageRequest {
  requiredComponents: TypeId[];     // from .with()
  filters: { component, field, op, value }[];
  sorts:   { component, field, dir, nullsFirst }[];
  cursor?: { kind: 'keyset'|'id', ... };
  excluded: ...;                    // .without(), excludeEntityId
}
```
A surface **covers** the request iff:
- an archetype (or the entities accelerator) whose component set ⊇ `requiredComponents`, AND
- every `filters[i].field`, `sorts[i].field`, cursor key, and null-ordering maps to a **ready** column of that surface (§7.4 field readiness), AND
- no `.without()`/exclusion or operator the surface can't express (e.g. JSONB array `HAS_ANY` on a non-projected array field) is present.

Choose the **most specific** covering archetype (smallest superset). Ties → the one with a matching covering index (catalog check or declared index registry).

### 5.2 Routing decision

```
coverage = planner.resolve(request)
if coverage.surface && coverage.status == READY && flagEnabled(archetype):
    emit rm_ / entities-accel plan          # fast lane
else:
    emit legacy DAG plan                     # unchanged
```
**Partial coverage is never routed** (I3). Optionally, a covered-prefix may drive a legacy sub-scan as a prefilter (phase 6+, off by default).

### 5.3 rm_ plan generation

- Filters → `col op $n` directly (typed columns; no `data->>` casts).
- Sort → `ORDER BY sort_cols…, entity_id ASC` (keyset tiebreak preserved).
- Pagination → **keyset default** (`(sort_col, entity_id) </> ($v,$id)`); OFFSET only if explicitly requested (legacy compat).
- Page + "has next" → fetch `LIMIT n+1`, derive `hasNextPage`; **no separate count** unless caller invoked `.count()`.
- `.count()` → configurable: (a) exact `SELECT count(*)` over the same partial index (far cheaper than the JSONB path), (b) `count(*) OVER()` folded into the page when both requested, (c) estimate from stats. Default: exact over `rm_` (cheap), opt into estimate for huge sets.
- Result = `entity_id[]` → hydrate from `components` via existing populate/DataLoader (unchanged). `rm_` is an **index surface, not a data surface**; it returns ids only (plus values already needed for keyset).

### 5.4 Fallback contract

Fallback must be **transparent and identical in results** to a routed query (same id-set, order, count). This is asserted continuously by shadow dual-run (§11). Any surface that can't guarantee identity for a request → fall back.

---

## 6. Write-path maintenance (synchronous)

### 6.1 Dual-write in `Entity.save()`

In `core/entity/saveEntity.ts`, inside the **same transaction** as component upserts, after components are written:
```
for each archetype A projecting any component touched by this entity:
    values = projectEntity(entity, A)         # extract scalar fields from in-memory/just-written comps
    UPSERT rm_<A> (entity_id, <cols>, created_at, updated_at, deleted_at, shape_version)
      VALUES (...) ON CONFLICT (entity_id) DO UPDATE SET <cols>=EXCLUDED...., updated_at=EXCLUDED...
```
- Same-trx commit → **I2 holds**: reads after commit see both component and projection.
- Live writes use **DO UPDATE** (always win vs backfill's DO NOTHING, §7.2).
- Only archetypes affected by the touched components are upserted (dependency map §6.4).

### 6.2 Delete / soft-delete

Must be synchronous, **not** a post-commit `queueMicrotask` side-effect:
- Soft delete → `UPDATE rm_<A> SET deleted_at = $ts WHERE entity_id = $id` in the delete trx (partial index `WHERE deleted_at IS NULL` then excludes it).
- Hard delete / component removal → `DELETE FROM rm_<A> WHERE entity_id=$id`, or re-project if the entity still qualifies for the archetype with remaining components.

### 6.3 Manual `comp.save(trx)` / out-of-band writes

Any write path that mutates component data **outside** `Entity.save()` must either (a) route through the same projection maintenance, or (b) be declared projection-incompatible so the reconcile sweep (§7.6) catches drift. Enumerate and gate these during phase 1 (audit `componentAccess.ts`, `finders.ts`, cache write-through paths).

### 6.4 Shared-component fanout

A component projected into multiple archetypes (e.g. `Customer.tier` → `rm_orderlistview`, `rm_customerlistview`, …) must update **all** dependent `rm_` rows on write. Maintain an archetype→components dependency map (derivable from archetype metadata). On a `Customer` write, fan out to every dependent archetype row for the affected entities. Batch the fanout; if a component fans out to > N archetypes, log/flag (write-amplification guard). Cross-entity fanout (changing a customer updates *many* orders' projections) is only relevant if the projection denormalizes another entity's field — see §6.5.

### 6.5 Cross-entity denormalization (relations)

If `rm_order.customer_tier` denormalizes a *related* entity's field (Order → Customer via `@BelongsTo`), a `Customer` update must propagate to all its orders' `rm_` rows. Two options:
- **Phase-gated:** initially **do not** denormalize cross-entity fields — project only same-entity components. Cross-entity filters fall back to legacy. (Simplest; covers most single-archetype list views.)
- **Later:** relation-aware fanout with a dependency index `customer_id → order entity_ids`, batched, and a bounded fanout budget. Documented as an explicit opt-in per field.

Default for phase 1–4: **same-entity projection only.** Cross-entity denormalization is an explicit later phase.

---

## 7. Consolidation & backfill

Governing principle (I3): **routing is gated on a per-(archetype, shape-version) READY marker; correctness never depends on `rm_`.** Incomplete → fall back → correct but slower.

### 7.1 Case I — initial enable

| Step | Action | `status` |
|---|---|---|
| 1 | Create `rm_<A>` + `projection_state` row; compute `shape_hash` | `BACKFILLING` |
| 2 | **Deploy same-trx dual-write** (all live saves upsert `rm_`, DO UPDATE). Must be live *before* step 3 | — |
| 3 | Background keyset backfill over `components` by `entity_id`, batched (~5k), throttled, resumable via `watermark`: `INSERT … SELECT … ON CONFLICT (entity_id) DO NOTHING` | — |
| 4 | watermark → end; verify (count + sample shape-hash vs components); set READY | `READY` |

Reads in steps 1–4 use legacy (correct). READY flip = instant; rollback = set `DISABLED`.

### 7.2 Race safety (backfill vs live write)

- Live write: `DO UPDATE` (wins). Backfill: `DO NOTHING` (never clobbers a live row).
- Both interleavings resolve to the live (newer) value:
  - backfill-reads-old → live-writes-new(DO UPDATE) → backfill-flush(DO NOTHING, conflict) ⇒ new ✓
  - backfill-flush(old) → live-writes-new(DO UPDATE) ⇒ new ✓
- Entities created mid-backfill are dual-written at creation; `DO NOTHING` protects them regardless of UUID ordering. **Dual-write-before-backfill is the linchpin.**

### 7.3 Multi-instance / crash coordination

- Backfill job holds an advisory lease (reuse the pluggable `LockBackend`, postgres-lease default) so only one instance backfills an archetype at a time.
- Batch commits + `watermark` persisted per batch → crash resumes from last watermark. `DO NOTHING` makes re-processing a batch idempotent.
- Live dual-write runs on **all** instances (it's in the normal save path), independent of which instance backfills.

### 7.4 Case II — shape change later

Per-column readiness lives in `projection_state.field_state` (`{ "order_priority": "FILLING" | "READY" }`). The planner treats a non-READY column as **not coverable** — queries using it fall back until its fill completes.

- **II-a Add field (common, cheap):** `ALTER TABLE rm_<A> ADD COLUMN order_priority int` — instant (nullable, no rewrite). Bump `shape_version`; live writes populate it; mark `field_state[col]=FILLING`. Background fill (`UPDATE … FROM components …` batched, DO-NOTHING-equivalent guard on already-live rows via `WHERE rm.updated_at < backfill_start` or a per-row `shape_version` check). On completion → `field_state[col]=READY` → column becomes routable. **Existing fast-lane queries on old columns keep working throughout.**
- **II-b Type change / rename / semantic change (rare):** blue/green — build `rm_<A>_v2`, dual-write both, backfill v2 (Case I), atomically flip planner v1→v2 (`shape_version`++), drop v1. Zero read downtime.
- **II-c Remove field:** stop writing it; drop column (or leave, unused). Queries using it fall to legacy.

Per-row `shape_version` lets the fill target only stale rows: `UPDATE … WHERE shape_version < $current` batched.

### 7.5 Why not generated columns / wide-row

`ALTER TABLE … ADD COLUMN … GENERATED ALWAYS STORED` on an existing large table **rewrites and locks** it. App-maintained `rm_` + instant nullable `ADD COLUMN` + background fill avoids blocking DDL entirely. Wide-row (R2) was rejected for whole-entity-rewrite write amplification.

### 7.6 Drift reconcile sweep

Periodic background job samples `rm_` rows, recomputes the projection from `components`, compares by shape-hash. Mismatch → re-project those entities. Catches missed out-of-band writes (§6.3), crashed batches, fanout gaps. Since truth is `components` and routing is READY-gated, drift degrades speed, not correctness; the sweep restores speed. Emits a drift metric.

### 7.7 Scale

Thousands of entities → backfill in seconds. Millions → throttled background sequential pass (minutes–low hours), batched, resumable, low priority, off the request path, no locks. One-time per shape-version. Bounded to projected (hot) archetypes only.

---

## 8. Shape hashing & versioning

`shape_hash = hash(sorted[ (component, field, sqlType) ] + index-shape declarations)`. Stored in `projection_state`. On boot, compare declared shape vs stored:
- equal → no-op.
- additive → II-a path (add columns, fill, bump version).
- incompatible (type/rename/remove) → II-b path (blue/green) or gated behind an explicit migration ack.

`shape_version` is monotonic per archetype; used for per-row staleness targeting and planner cache invalidation.

---

## 9. Configuration

| Flag | Default | Effect |
|---|---|---|
| `BUNSANE_QSP_ENABLED` | `false` (experimental) | master switch for the planner |
| `BUNSANE_QSP_ARCHETYPES` | `''` | comma list of archetypes to project (empty = none; `*` = all with an opt-out list) |
| `BUNSANE_QSP_MODE` | `shadow` | `off` \| `shadow` (run both, serve legacy, compare) \| `route` (serve rm_) |
| `BUNSANE_QSP_COUNT` | `exact` | `exact` \| `estimate` \| `n_plus_1` for count strategy |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | backfill batch size |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | inter-batch sleep |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | enable R1 generic accelerator |

Per-archetype rollback = remove from `BUNSANE_QSP_ARCHETYPES` or set its `projection_state.status=DISABLED`.

---

## 10. Phased implementation plan

Each phase is independently shippable and reversible. Land on the experimental branch; do not merge to main until phase 6 parity holds.

**Phase 0 — Ceiling proof (no framework code).**
Hand-build `rm_order` + covering index on a real-PG scratch DB (`tests/pg-setup.ts`), seed a tier, run the after-SQL vs the current before-SQL under `EXPLAIN (ANALYZE, BUFFERS)`. Record the measured speedup. Gate the whole RFC on a convincing number. (See `docs/READ_PATH_PERFORMANCE.md` §7 for method.)

**Phase 1 — Metadata + shape hashing.** Derive projected columns from archetype component set; compute `shape_hash`; `projection_state` table + migrations. No table creation, no routing. Audit + enumerate out-of-band write paths (§6.3).

**Phase 2 — Projection table + synchronous maintenance.** DDL generator for one archetype behind a flag; dual-write/delete in `saveEntity.ts` (+ delete path); dependency map for same-entity fanout. Backfill job (advisory-leased, resumable, DO NOTHING).

**Phase 3 — Planner (shadow mode).** Coverage computation + routing decision; `rm_` plan generation. `BUNSANE_QSP_MODE=shadow`: serve legacy, run `rm_` in parallel, assert id-set + order + count parity, log divergences. This is where projection bugs die.

**Phase 4 — Route mode + keyset/count.** `BUNSANE_QSP_MODE=route` per archetype after shadow parity is clean for a soak period. Keyset default, N+1 hasNextPage, count strategies.

**Phase 5 — R1 generic accelerator (optional).** Narrow `entities` widening for global hot fields + planner integration.

**Phase 6 — Legacy demotion.** For covered archetypes, delete/short-circuit CTE/INTERSECT, correlated scalar-subquery sort, one-EXISTS-per-filter emission. Only after broad parity + soak.

**Phase 7 — Cross-entity denormalization (optional, explicit opt-in).** Relation-aware fanout for denormalized related-entity fields (§6.5), bounded budget.

---

## 11. Parity & testing

- **Shadow dual-run harness (phase 3):** for every routed-eligible query, execute both surfaces, assert identical `entity_id[]` (order-sensitive), identical `count()`, identical `hasNextPage`. Divergence → structured log + metric + auto-fallback. Run across the benchmark tiers.
- **Property tests:** random `.with/.filter/.sortBy/.cursor` combos → parity legacy vs rm_.
- **Read-after-write tests:** save → immediate filtered query → row present (same connection and cross-connection).
- **Backfill race tests:** interleave live writes with a running backfill on a scratch DB; assert final rm_ == projection(components) for all entities.
- **Shape-change tests:** add-field (II-a) mid-traffic → old queries keep serving, new-field queries fall back then route after fill; blue/green (II-b) flip.
- **Real-PG only** for index/partition/plan assertions (`tests/pg-setup.ts`); PGlite acceptable for planner-logic unit tests (routing decisions, coverage), NOT for plan shape.
- **EXPLAIN assertions:** routed plans show `Index Scan`/`Index Only Scan` on the covering index, no `Seq Scan` on `data->>`, no `SubPlan` in ORDER BY.

---

## 12. Observability

Metrics: `qsp_route_total{archetype,surface}`, `qsp_fallback_total{reason}`, `qsp_shadow_divergence_total{archetype}`, `qsp_backfill_progress{archetype}` (watermark %), `qsp_drift_total{archetype}`, projection maintenance latency added to save. Access log gains `qsp_surface` (rm_ | entities | legacy) per request. A divergence or drift spike is the alarm that a projection bug shipped.

---

## 13. Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| Projection incomplete during backfill | READY gate → fall back (correct, slower) |
| Backfill clobbers live write | `DO NOTHING` on backfill; live `DO UPDATE` |
| Crash mid-backfill | watermark resume + idempotent DO NOTHING |
| Two instances backfill same archetype | advisory lease (LockBackend) |
| Out-of-band component write bypasses maintenance | enumerate+route in phase 1; reconcile sweep catches residue |
| Shared-component fanout missed | dependency map; reconcile sweep; fanout metric |
| Shape change adds a field | instant ADD COLUMN + per-field readiness gate |
| Type/rename change | blue/green v2 flip |
| Planner routes a half-covered query | strict full-coverage rule; shadow parity gate |
| rm_ drift from components | periodic reconcile → re-project |
| Cross-entity denormalization staleness | phase-gated off by default; relation-aware fanout only when opted in |

---

## 14. Files changed / deleted

**Changed / added:**
- `core/entity/saveEntity.ts` — synchronous projection upsert/delete.
- `core/archetype/decorators.ts`, `core/components/Decorators.ts`, `core/metadata/*` — projected-column metadata, shape hashing.
- `core/ArcheType.ts` — expose archetype component set + projection descriptor.
- `database/IndexingStrategy.ts` — `rm_` DDL, covering/partial index generation, additive `ADD COLUMN`.
- `query/Query.ts`, `query/QueryDAG.ts` — planner entry, coverage computation, routing.
- `query/membershipSource.ts` — register `rm_`/entities as routable surfaces.
- `query/ComponentInclusionNode.ts`, `query/CTENode.ts`, `query/OrNode.ts` — legacy remains; short-circuited for covered archetypes in phase 6.
- **New:** `query/planner/` (coverage + routing), `database/projection/` (DDL gen, backfill job, reconcile sweep, projection_state), `scheduler` task for backfill/reconcile.

**Deleted / demoted (phase 6, covered archetypes only):** CTE/INTERSECT branch, correlated scalar-subquery sort path, one-EXISTS-per-filter emission, broad membership scans.

**Untouched (I1):** every decorator, `Entity` API, `Query` fluent surface, GraphQL generation, relations, component cache/DataLoader.

---

## 15. Open decisions

1. **Projection scope** — auto-derive-but-lazy (create `rm_` on first list query per archetype) vs explicit opt-in list (`BUNSANE_QSP_ARCHETYPES`). *Leaning:* explicit opt-in for phase 1–4 (bounded blast radius), auto-lazy later.
2. **Count default** — exact-over-rm_ vs N+1-hasNextPage-only (drop exact from default list API). *Leaning:* N+1 default, exact opt-in (kills cost center D outright).
3. **Cross-entity denormalization** — ship never / opt-in field / relation-aware default. *Leaning:* opt-in field, phase 7.
4. **R1 accelerator** — build now or defer. *Leaning:* defer to phase 5; R3 covers the hot cases.
5. **`extra jsonb` on rm_** — include for occasional non-projected fields, or force fallback. *Leaning:* omit initially; fallback is correct and simpler.

---

## 16. Relationship to existing RFCs

Supersedes `RFC_MATERIALIZED_READ_MODELS` M2/M3 **as the default transparent path**: those framed materialization as an opt-in resolver swap; this makes it a coverage-routed default with synchronous maintenance and consolidation. M1 (generated columns on component partitions) remains a valid *single-component* accelerator and can coexist under the planner as another coverable surface. `RFC_ECS_PG_SORT_DENORMALIZATION`'s keyset/derived-reconcile principles are realized here (keyset default, derived-not-migrate, reconcile sweep).
