# RFC: ECS-on-PG Sort / Filter / Pagination — Denormalization Strategy

Status: **PARKED** (brainstorm only, not scheduled). Captured 2026-06-21.
Companion: `docs/QUERY_SORT_PAGINATION_PLAN.md` (the two correctness fixes #1/#2).

## Problem statement

BunSane stores entities and components in separate tables; component data is
JSONB. Sorting / filtering / paginating across components is structurally
expensive because **id + membership + sort-key live on three different
tables**:

- `entities` — id, created_at, updated_at
- membership — `components` (or per-type partition `components_<name>`), type_id
- sort key — JSONB `data->>'field'` inside the component row

No single row or index spans all three, so every sorted query is a
join/INTERSECT + per-row JSONB extraction, and keyset cursors are hard. This
is the inherent ECS-on-PG tax, not a bug.

Symptoms already found:
- No `ORDER BY` tiebreak anywhere → unstable OFFSET pagination on non-unique
  sort keys (Fix #1).
- `.cursor()` only walks `entity_id`, incompatible with `.sortBy()` (Fix #2).
- Multi-component sort materializes the full INTERSECT set then sorts via
  correlated subqueries (`ComponentInclusionNode.applySortingWithComponentJoins`).

## Verdict: do NOT build a Postgres extension

1. **Managed PG kills it.** RDS / Supabase / Neon / Cloud SQL only load
   allow-listed extensions. A custom `.so` can't be installed → portability
   dead. BunSane already optimizes hard for portability (pgbouncer toggle,
   PGlite). A custom extension throws that away.
2. **PG already has the primitives.** Expression btree, generated columns,
   partial indexes, partitioning, LATERAL, keyset, BRIN. The framework already
   builds expression + numeric btree indexes (`IndexingStrategy.ts:80,220`).
   The pain is the **data model**, not a missing engine feature.
3. **Custom index AM = months**, version-locked to PG internals, fragile.
   Only justified to span entity+components in one structure — which is just a
   denormalized projection, far cheaper as a table.
4. The two known gaps are **correctness** (tiebreak, keyset), fixable in
   vanilla SQL. An extension solves neither better.

Only extensions worth *evaluating later*, both optional + managed-gated:
- **pg_ivm** — incremental matview maintenance (cheap projection refresh if
  projections are expressed as matviews). Degrade to hook-driven upsert when
  absent.
- **RUM** — GIN-with-ordering (ordered full-text). Niche; helps `fulltext`
  CompData ordered results only.

Neither may be a default; framework must run on stock managed PG.

## The core principle

**JSONB stays the single source of truth, always. Every derived structure
(index, generated column, projection table) is disposable and reconstructable
from JSONB.** Therefore "migration" of derived schema is never a data
migration — it is a **reconcile / rebuild**, idempotent, zero data-loss risk.
Only cost is rebuild time. This is what makes denormalization tractable here.

## Solution ladder (Gall's law: evolve simple → complex)

### L0 — have it
Expression btree / numeric indexes per `@CompData({ indexed })`. Single-
component sort is already index-backable.

### L1 — generated stored columns (cheap, high leverage)
Replace runtime `(data->>'x')::numeric` with
`col GENERATED ALWAYS AS ((data->>'x')::numeric) STORED` + btree.
- Planner gets a real **typed, ordered** column → index-only scans, LIMIT
  pushdown, clean keyset, correct numeric ordering (also fixes sort gap #5).
- Pure DDL, no extension, evolves the existing partition tables.
- Opt-in per field (e.g. `@CompData({ indexed: true, sortable: true })`).

### L2 — composite keyset cursor `(sort_value, entity_id)`
= Fix #2 in the companion plan. Trivial vanilla SQL once L1 gives a typed
column. Turns deep-pagination OFFSET O(offset) into keyset O(limit).

### L3 — per-archetype read-model / projection table (end-game)
One wide row per entity per archetype: a real typed column per queried/sorted
component field. Component tables remain source of truth; write fans out +
upserts the projection. Reads/sort/paginate/multi-field-sort/filter hit the
wide table = plain indexed SQL, no INTERSECT, trivial keyset.
- Classic CQRS read model.
- Refresh paths already owned by the framework: post-commit hooks
  (`queueMicrotask`) or the **outbox / RemoteManager** infra (async
  projection). Start opt-in for ONE hot archetype, not framework-wide.

### L4 — scale-out (later, orthogonal)
Tenant partitioning, Citus.

## Migration mechanics for derived schema

Today field changes are FREE (JSONB schema-on-read; no migration framework,
no versioning — only a one-time timestamptz ALTER in `DatabaseHelper.ts`).
Denormalization trades some of that away, but bounded by the source-of-truth
principle:

**L1 generated columns**
- Add sortable field → `ALTER TABLE ADD COLUMN ... GENERATED` (PG auto-backfills
  → table rewrite + lock on big tables = the one real cost).
- Remove → `DROP COLUMN` (cheap). Rename/retype → drop old gen col + add new
  (re-backfill). **JSONB data untouched throughout.**
- Big-table mitigation: nullable plain column + batched backfill via outbox,
  then attach index — avoids the rewrite lock.

**L3 projection**
- Field change → **rebuild, don't migrate.** Blue-green: build `projection_v2`
  from components, batch-backfill (outbox/hooks), atomic `RENAME`. Zero
  downtime, zero data risk. Or incremental `ADD COLUMN` nullable +
  batched `UPDATE ... FROM components_x`.

**What to build: a derived-schema reconciler (NOT a migration framework)**
A general migration runner fights Gall's law and JSONB makes data migrations
unnecessary. Instead:
1. Compute a **shape hash** per component of its sortable/projected field set
   (name + type + indexType).
2. Persist it (small `bunsane_derived_schema` table, or component-table
   comment).
3. Startup: shape hash changed → reconcile that table's generated cols /
   projection (ADD / DROP / rebuild). Unchanged → skip (cheap no-op).
4. Mirror the existing `UpdateComponentIndexes` add-and-drop pattern
   (`DatabaseHelper.ts:318`).

**Pre-existing index gaps to fold in while here** (they bite even before
L1/L3):
- `@IndexedField` / `ensureJSONBPathIndex` path is **additive-only** → stale
  index leaks on field remove / un-index / retype (`IndexingStrategy.ts`, no
  DROP path). The legacy `@CompData({indexed})` path already reconciles both
  ways; the new path needs the same DROP path.
- `indexType` change doesn't drop the old index (drop regex matches `_gin`
  only).

## Expected gain (estimates — confidence noted; MEASURE before building)

Gain ≈ `f(rows × pagination_depth / LIMIT)`.

| Scenario | Gain | Confidence |
|----------|------|-----------|
| Top-N sort, large table, no index today (`sortByCreatedAt().take(50)` / 1M rows) | 10–1000× | high |
| Sort where expression index already exists | 1.2–3× (+ numeric-order correctness) | high |
| Multi-component INTERSECT + sort, L1 only | ~1.5–3× | med |
| Multi-component list/sort/paginate at scale, **L3** | 10–100× + flat pagination | med |
| Deep pagination (**L2 keyset**), page 1000+ | 100–1000× | high |
| Page 1, small table (<10k rows) | ~0× | high |

Cost side (net honesty): reads 10–100× faster, **writes ~10–30% slower**
(extra upsert — same order as the +30% measured for the data-GIN work),
more disk. Worth it iff reads dominate and tables are big.

Decision gate by scale:
- **< ~10k rows/archetype** → current JSONB path already fine; L1/L3 premature
  (net loss from write-amp + migration cost). Only add `entities(created_at)`
  index for the shipped entity-sort.
- **100k–10M+ rows + sorted dashboards + deep pagination** → L1+L2+L3 justified.

## Cheapest first win (independent of the rest)
The entity-column sort shipped 2026-06-21 has **no index on
`entities.created_at` / `updated_at`** — the wrapper sorts the matched set
unindexed. A single `CREATE INDEX ON entities (created_at)` (+ updated_at) is
the smallest, safest first step.

## Recommended path (when revisited)
Measure first (seed 100k/1M, baseline vs +indexes, diff p50/p95 using
`tests/benchmark/query-*` + `tests/stress` + k6). Then, if reads dominate at
scale: L1 generated columns → L2 keyset → L3 opt-in projection reusing the
outbox. No custom extension.

## Open questions
- Row counts for hottest sorted archetypes (stockMovements / sales)? Decides
  whether any of this is worth building.
- Read/write ratio for those archetypes (gates the write-amp tradeoff).
