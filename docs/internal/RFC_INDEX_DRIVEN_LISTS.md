# RFC: Index-driven list reads (0.9)

Status: implemented (2026-09-25). Code: `query/orderPlan.ts`, `database/keyIndexSpec.ts`, `database/indexReconciler.ts`, `query/entitySort.ts`, `query/planner/RmPlanGenerator.ts`. Results: `docs/internal/benchmark-0.9/RESULTS.md`.

## Problem

Every legacy list plan on real PostgreSQL is `Seq Scan → top-N sort` (see `benchmark-0.7/pg-head.json`). Cost is linear in table size: at 1M rows a top-20 sort is ~150 ms, an unsorted two-component page ~490 ms, `sortByCreatedAt` with a component ~258 ms. Indexes exist but cannot serve the SQL:

- `@IndexedField("numeric")` / `@CompData({indexed})` numbers build a **partial** index (`WHERE <numeric regex>`); sorts do not restate the predicate and must return non-matching rows, so the index is ineligible.
- The index key is `(expr)` only; sorts are `expr DESC NULLS LAST, entity_id ASC`. No index matches that order.
- `entities` has no index on `created_at` / `updated_at`; keyset pages order by `date_trunc('milliseconds', created_at)` (STABLE, not indexable) while page 1 orders by raw `created_at` (inconsistent tie order between pages).
- Multi-component unsorted pages use `INTERSECT`, which materializes and sorts both full sets.

Correctness bugs found on the way (fixed by this design): numeric sorts **throw** on a non-numeric value (`invalid input syntax for type numeric: "n/a"`); DESC keyset pages after a non-null cursor never return NULL rows under NULLS LAST; `sortByCreatedAt().with(X)` omits `entities.deleted_at IS NULL`; `.cursor(id)` with `sortByCreatedAt` is silently ignored.

## Measured on real PG 17, 1M rows (probe, 2026-09-25)

| Shape | Today | Design |
|---|---:|---:|
| top-20 numeric DESC NULLS LAST | 150 ms (seq + sort) | 0.15 ms (two index branches) |
| keyset deep page | seq + sort | 0.4 ms (row-compare index cond) |
| ASC top-20 | seq + sort | 0.07 ms |
| two-component unsorted page (populate ids) | 490 ms (INTERSECT, external sort) | 0.3–1.4 ms (EXISTS semi-join, ordered) |
| entity list by created_at, no component | seq + sort | 0.04 ms |
| created_at + component, interleaved | 258 ms (hash join) | ~1 ms (ordered probe) |
| created_at + component, time-correlated (worst) | 258 ms | 13 ms probe miss + 280 ms fallback |

## Decisions

### D1. One key-expression module is the single source of truth

`query/orderPlan.ts` owns every sort/keyset key expression. Index DDL (`database/keyIndexSpec.ts`) and query SQL both call it, so an index key and the `ORDER BY` expression are byte-identical by construction.

| Kind | Key expression | Cursor param |
|---|---|---|
| numeric field | `bunsane_num_v1(<a>data->>'f')` | `$n::numeric` |
| text / enum / boolean / Date field | `<a>data->>'f'` | `$n::text` |
| entity timestamp | `date_trunc('milliseconds', <a>created_at AT TIME ZONE 'UTC')` | `($n::timestamptz AT TIME ZONE 'UTC')` |

`bunsane_num_v1(text)` is an IMMUTABLE, inlinable SQL function created at boot: numeric when the text matches `^-?[0-9]+\.?[0-9]*$` (the existing RP-04 regex; jsonb numbers never render exponents) and is ≤ 1000 chars, else NULL. It never raises, so a non-partial expression index on it is safe to build and maintain. The `_v1` suffix is part of the contract: a behaviour change ships as `_v2` (new index names), never as `CREATE OR REPLACE` of v1.

