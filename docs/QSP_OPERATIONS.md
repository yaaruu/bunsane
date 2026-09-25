# Query Surface Planner (QSP) — Operator Runbook

**Version context:** `main` (0.8.0 plus unreleased 0.9 key indexes). Updated 2026-09-25.
**Related:** `docs/READ_PATH_PERFORMANCE.md`, `docs/QUERY_LIST_GUIDE.md`, `docs/CONFIGURATION.md`, `docs/internal/RFC_QSP_ROW_HYDRATION.md`

---

## What QSP is

QSP is a transparent read-path accelerator. For an eligible **archetype** it maintains a
columnar read-model table `rm_<archetype>` (the name is lowercased: `OrderList` is `rm_orderlist`; one row per entity, projected component fields
as real typed columns) with a `bk_` key index per projected column and on `created_at` /
`updated_at`, kept in sync by a synchronous dual-write on `entity.save()` once status is `BACKFILLING`, `SHADOW`, or `READY`. When a list query is
**fully covered** by that archetype (same component set, supported filters/sort/keyset) and the
projection is **READY**, the planner serves it from `rm_<archetype>` with index-ordered scans in
the same canonical order as the legacy engine (`query/orderPlan.ts`). Anything not covered, not READY, or not eligible is
served by the component-table compiler (key indexes and `EXISTS` membership). Every routed query has a transparent
try/catch fallback to legacy, so QSP can never return wrong results or hard-fail a read.

**One knob, not a full autopilot.** There is a single switch `BUNSANE_QSP`. Off at boot = no `projection_state` table and no hooks. `shadow`/`route` at boot turn projection on. If `BUNSANE_QSP_ARCHETYPES` is unset, the first covered list query lazily creates the read model and starts backfill. If the CSV is set, `App.init()` creates the read model and starts the backfill for each newly-registered archetype at boot instead — same mechanism, just earlier. `DISABLED` is only reached by an explicit rollback (`setStatus`) and survives restarts (lifecycle below).

---

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `BUNSANE_QSP` | `off` | Master knob. `off` = 100% legacy, zero footprint when it was off at boot. `shadow` = project + verify parity, **never serve `rm_`**. `route` = project + shadow + **promote to serving**. `shadow` ↔ `route` and any → `off` apply on the next query. `off` → `shadow`/`route` needs a restart. |
| `BUNSANE_QSP_ARCHETYPES` | (empty) | Optional CSV scope limiter. **Empty/unset = all archetypes eligible**, and the first covered query starts backfill. **Set = each listed archetype starts backfilling at boot** — a *new* `projection_state` row is inserted `BACKFILLING`, same as the unscoped lazy path. An existing row keeps its status; `DISABLED` only happens via an operator's manual rollback. |
| `BUNSANE_QSP_COUNT` | `exact` | `count()` on rm_: `exact` \| `n_plus_1` (page-boundary only) \| `estimate`. Prefer `n_plus_1` for list UIs. |
| `BUNSANE_QSP_PROMOTE_MIN` | `50` | Clean shadow comparisons required (zero divergences, `route` mode) before SHADOW → READY. |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | Backfill rows per batch. |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | Sleep between backfill batches. |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | Reserved. Validated, never read. No entities accelerator. `surface` is `'rm'` or `'legacy'` only. |
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
5. Cursor: id-cursor only if unsorted; keyset only with a single sort key (`after` and `before`, either NULLS placement).
6. No OR query, no `findById` / `withId`, no excluded components (`.without`), no excluded entity ids.

### Does **not** route (always legacy — results still correct)

| Shape | Why |
|-------|-----|
| **Empty tag components** in `.with(OrderTag)` | Tags have zero `@CompData` fields → emit **no** projected columns → drop out of the descriptor set → set sizes never match. |
| **Full GraphQL archetype** with optional comps (void/receipt/…) | Optionals enter projection membership if listed; most entities lack them → under-count vs “all real orders.” Use a **list-only archetype**. |
| **Multi-archetype / cross-entity** lists | No `rm_A ⋈ rm_B`. App does FK batching (`orderId IN (…)`) or `@ReadModel` (`m3_*`, `ReadModel(T).where/groupBy/sum`). |
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

## The lifecycle (per archetype)

`projection_state.status` is `DISABLED | BACKFILLING | SHADOW | READY`. There is no `NONE`.

