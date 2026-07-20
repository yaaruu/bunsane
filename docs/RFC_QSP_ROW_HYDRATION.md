# RFC: QSP row hydration (Fix A) — serve component data from the `rm_` row

Status: PLAN (not implemented). Branch: experimental/query-surface-planner (tip fa4df14).
Date: 2026-07-20.

## Problem

`buildRmQuery` selects only `entity_id` (`query/planner/RmPlanGenerator.ts:156`).
`doExecRouted` does `rows.map(r => r.entity_id)` (`query/Query.ts:1022`), then
`hydrateEntityIds` builds BARE entities (`query/Query.ts:1073-1080`) and re-reads every
component from `components` (`Query.ts:1082-1089` → `core/entity/finders.ts:70-74`).

The columnar row — already holding every projected field as a real column — is discarded.
QSP therefore compresses the SCAN but never the HYDRATION.

Measured in a consumer app (Isoiresik): analytics ops issued ~1,900 SQL statements over
12,783 entities at ~0.7ms/statement. Hydration, not scanning, was the entire cost.

## Three blocking findings (verified against code)

### F1 — projection is lossy at FIELD level, coverage matches at COMPONENT level
`ProjectionMetadata.ts:69-71` skips array fields and non-primitive/non-enum fields.
But `SurfacePlanner.ts:35-36` matches on the component SET. A component with one scalar
and one array field passes coverage while its array field has NO `rm_` column — naive
hydration silently yields a component missing that field.
(All-array components emit zero columns, drop out of the set, and fail coverage on size —
already safe. The danger is strictly MIXED-field components.)

### F2 — `comp.id` has no source in `rm_`, and one obvious workaround CORRUPTS DATA
`DDLGenerator.ts:44-50` — `rm_` has entity_id PK, projected columns, timestamps,
shape_version. **No per-component id column.** `BaseComponent.id` defaults to `""`.
- `_persisted=true, id=""` → mutate+save throws at `saveEntity.ts:293-296`. Fails LOUD. OK.
- `_persisted=false` → insert branch mints a fresh uuid (`saveEntity.ts:249-250`); the
  batched upsert conflict target is `(id, type_id)` (`saveEntity.ts:303`), so a fresh uuid
  NEVER conflicts → **duplicate `components` row per (entity_id, type_id), permanently.**
  Silent unrecoverable read corruption. NEVER ship this.

`comp.id` is also the write-through cache key (`core/cache/strategies/writeThrough.ts:146`).

### F3 — `FILLING` is never checked for hydration-only columns
`isCovered` checks field readiness only for FILTER columns (`SurfacePlanner.ts:46-47`) and
the SORT column (`:57-58`). A column needed only to REBUILD a component is unchecked —
harmless today, but under Fix A a mid-backfill column hydrates stale/NULL data into a
served component while the query still routes.

## Design

**Fully-columnar gate (F1):** serve a component from `rm_` only when its projected columns
cover its ENTIRE `@CompData` surface. New `fullyColumnarComponents()` in
`ProjectionMetadata.ts`, cached per shape. Per-COMPONENT fallback, not per-query — a query
over {Order, Customer} where only Order is fully columnar still gets Order free.

**Row→component mapper:** new `query/planner/RmRowHydrator.ts`, mirroring
`finders.ts:83-91` exactly (getConstructor → new ctor → assign → id → setPersisted(true) →
setDirty(false) → addComponent) so objects are indistinguishable from legacy.

`coerce` must invert `projectEntity.ts:16-24` exactly:
| sqlType | read rule | why |
|---|---|---|
| numeric | `Number(v)` | PG returns numeric as a STRING over the wire. Miss this and every numeric field silently changes JS type. Highest-probability silent bug. |
| timestamptz | `new Date(v)` | legacy revives Dates (`Query.ts:1598-1600`) |
| boolean | `Boolean(v)` | |
| text | as-is | strings + scalar enums |

**`undefined`/`null` asymmetry:** `projectEntity` maps undefined→null; legacy JSONB DROPS
undefined so it reads back absent. Observable in `comp.data()`, GraphQL output, Object.keys.
Recommend preserving `null`, normalizing in the shadow comparator, documenting as the one
intentional divergence.

**`comp.id` (F2) — recommended: project the ids.** Add `kind:'component_id'` columns
`${snakeCase(component)}__cid` (double underscore; assert no collision at derivation).
`projectEntity` fills from the live component — free, since `upsertProjection` runs post-save
(`saveEntity.ts:309-310`) when ids exist. Needs `uuid` in `DDLGenerator.SQL_TYPES:7-12`.
Shape-hash bump triggers reprojection of EVERY existing `rm_` table on deploy — budget for it.
Deferring id projection = read-only rm_ entities behind a separate default-off flag; acceptable
only because it fails loud. `_persisted=false` is NEVER acceptable.