The UTC ms-truncated timestamp is IMMUTABLE (`timezone(text, timestamptz)` and `date_trunc(text, timestamp)`), so it is indexable, matches the ms precision of JS `Date` cursors exactly, and is used on page 1 and on keyset pages alike.

### D2. Key indexes

For every **key field** of a component the framework maintains, on the LIST leaf:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS bk_<slug>_<hash8>
  ON components_<name> ((<key expr>), entity_id)
```

Not partial. The first cut used `WHERE deleted_at IS NULL`; real-PG benchmarks showed PostgreSQL ignores statistics of partial expression indexes, so `data->>'userId' IN (…)` was estimated at default selectivity (7 500 rows instead of ~150) and relation loads switched to a hash join over all entities (GraphQL list 16 → 114 ms at 1M). Non-partial indexes keep expression statistics; queries still filter `deleted_at IS NULL`, and soft-deleted rows only cost index entries.

Key fields: `@CompData({ indexed: true })` scalars (not `arrayOf`), and `@IndexedField("btree" | "numeric")`. `gin`, `hash`, `fulltext` keep their current indexes. `@CompositeIndex(["status", "total"])` (class decorator) adds `((k_status), (k_total), entity_id)`. Under the HASH partition strategy the index is on `components` with `type_id` as the leading column.

`entities` gets `bk_entities_created_at_*` / `bk_entities_updated_at_*`: `((<entity ts key>), id)`.

All key columns are ASC NULLS LAST. A forward scan serves `ASC`, a backward scan serves `DESC`; NULL placement is handled by D3, so one index serves all four `(direction, nulls)` combinations and both page directions.

Index names start with `bk_` and end in an 8-hex hash of the definition. A definition change is a new name; the old `bk_` index is obsolete and dropped. `bk_` is the ownership marker: the reconciler never touches indexes without it except the known legacy per-field names it replaces (`idx_<leaf>_<f>_btree`, `_btree_date`, `_numeric`, and `_gin` for scalar fields), and only after the replacement is valid.

The reconciler also: detects `indisvalid = false` framework indexes (a crashed `CONCURRENTLY` build) and rebuilds them; truncates/hashes names to ≤ 63 bytes before any catalog lookup; builds synchronously when the table's `reltuples` < `BUNSANE_INDEX_SYNC_MAX_ROWS` (default 100 000) and otherwise in a background task after `init()` under `withLock("bunsane:index-reconcile")`, so a large upgrade never blocks boot or restart-loops a container on a half-built index.

### D3. Canonical ordering and the null split

Canonical order for a sort key `k` with direction `D` and NULLS placement `N`:

```
non-null group: k D, entity_id D      null group: entity_id D      groups ordered by N
```

The **tiebreak follows the sort direction** (was always `entity_id ASC`). `'before'` pages reverse everything (unchanged mechanism).

When `k` has a key index, the id-select is two index-ordered branches:

```sql
SELECT id FROM (
  (SELECT <id> AS id, 0 AS g, <k> AS k FROM … WHERE <base> AND <k> IS NOT NULL [AND (<k>, <id>) {<|>} (<v>, <cid>)]
     ORDER BY <k> D NULLS <index-order>, <id> D LIMIT <limit+offset>)
  UNION ALL
  (SELECT <id>, 1, NULL FROM … WHERE <base> AND <k> IS NULL [AND <id> {<|>} <cid>]
     ORDER BY <k> D NULLS <index-order>, <id> D LIMIT <limit+offset>)
) u ORDER BY g, k D, id D LIMIT <limit> OFFSET <offset>
```

- `NULLS <index-order>` is `NULLS LAST` for ASC and `NULLS FIRST` for DESC — the order the index already has. Both branches therefore match the index pathkeys exactly; this is required, not cosmetic: with `ORDER BY <id>` alone the planner picked the `(entity_id, type_id)` unique index for the null branch and filtered 1M rows (733 ms) when a field had no NULLs.
- Branch order (`g`) encodes `N`. A cursor removes branches that are entirely before it.
- The keyset predicate in the non-null branch is a row comparison, which PostgreSQL uses as an index condition (verified). The OR-expanded form is never an index condition.
- Only one branch left → emitted as a plain statement with `LIMIT/OFFSET`, no `UNION`.

Without a key index the builder emits the single-statement form (`ORDER BY k D NULLS N, id D` with a corrected OR keyset) so unindexed sorts do not pay for two sequential scans.

Multi-key sorts stay single-statement (expanded OR keyset) with the tiebreak following the **last** key's direction. A `@CompositeIndex` with the same key order serves page 1 of an all-ASC multi-key sort; other multi-key shapes are correct but not index-driven.

### D4. Filters

Numeric comparisons and numeric `IN` use `bunsane_num_v1(<a>data->>'f') <op> $n::numeric`. Semantics are unchanged (non-numeric text never matched), and the same key index now serves equality, range, and sort. The partial `_numeric` indexes and the regex restatement go away.

### D5. Unsorted multi-component pages

`INTERSECT … ORDER BY entity_id LIMIT` becomes a driving leaf plus `EXISTS` semi-joins ordered by `entity_id`. Each leaf has `UNIQUE (entity_id, type_id)`, so the result set is identical; PostgreSQL chooses the join order and stops at the limit. Same rewrite for the CTE multi-filter path and therefore `count()`.

### D6. Entity timestamp sorts

- No component membership: index-driven two-branch plan on `entities`.
- With membership (`.with(X)`), an ordered scan of `entities` probing `X` is O(limit / fraction) when `X` is spread over time but O(entities) when `X` is clustered at the far end (measured 1.3 s at 1M). So the executor runs an **adaptive probe**: the ordered plan over at most `BUNSANE_ENTITY_SORT_PROBE` candidate entities (default 5000); if it returns a full page it is the answer; otherwise it runs the fallback, which orders by an expression the index cannot serve (`date_trunc('milliseconds', e.created_at)` — same order, different expression) so the planner uses the hash-join + top-N shape. Worst case = probe (~13 ms) + today's cost. `OFFSET > 0` goes straight to the fallback.
- `.with(X)` entity sorts now require `entities.deleted_at IS NULL`. `.cursor(id)` with an entity sort throws, like it does for component sorts.

### D7. QSP `rm_` tables

`RmPlanGenerator` uses the same ordering/keyset builder over typed columns (`"col"` as the key expression). Per projected column key indexes `((key), entity_id)` plus the entity-timestamp expression on `created_at` / `updated_at` replace the single `__cover` index (whose `DESC` = NULLS FIRST never matched the emitted `DESC NULLS LAST`). The keyset-with-`nullsFirst` coverage restriction is lifted.

### D8. Developer feedback

In `NODE_ENV=development`, a `sortBy` on a field with no key index logs one warning per (component, field) naming the decorator to add.

## Breaking changes (0.9.0)

1. Rows with equal sort values are ordered by `entity_id` in the sort direction (DESC sorts break ties by `entity_id DESC`). A cursor issued by 0.8 inside a tie group may repeat or skip rows of that group once.
2. Non-numeric text in a numeric sort/filter field sorts and filters as NULL instead of raising `invalid input syntax for type numeric`.
3. Entity timestamp order is by UTC milliseconds on every page (microsecond ties now fall to `id`).
4. `sortByCreatedAt/UpdatedAt().with(X)` excludes soft-deleted entities; `.cursor(id)` with them throws.
5. The framework drops its legacy per-field `idx_<leaf>_<f>_btree|_btree_date|_numeric` (and scalar `_gin`) indexes once the `bk_` replacement is valid.
6. DESC keyset pages under NULLS LAST now return the NULL tail (bug fix; previously the list ended early).

## Not in scope

Cross-component composite indexes (impossible across partitions; that is QSP's job), mixed-direction multi-key index plans, denormalizing entity timestamps onto component rows, making QSP the default (RP-02).
