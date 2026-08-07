# Query Surface Planner (QSP) — Operator Runbook

**Version context:** BunSane 0.6.x (updated 2026-08-07)  
**Related:** `docs/READ_PATH_PERFORMANCE.md`, `docs/QUERY_LIST_GUIDE.md`, `docs/CONFIGURATION.md`, `docs/RFC_QSP_ROW_HYDRATION.md`

---

## What QSP is

QSP is a transparent read-path accelerator. For an eligible **archetype** it maintains a
columnar read-model table `rm_<archetype>` (one row per entity, projected component fields
as real typed columns) with a covering index, kept in sync by a synchronous dual-write on
`entity.save()`. When a list query is **fully covered** by that archetype (same component
set, supported filters/sort/keyset) and the projection is **READY**, the planner serves it
from `rm_<archetype>` with a single index scan — bypassing the legacy INTERSECT / correlated
`EXISTS` / scalar-subquery query DAG. Anything not covered, not READY, or not eligible is
served by the **unchanged** legacy compiler. Every routed query has a transparent
try/catch fallback to legacy, so QSP can never return wrong results or hard-fail a read.

**One knob, autopilot.** There is a single switch `BUNSANE_QSP`. Off = byte-for-byte identical
to before (no `projection_state` table, no hooks). `shadow`/`route` turn on the autopilot: the
**first covered list-query** for an eligible archetype lazily creates its read model and drives
it through the lifecycle automatically — no manual backfill start required for the happy path.

---

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `BUNSANE_QSP` | `off` | Master knob. `off` = 100% legacy, zero footprint. `shadow` = auto-project + verify parity, **never serve `rm_`**. `route` = auto-project + auto-shadow + **auto-promote to serving**. Read at query time — flip without redeploy. |
| `BUNSANE_QSP_ARCHETYPES` | (empty) | Optional CSV scope limiter. **Empty/unset = ALL archetypes eligible** (wide dual-write blast radius — prefer scoping for first rollout). |
| `BUNSANE_QSP_COUNT` | `exact` | `count()` on rm_: `exact` \| `n_plus_1` (page-boundary only) \| `estimate`. Prefer `n_plus_1` for list UIs. |
| `BUNSANE_QSP_PROMOTE_MIN` | `50` | Clean shadow comparisons required (zero divergences, `route` mode) before SHADOW → READY. |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | Backfill rows per batch. |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | Sleep between backfill batches. |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | R1 generic `entities` accelerator (independent of rm_). |
| `BUNSANE_QSP_HYDRATE` | `off` | When `on`, rebuild fully-columnar components from the `rm_` row instead of re-reading `components` (see row hydration below). |
| `BUNSANE_QSP_HYDRATE_SHADOW` | `off` | When `on`, **observe** data-parity (rm_ hydrate vs legacy) without serving hydrate; does **not** feed READY auto-promotion. |

Flags are validated on boot by `core/validateEnv.ts` where applicable. (`BUNSANE_QSP` replaces the removed `BUNSANE_QSP_ENABLED` + `BUNSANE_QSP_MODE` pair.)

---

## Coverage rules (what actually routes)

Implemented in `query/planner/SurfacePlanner.ts` (`isCovered`) + column derivation in
`database/projection/ProjectionMetadata.ts`.

### Routes only when **all** of the following hold

1. **`BUNSANE_QSP=route`**, projection status **READY**, archetype in scope.
2. **Exact component-set match:** the query’s required `.with(...)` component **names** equal the set of components that appear in the archetype’s **projected columns** (not the GraphQL archetype field list alone).
3. Filters use only: `=`, `!=`, `>`, `<`, `>=`, `<=`, `IN`, `NOT IN` (empty `IN`/`NOT IN` arrays fail coverage).
4. At most **one** sort key; if component sort, that field is projected and not `FILLING`.
5. Cursor: id-cursor only if unsorted; keyset only with single sort, direction **`after`** (not `before`); keyset + `nullsFirst` not covered.
6. No OR query, no `findById` / `withId`, no excluded components (`.without`), no excluded entity ids.

### Does **not** route (always legacy — results still correct)

