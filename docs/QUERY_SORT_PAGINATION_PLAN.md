# Query Sort & Pagination — Deferred Fixes

Status: **Fix #1 DONE, Fix #2 DONE (2026-06-21)** — implemented via multi-agent
workflow with adversarial review + fix round. 166/170 query tests pass, source
tsc-clean. Context: native entity-column sort
(`sortByCreatedAt`/`sortByUpdatedAt`) shipped 2026-06-21; while auditing the
sort paths we found two pre-existing correctness gaps. Both now fixed.

## DONE — what shipped

**Fix #1 (tiebreak):** every sorted `ORDER BY` now ends in a unique
`<id> ASC` key (7 sites across `ComponentInclusionNode.ts` + `Query.ts`).
OFFSET pagination over tied sort keys is stable. New test:
`tests/integration/query/Query.sortStability.test.ts`.

**Fix #2 (keyset cursor):** composite keyset over `(sort_value, entity_id)`.
- API: `Query.encodeSortedCursor(sortValue, entityId)` → opaque token;
  `query.sortedCursor(token)` applies it. Caller supplies the last row's sort
  value (from `componentData` or a DB read); rows don't auto-expose it.
- Covers: `sortByCreatedAt`/`sortByUpdatedAt` + single-component `sortBy`, ASC
  and DESC, tie rows. New test: `tests/integration/query/Query.keysetCursor.test.ts`.
- **Throws (clear errors), not silently wrong:** `sortedCursor()` + OR query;
  multi-key sort; `direction:'before'` for entity-column sort; component
  `sortBy()` + entity-column sort mixed in one query.
- Microsecond fix: entity-column keyset truncates both ORDER BY and the
  predicate to `date_trunc('milliseconds', col)` so JS `Date` (ms) cursor
  values match stored TIMESTAMPTZ (µs). Without it, sub-ms rows re-qualified →
  infinite pagination loop (caught by adversarial review).
- NULL handling: ASC NULLS LAST predicate includes `OR <col> IS NULL` so the
  null region stays reachable.

### Remaining non-blocking nits (optional, not scheduled)
- `doExec` entity-sort save/neutralize/restore not wrapped in `try/finally` —
  reused Query instance left with `limit=null` if `dag.execute` throws mid-exec.
- `'before'` direction for sorted cursors not implemented (throws). Real impl
  needs reversed ORDER BY + JS row-reverse.
- Entity-column sort forces full inner materialization (no LIMIT pushdown into
  the inner scan) — pair with `.take()` on large tables.
- `compositeCursor` not in `generateCacheKey()` (deprecated/unused path).
- Single-column expression btree no longer satisfies sorted `ORDER BY` after
  the tiebreak — needs composite `((sortExpr), entity_id)` index for LIMIT
  pushdown (default GIN index set unaffected).

---

## ORIGINAL PLAN (for reference)

---

## Fix #1 — Deterministic tiebreak on all sorted queries (HIGH)

### Problem
Every sorted ORDER BY emits `ORDER BY <key> <dir> NULLS ...` with **no
secondary key**. When the sort key has ties (e.g. two rows same
`created_at` second, same `status`), Postgres returns tied rows in arbitrary
order. Under OFFSET pagination that order can differ between page requests →
**rows duplicated or skipped across pages**. The unsorted paths already order
by `entity_id` (deterministic); only the *sorted* paths regress.

### Affected sites
- `query/ComponentInclusionNode.ts`
  - `applySortDrivenScan` — lines ~230 and ~236
  - `applySortingWithComponentJoins` — line ~592 (`orderByClauses.join`)
  - `applySinglePassFilterSort` — lines ~703 and ~712
  - `applySortingOptimized` — line ~763
- `query/Query.ts` — entity-sort wrapper, line ~940 (`ORDER BY ${orderClauses}`)
- (OR paths already terminate in `ORDER BY entity_id` — see Fix #2.)

### Fix
Append a stable secondary key to every sorted ORDER BY: the entity id column
in scope (`s.entity_id` / `base_entities.id` / `c.entity_id` / `base.id`).
Direction can stay `ASC` (cursor/keyset later cares about consistency, not
which direction). Example:

```sql
ORDER BY (s.data->>'created_at')::numeric DESC NULLS LAST, s.entity_id ASC
```

### Validation
Extend `tests/integration/query/Query.invariants.test.ts`: seed many rows
sharing one sort value, assert paginate-all == one unbounded exec (no
gaps/dupes). Run PGlite + real PG.

### Risk
Low. Secondary key only changes order *within* tie groups. Verify each ORDER
BY still maps to an available index (the trailing id is cheap; PG sorts the
tie group in memory).

---

## Fix #2 — Keyset cursor pagination for sorted queries (HIGH)

### Problem
`.cursor(id)` pagination compares `entity_id > $cursor` and orders by
`entity_id`. It is **incompatible with `.sortBy()` / `sortByCreatedAt()`**:
the cursor walks id order, not sort-key order, so combining them yields wrong
page boundaries. Today entity-sort *drops* the cursor entirely and falls back
to LIMIT/OFFSET (documented caveat). OFFSET is O(offset) and — without Fix #1
— unstable.

### Fix (proper, larger)
Composite keyset cursor over `(sort_value, entity_id)`:
1. Cursor token encodes both the last row's sort value AND its entity_id
   (opaque base64 of `{v, id}`).
2. Pagination predicate becomes a row-comparison:
   `(sort_key, entity_id) > ($v, $id)` for ASC (`<` for DESC), matching the
   ORDER BY from Fix #1.
3. Requires Fix #1's ORDER BY shape `(sort_key, entity_id)` to be in place
   first — **Fix #1 is a prerequisite.**
4. Type handling: encode sort value with its column type (numeric/text/
   timestamptz) so the comparison casts correctly.

### Scope notes
- Works for single-key sort. Multi-key sort cursors = stretch goal.
- For the native entity-column sort, the keyset is `(entities.created_at,
  entities.id)` — clean, both on one table, both indexable.
- OR + sortBy ordering (gap #3) is a separate, deeper issue (OrNode always
  `ORDER BY entity_id`); out of scope here.

### Validation
Cursor-recovers-same-set invariant already exists in
`Query.invariants.test.ts` for unsorted; add a sorted variant.

---

## Also noted (not scheduled here)
- #4: component `sortBy` + entity-column sort mixed → entity sort wins,
  component sort silently dropped. At minimum `throw` on the combination
  instead of silently dropping. Cheap guard in `Query.sortByEntityField` /
  `sortBy`.
- #5: numeric-vs-text sort relies on `isNumericProperty` metadata detection;
  misdetect → lexical sort of numbers. Pre-existing.
- #3: OR + sortBy ignores order (always `ORDER BY entity_id`). Known.