Table names are lowercased (`rmTableName`): archetype `OrderList` is `rm_orderlist`. The legacy cover index, dropped once its `bk_` replacement is valid, is `idx_rm_orderlist__cover`, not `idx_rm_OrderList__cover`.

**Unscoped** (`BUNSANE_QSP_ARCHETYPES` unset), and only if this process booted with QSP already `shadow` or `route`:

**(1) Trigger (lazy).** The first covered list query for an archetype that is not yet registered fires `ensureProjection(archetype)` while that request is still served from the component-table compiler. It inserts `projection_state` as `BACKFILLING` (`ON CONFLICT DO NOTHING`), creates `rm_<lowercase>`, registers the descriptor, then starts backfill. Dual-write is live before the scan, because status is already `BACKFILLING`.

**Scoped** (`BUNSANE_QSP_ARCHETYPES=OrderList`): `App.init()` → `ProjectionManager.initialize()` creates `rm_<lowercase>` and its key indexes for each listed archetype, then — for any archetype with **no existing** `projection_state` row — inserts a new row as `BACKFILLING` and starts the backfill in the background, exactly like the unscoped lazy path (dual-write is live before the scan). An **existing** row keeps whatever status it already has: `DISABLED` is the operator's per-archetype rollback and must survive a restart, so it is never overwritten. A row still `BACKFILLING` from an instance that died mid-scan resumes from `projection_state.watermark` on this boot (or the next `ensureProjection` call); the backfill's distributed lock (`getDistributedLock()`) lets exactly one instance run it. Nothing needs to call `runBackfill` for a fresh scoped archetype — it happens automatically.

```ts
import { runBackfill } from "bunsane/database/projection";

await runBackfill("OrderList"); // archetype name, not rm_orderlist
```

`runBackfill` sets `BACKFILLING`, fills the table from `components`, then `SHADOW`. It returns without writing if QSP is off or the descriptor is missing (wrong archetype name, or this process never ran `initialize()`). It is still how you manually kick a row that is stuck `DISABLED` from before this fix (upgrade note below), or re-run a backfill on demand.

`ProjectionManager.instance.awaitBackfills()` resolves once every backfill this process started has settled — use it in tests and one-off scripts instead of polling `projection_state`.

**Upgrade note.** Before this fix, a scoped archetype's row was created `DISABLED` at boot and never moved on its own — you had to call `runBackfill` yourself. Rows already sitting `DISABLED` from that code path are indistinguishable from an operator's rollback and are **not** picked up automatically by the new boot logic. If you have a scoped archetype that never had `runBackfill` called for it, either run `await runBackfill("OrderList")` once, or flip the row by hand and restart: `UPDATE projection_state SET status='BACKFILLING' WHERE archetype='OrderList'`.

**(2) Backfill → SHADOW.** The backfill scans historical entities in keyset batches with `ON CONFLICT DO NOTHING`, then sets **SHADOW** (not READY). The lock is the postgres lease table (`getDistributedLock()`, default backend), not `pg_advisory_lock`. It is resumable via `projection_state.watermark`.

**(3) SHADOW → READY (auto-promote).** In SHADOW, covered queries still **serve the component-table compiler** and compare `rm_` vs that result. Once `qspPlannerMetrics.shadowComparedTotal` reaches `BUNSANE_QSP_PROMOTE_MIN` (default 50) with `shadowDivergenceTotal === 0` and `BUNSANE_QSP=route`, the projection promotes to **READY**. In `shadow` it never promotes. Those counters are in-process, not Prometheus series. A divergence blocks promotion and resets the counters.

**(4) READY (routing).** Covered + READY queries are served from `rm_<lowercase>`. `getLastRouteInfo()` is `{ routed: true, surface: 'rm', archetype }`. Uncovered queries and runtime errors fall through to the component-table compiler. Fallback counts are `qspPlannerMetrics.fallbackTotal[reason]`, not a `/metrics` label.

**(5) Mode switches.** `qspMode()` is read per query, so `shadow` ↔ `route` and any → `off` apply without a restart. Turning QSP **on** does not: `InitializeProjections` (which creates `projection_state`) runs only when QSP is already active inside `App.init()`, and the reconcile sweep is armed only there. A process that booted `off` must be restarted before `shadow` or `route` can project. `off` stops serving `rm_` immediately; the tables remain.

