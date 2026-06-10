# Plan: Remove `entity_components` Table

**Status:** Proposed (2026-06-10)
**Goal:** Make `components` (and its LIST partitions) the single source of truth for entity↔component membership. Eliminate the redundant `entity_components` mirror table.

## Why

`entity_components(entity_id, type_id, component_id, ...)` duplicates what `components` already encodes via `UNIQUE(entity_id, type_id)`. Audit (2026-06-10) found 7 write statements and ~12 read sites — **every one replaceable** by `components`:

- The only column unique to `entity_components` is `component_id`, used purely as a join key back to `components`. Every such join rewrites to `entity_id + type_id` (UNIQUE, indexed).
- Soft delete already stamps `components.deleted_at` in the same transaction (`core/Entity.ts:987`), so `deleted_at` reads migrate cleanly. No restore path exists.

**Wins:**
1. One fewer INSERT per `Entity.save()` (fewer round trips in the save transaction).
2. Removes the dual-source consistency problem — root of the documented PGlite visibility race (flat `entity_components` row lagging behind partition row).
3. Drops 6 indexes + one table of write amplification and storage.
4. Simpler query generation (no junction join in fallback paths).

## Inventory (audit 2026-06-10)

**Writes (remove in Phase 3):**
| Site | Statement |
|---|---|
| `core/Entity.ts:895` | batch INSERT in `save()` |
| `core/Entity.ts:911` | INSERT for new-entity path |
| `core/Entity.ts:834` | DELETE on component removal |
| `core/Entity.ts:979` | DELETE in `doDelete(force)` (redundant — FK cascade) |
| `core/Entity.ts:986` | UPDATE deleted_at in soft delete |
| `core/components/BaseComponent.ts:113` | per-component INSERT |
| `endpoints/archetypes.ts:324` | bulk DELETE |

**Reads (redirect in Phase 1):**
| Site | Pattern | Rewrite |
|---|---|---|
| `query/CTENode.ts:29,48,60` | base scan / INTERSECT / NOT EXISTS on `(type_id, entity_id, deleted_at)` | straight table swap |
| `query/OrNode.ts:152,274,371,461,483` | exclusion probes + OR base scan | straight table swap |
| `query/ComponentInclusionNode.ts:163,225,314,321,336,405,420,443` | EXISTS / INTERSECT membership checks | straight table swap |
| `query/ComponentInclusionNode.ts:187,204,559,690,903,932` | `ec.component_id = c.id` joins (fallback / sort / LATERAL paths) | rewrite join to single-table predicate: `c.entity_id = ? AND c.type_id = ? AND c.deleted_at IS NULL` |
| `query/Query.ts:398` | `pg_class.reltuples` for `entity_components` | sum partition stats: `SELECT COALESCE(SUM(c.reltuples),0) FROM pg_class c JOIN pg_inherits i ON c.oid = i.inhrelid WHERE i.inhparent = 'components'::regclass` (parent reltuples unreliable on partitioned tables) |
| `database/DatabaseHelper.ts:620-628` | internal benchmark query | swap |

**Infra:**
- `database/DatabaseHelper.ts:447-488` — DDL + 5 indexes + `PopulateComponentIds` backfill
- `database/DatabaseHelper.ts:52` — `HasValidBaseTable` requires the table
- `endpoints/tables.ts:183` — Studio exclusion list
- Tests: `tests/stress/DataSeeder.ts:95-96,159,180`, `tests/benchmark/scripts/generate-db.ts:99-156,281`, `tests/integration/query/Query.complexAnalysis.test.ts:146`

## Phases (each shippable, each revertable)

### Phase 1 — Redirect reads behind a flag
- New helper (e.g. `query/membershipSource.ts`): resolves membership table + whether `component_id` join style is used. Env `BUNSANE_MEMBERSHIP_SOURCE=components|legacy`, default `components`, `legacy` = instant rollback.
- Swap the straight-swap read sites (identical column semantics: both tables have `UNIQUE(entity_id, type_id)` + partial deleted_at indexes, so DISTINCT/INTERSECT semantics unchanged).
- Rewrite the 6 `component_id`-join sites to single-table predicates on `components` / partition tables.
- Fix `estimatedCount` partition-stats query.
- **Writes stay dual** — both tables maintained, so `legacy` flag value stays correct.
- Gate: full test suite (postgres + PGlite) green under both flag values.

### Phase 2 — Prove performance
- Benchmarks vs baseline: multi-component INTERSECT at 50k entities (baseline ~120ms), sort-driven scan path, OR queries, and **hash-partition mode** (the `component_id` join fallbacks live there).
- EXPLAIN checks: expect index-only scans. If INTERSECT loses index-only on `components`, add `(type_id, entity_id) WHERE deleted_at IS NULL` composite — decide from plans, don't pre-add.
- Stress suite both flag values.
- Gate: no regression >10% on any benchmarked path.

### Phase 3 — Stop writes
- Remove the 7 write statements (save transaction shrinks to one component INSERT batch).
- `HasValidBaseTable`: drop `entity_components` from required list.
- `PrepareDatabase`: stop creating the table on fresh installs. Existing DBs: leave table in place, untouched.
- Update seeders/test fixtures.
- Verify the PGlite visibility race note in CLAUDE.md — if the race disappears with single-table writes, delete the note and the test mitigations.
- Keep `PopulateComponentIds` exported as the **rollback/repair tool**: re-running it backfills `entity_components` from `components` if a downgrade is ever needed.

### Phase 4 — Decommission
- **Never auto-drop.** On startup, if an orphaned `entity_components` exists, log one-time info: "no longer used; verify upgrade, then run `DROP TABLE entity_components;` manually." (Consistent with the partition-strategy guard policy: framework never destroys user data on boot.)
- Remove Studio exclusion, docs references.
- CHANGELOG: breaking for anyone querying `entity_components` directly. Target v0.4.0.
- One release later: remove `legacy` flag + dead branches.

## Risks
| Risk | Mitigation |
|---|---|
| Plan regressions in fallback paths (`shouldUseDirectPartition()=false`, hash mode) | Phase 2 gates on EXPLAIN + benchmarks before any write removal |
| `estimatedCount` accuracy shift | Was already a proxy; partition-stats sum is equivalent or better |
| External consumers querying `entity_components` directly | CHANGELOG breaking note; table left in place until manually dropped |
| Downgrade after Phase 3 leaves stale `entity_components` | Documented: run `PopulateComponentIds()` to backfill before downgrade |