| Shape | Why |
|-------|-----|
| **Empty tag components** in `.with(OrderTag)` | Tags have zero `@CompData` fields → emit **no** projected columns → drop out of the descriptor set → set sizes never match. |
| **Full GraphQL archetype** with optional comps (void/receipt/…) | Optionals enter projection membership if listed; most entities lack them → under-count vs “all real orders.” Use a **list-only archetype**. |
| **Multi-archetype / cross-entity** lists | No `rm_A ⋈ rm_B`. App does FK batching (`orderId IN (…)`) or waits for M3 read models. |
| **`.without(Tag)`** / exclusions | Explicitly rejected by planner (`excludedComponentIds`). |
| **OR / ILIKE / spatial / nested JSON path** filters | Unsupported ops or OR flag → legacy. |
| **Multi-key sort** | `req.sorts.length > 1` → legacy. |

### Product pattern that **does** work (proven in the field)

Declare a **list-only archetype** whose fields are exactly the components every list row always has, **omit empty tags and optionals**, and build list queries with that exact set:

```ts
// List archetype (QSP metadata only — GraphQL may still return the full type)
@ArcheType('OrderList')
class OrderListArchetype {
  @ArcheTypeField(OrderInfo) info!: OrderInfo;
  @ArcheTypeField(OrderStatus) status!: OrderStatus;
  @ArcheTypeField(OrderPricing) pricing!: OrderPricing;
  @ArcheTypeField(OrderPayment) payment!: OrderPayment;
  @ArcheTypeField(OrderTimeline) timeline!: OrderTimeline;
}

// Query must match that set — no OrderTag
new Query()
  .with(OrderStatus, statusFilters)
  .with(OrderInfo, infoFilters)
  .with(OrderPricing)
  .with(OrderPayment)
  .with(OrderTimeline, timelineFilters)
  .sortBy(OrderTimeline, 'createdAt', 'DESC')
  .take(20)
  .exec();
```

After exec: `query.getLastRouteInfo()` → `{ routed: true, surface: 'rm', archetype: 'OrderList', hasNextPage? }` when READY.

**Do not** put empty tags on the QSP list path “for documentation.” Presence filters need a future **membership flag** column (not implemented); until then use legacy or denormalize a real field.

---

## The automatic lifecycle (per archetype)

`projection_state.status`:  `NONE (no row) → BACKFILLING → SHADOW → READY`.

**(1) Trigger (lazy).** The first covered list-query for an eligible archetype with no
`projection_state` row (and `BUNSANE_QSP` ≠ `off`) fires `ensureProjection(archetype)` fire-and-forget
while serving that request from legacy. It is idempotent — `INSERT ... 'BACKFILLING' ON CONFLICT
(archetype) DO NOTHING`, so across concurrent queries and instances only one winner proceeds. The
winner creates `rm_<archetype>` + its covering index, registers the archetype in the in-memory
dependency map with status BACKFILLING (**dual-write goes live *before* the backfill scan**), then
kicks the advisory-leased backfill.

**(2) Backfill → SHADOW.** The backfill scans historical entities in keyset batches with
`ON CONFLICT DO NOTHING` (never clobbers a newer live dual-write), then sets status to **SHADOW**
(not READY). It is advisory-leased (one instance), resumable via `projection_state.watermark`, and
idempotent.

**(3) SHADOW → READY (auto-promote).** In SHADOW, every covered query still **serves legacy** and
shadow-compares `rm_` vs legacy (id-set + order + count). Once clean comparisons reach
`BUNSANE_QSP_PROMOTE_MIN` (default 50) with **zero divergences** and `BUNSANE_QSP=route`, the
projection auto-promotes to **READY**. In `BUNSANE_QSP=shadow` it **never** promotes — it stays a
permanent parity canary. Any divergence blocks promotion, logs `qsp.shadow`, triggers a
`ReconcileSweep` for that archetype, and resets the counters so it must re-prove from scratch.

**(4) READY (routing).** Covered + READY queries are served from `rm_<archetype>` with a single
covering-index scan. Uncovered queries and any runtime error fall through to legacy transparently
(`qsp_fallback_total`).

**(5) Rollback — instant.** Set `BUNSANE_QSP=off`: `qspActive()` goes false, the planner is not
consulted, and all reads return to legacy — correct, just slower. The `rm_` tables remain (they are
disposable / re-usable). Because mode is read per query, this takes effect without a redeploy.

**Multi-instance.** `projection_state` is the shared source of truth. Each instance polls it every
~30s to sync its status cache + dependency map. Gap-window writes are covered by backfill or surface
as SHADOW divergence → reconcile → re-prove → promote. Safe-by-construction: slow, never wrong.

---

## Row hydration (`BUNSANE_QSP_HYDRATE`)

By default, routed queries only accelerate **id-set selection** (and count). Entities are still
hydrated from `components` (populate / eager load).