**Multi-instance.** `projection_state` is the shared source of truth. Each instance polls it about every 30s to refresh its status cache. A `BACKFILLING` row — new or resumed — is picked up by whichever instance wins the distributed lock; `DISABLED` only exists because an operator set it, and stays that way on every instance until someone flips it. Gap-window writes after a backfill starts are covered by the scan or show up as a SHADOW divergence.

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
from the row. Empty tags are never fully columnar. See `docs/internal/RFC_QSP_ROW_HYDRATION.md` for null-vs-absent
risks before flipping default on in production.

---

## Reconcile sweep

`startReconcileSweep(intervalMs = 300_000)` (`database/projection/ReconcileSweep.ts`, exported from
`database/projection`) samples `rm_` rows, recomputes from `components`, and repairs drift
(`qspPlannerMetrics.driftTotal`). The lock is the postgres lease, not an advisory lock. It acts on READY **and SHADOW**, not `DISABLED`.

**`App.init()` starts the sweep when `BUNSANE_QSP` is `shadow` or `route`, and shutdown stops it** (F-11).
`off` does not start it. Do not call `startReconcileSweep()` again from application code — that
registers a second interval. Standalone scripts that are not an `App` and still need drift repair
may call it themselves and must stop the returned function before exit.

---

## What you can actually observe

`/metrics` does not export QSP series. It returns `cache`, `scheduler`, `db`, `dbAdmission`, and `remote`. Counters are the in-process object `qspPlannerMetrics` from `bunsane/query/planner`:

| Field | Meaning / action |
|---|---|
| `shadowComparedTotal` | Shadow comparisons run (a number, not per archetype). |
| `shadowDivergenceTotal` | Id-set mismatches. **Must be 0 before you rely on routing.** Not labeled by archetype; recent mismatches are `lastDivergences`. |
| `routeTotal[archetype]` | Queries served from `rm_`. |
| `fallbackTotal[reason]` | Route attempted, then the component-table compiler. Spike → investigate `rm_` health. |
| `driftTotal` | Rows the reconcile sweep repaired. Not per archetype. |

Access logs do not carry the served surface. They attach `operationName`, `dataLoaderCalls`, and `dbQueryCount`. Per query, `getLastRouteInfo().surface` is `'rm'` or `'legacy'`. There is no `entities` surface.

---

## Backfill & planner cache notes

- **Backfill** is leased on `bunsane_locks` (postgres lease, not `pg_advisory_lock`), watermark-resumable, `ON CONFLICT DO NOTHING`. Tune with
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
5. Set `BUNSANE_QSP_ARCHETYPES=<ListName>` for blast-radius, or leave it empty only if you want every archetype eligible.
6. Set `BUNSANE_QSP=shadow` and `BUNSANE_QSP_COUNT=n_plus_1`, then **restart** if the process booted with QSP off. On that boot, a scoped archetype's row (if new) is created `BACKFILLING` and its backfill starts automatically — unscoped starts on the first covered query instead. `init()` also starts the reconcile sweep. Do not call `startReconcileSweep()` yourself.
7. Confirm the backfill actually ran: watch `projection_state.status` reach `SHADOW`, or `await ProjectionManager.instance.awaitBackfills()` from a script. Only call `runBackfill("OrderList")` by hand if the row predates this behavior and is stuck `DISABLED`.
8. Soak until `qspPlannerMetrics.shadowDivergenceTotal === 0` and `shadowComparedTotal` ≥ `BUNSANE_QSP_PROMOTE_MIN`. Those fields are not on `/metrics`.
9. Flip `BUNSANE_QSP=route` (no restart). Confirm `getLastRouteInfo().routed === true` and `surface === 'rm'` on the hot op.
10. Optional: hydrate shadow, then `BUNSANE_QSP_HYDRATE=on` after data-parity is clean.
11. Stop serving `rm_` without a restart: `BUNSANE_QSP=off`.

**Avoid:** assuming a scoped archetype still needs a manual `runBackfill` call — since this fix it backfills automatically at boot, same as the unscoped lazy path. `DISABLED` is now reached only by an operator's explicit rollback (or a pre-fix leftover row, see the upgrade note above); it does not dual-write and does not backfill. A wrong name never routes. The archetype must be registered in metadata (`@ArcheType`) or `runBackfill` finds no descriptor.

---

## One-line invariant

Flags off ⇒ identical to legacy. Shadow clean ⇒ rm_ == legacy. Route ⇒ same results, one
index scan (for covered shapes). Rollback ⇒ instant legacy. The legacy compiler is never modified
for anything QSP does not fully cover — and **tags / multi-archetype / without / OR stay on legacy**.