**FILLING gate (F3):** extend `isCovered` to check fieldState for all hydration columns using
the same triple-key lookup as `SurfacePlanner.ts:46`; any FILLING → drop that component from
the hydration set (graceful per-component degrade, not un-routing the query).

**populate()/eagerLoad composition — without this Fix A is a NO-OP.**
`hydrateEntityIds` calls `populateComponents` unconditionally (`Query.ts:1082-1084`), which
re-fetches and OVERWRITES rm_-built objects at `Query.ts:1610`. Make both delta-only: compute
the union of missing type ids across the result set (shape of `componentAccess.ts:266-279`),
skip the loader entirely when the delta is empty. That is where the ~1,900-statement win lands.

**Cache warming:** skip for rm_-hydrated components in the first cut — `rm_` carries only
entity-level timestamps, and a wrong cache entry outlives the request.

## Staging (Gall's Law — each step independently shippable and verifiable)

1. **Derivation only.** `fullyColumnarComponents` + `coerce`. Pure functions, PGlite unit tests, zero runtime effect.
2. **Widen the SELECT, discard extra columns.** Isolates SQL-generation/identifier-quoting risk from hydration risk. Reuse the existing `assertIdentifier` guard (`RmPlanGenerator.ts:42/89/129`) — never interpolate raw column names.
3. **Data-parity shadow — highest value, zero read risk.** Extend `ShadowRunner.shadowRunExec` (`ShadowRunner.ts:26-48`, currently id-parity only) to hydrate both ways and compare per component/field, normalizing the unstable fields. Gate behind its OWN flag and do NOT feed `recordShadowSample` — that drives auto-promotion to READY (`ProjectionManager.ts:213-214`) and would entangle the signals. This settles numeric-as-string empirically with nothing served.
4. **Project component ids.** shape-hash bump → reprojection. Still nothing served.
5. **Serve, behind `BUNSANE_QSP_HYDRATE=off|on` (default off), read at call time** like `qspMode()` (`qspConfig.ts:4-7`). Any hydration error falls back to current behaviour, mirroring `recordFallback('exec_error')` at `Query.ts:1118-1122`. Statement-count assertion is the acceptance criterion.
6. **Flip default to on** after Step 3 shadow data is clean in production. Separate revertible commit.

Steps 1/2/4 are behaviour-preserving by construction; 3 is observation-only; only 5 changes
served reads and it is flag-gated with fallback.

## Tests
Existing: `tests/integration/qsp-route.test.ts` (real PG only, `isPGlite` guard :31),
`qsp-shadow-parity`, `qsp-autopilot`, `qsp-legacy-demotion`, `qsp-projection`,
`tests/unit/projection-metadata.test.ts`, `shape-hasher.test.ts`.

New — unit (PGlite-safe): fully-columnar gate (mixed-field excluded, all-scalar included);
`projectEntity`→`coerce` round-trip identity for every sqlType incl. null and numeric-as-string.
New — integration (REAL PG; partitioning + CREATE INDEX CONCURRENTLY per `DDLGenerator.ts:64`):
deep parity routed vs legacy (`comp.data()`, `comp.id`, `_persisted`, `_dirty`);
statement-count assertion proving populate() no longer re-fetches;
**mutate-and-save round-trip asserting exactly ONE `components` row per (entity_id, type_id)** —
this is the F2 guard; mixed-field fallback; FILLING fallback; eager non-projected still loads.

Run: `bun tests/pg-setup.ts tests/integration/qsp-route.test.ts` for anything touching `rm_`;
`bun tests/pglite-setup.ts tests/unit/` for pure derivations. Never `USE_PGLITE=true bun test`.

## Risk register
1. Project ids now (transparent, forces full reprojection) vs read-only first (smaller blast radius, unusable for read-modify-write callers).
2. `null` vs `undefined` for absent scalars — unavoidable observable divergence; pick and document.
3. Numeric-as-string — highest-probability silent bug.
4. Cache warming from rm_ rows — wrong entry outlives the request; skip in first cut.

Silent-corruption modes to guard: mixed-field components without the F1 gate; FILLING columns
hydrated as NULL; numeric type drift; and worst, `_persisted=false` duplicating `components`
rows permanently.