| Flag | Behavior |
|------|----------|
| `BUNSANE_QSP_HYDRATE=off` (default) | SELECT `entity_id` (+ sort keys as needed); hydrate from `components` |
| `BUNSANE_QSP_HYDRATE=on` | Fully-columnar components rebuilt from `rm_` columns; non-columnar still from `components` |
| `BUNSANE_QSP_HYDRATE_SHADOW=on` | Diff hydrate vs legacy; **does not** serve hydrate; **does not** feed READY promotion |

Only components in `fullyColumnarComponents` (entire `@CompData` surface projectable) may be served
from the row. Empty tags are never fully columnar. See `docs/RFC_QSP_ROW_HYDRATION.md` for null-vs-absent
risks before flipping default on in production.

---

## Reconcile sweep (not auto-started by App)

`startReconcileSweep(intervalMs = 300_000)` (`database/projection/ReconcileSweep.ts`, exported from
`database/projection`) samples `rm_` rows, recomputes from `components`, repairs drift
(`qsp_drift_total`). Advisory-leased; acts on READY **and SHADOW**.

**BunSane `App` does not call `startReconcileSweep` automatically.** Production multi-instance
deployments should start it from app boot when `BUNSANE_QSP ≠ off`, e.g.:

```ts
import { startReconcileSweep } from 'bunsane/database/projection';
// after App init / when QSP enabled:
if (process.env.BUNSANE_QSP === 'shadow' || process.env.BUNSANE_QSP === 'route') {
  startReconcileSweep(300_000);
}
```

---

## Metrics to watch

| Metric | Meaning / action |
|---|---|
| `qsp_shadow_divergence_total{archetype}` | rm_ vs legacy mismatches in shadow. **Must be 0 before routing.** |
| `qsp_shadow_compared_total` | Shadow comparisons run (denominator). |
| `qsp_route_total{archetype}` | Queries served from rm_. |
| `qsp_fallback_total{reason}` | Route attempted but fell to legacy. Spike → investigate rm_ health. |
| `qsp_drift_total{archetype}` | Reconcile repaired rows. Spike → out-of-band write path. |

Access logs (when enabled) carry the served surface (`rm_` \| `entities` \| `legacy`).
Per-query: `query.getLastRouteInfo()`.

---

## Backfill & planner cache notes

- **Backfill** is advisory-leased, watermark-resumable, `ON CONFLICT DO NOTHING`. Tune with
  `BUNSANE_QSP_BACKFILL_BATCH` / `BUNSANE_QSP_BACKFILL_THROTTLE_MS`.
- **Planner cache** TTL ~30s; `ProjectionManager.setStatus()` invalidates in-process immediately.
- Shape changes: additive field → `ADD COLUMN` + readiness gate; rename/remove → blue/green
  (`shape_hash` / `shape_version`).

---

## First production archetype checklist (RP-02)

1. Pick **one** hot list with a stable multi-component set (orders, not matcher/spatial).
2. Declare a **list-only archetype** (exact components, **no empty tags**, no rare optionals).
3. Align the list Query builder to that set (unit-test component names if needed).
4. Index filter/sort fields (`@CompData({ indexed: true })`) — still helps legacy + backfill.
5. Set `BUNSANE_QSP_ARCHETYPES=<ListName>` for blast-radius (or leave empty only if intentional).
6. Staging: `BUNSANE_QSP=shadow`, `BUNSANE_QSP_COUNT=n_plus_1`, start **reconcile sweep**.
7. Soak until `qsp_shadow_divergence_total=0` and comparisons ≥ `BUNSANE_QSP_PROMOTE_MIN`.
8. Flip `BUNSANE_QSP=route`; confirm `getLastRouteInfo().routed === true` on the hot op.
9. Optional: hydrate shadow → `BUNSANE_QSP_HYDRATE=on` after data-parity clean.
10. Instant rollback: `BUNSANE_QSP=off`.

**Avoid:** `BUNSANE_QSP_ARCHETYPES=OrderList` **pre-register** confusion — empty ARCHETYPES means all
eligible; a wrong name simply never routes. Do not block backfill by forgetting the archetype is
registered in metadata (`@ArcheType`).

---

## One-line invariant

Flags off ⇒ identical to legacy. Shadow clean ⇒ rm_ == legacy. Route ⇒ same results, one
index scan (for covered shapes). Rollback ⇒ instant legacy. The legacy compiler is never modified
for anything QSP does not fully cover — and **tags / multi-archetype / without / OR stay on legacy**.
