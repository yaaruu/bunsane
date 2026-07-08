# Query Surface Planner (QSP) — Operator Runbook

## What QSP is

QSP is a transparent read-path accelerator. For an opted-in **archetype** it maintains a
columnar read-model table `rm_<archetype>` (one row per entity, projected component fields
as real typed columns) with a covering index, kept in sync by a synchronous dual-write on
`entity.save()`. When a list query is **fully covered** by that archetype (same component
set, supported filters/sort/keyset) and the projection is **READY**, the planner serves it
from `rm_<archetype>` with a single index scan — bypassing the legacy INTERSECT / correlated
`EXISTS` / scalar-subquery query DAG. Anything not covered, not READY, or not opted-in is
served by the **unchanged** legacy compiler. Every routed query has a transparent
try/catch fallback to legacy, so QSP can never return wrong results or hard-fail a read.

**Everything is behind flags that default OFF. With them unset, framework behavior is
byte-for-byte identical to before.**

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `BUNSANE_QSP_ENABLED` | `false` | Master switch. Enables projection **write-path** maintenance + table creation on boot. |
| `BUNSANE_QSP_ARCHETYPES` | (empty) | CSV of archetype names to project. Empty = nothing projected. |
| `BUNSANE_QSP_MODE` | `off` | Read routing: `off` (100% legacy) \| `shadow` (serve legacy, run rm_ in parallel, compare) \| `route` (serve rm_). Read at query time — can be flipped without redeploy. |
| `BUNSANE_QSP_COUNT` | `exact` | `count()` strategy on rm_: `exact` (`count(*)`) \| `n_plus_1` (page-boundary only) \| `estimate` (planner row estimate). |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | Backfill rows per batch. |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | Sleep between backfill batches. Raise to reduce write-path pressure during a live backfill. |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | R1 generic `entities` accelerator (P5, independent of the rm_ path). |

Flags are validated on boot by `core/validateEnv.ts`. Rollout is **per-archetype** via the
CSV plus the per-archetype `projection_state.status`.

## Safe enablement sequence (per archetype)

Never skip a step. The order is designed so a live workload is never clobbered and a bad
projection is caught in shadow before it can serve a byte to a user.

**(a) Turn on dual-write.** Set `BUNSANE_QSP_ENABLED=true` and add the archetype to
`BUNSANE_QSP_ARCHETYPES`; deploy/restart. On boot `ProjectionManager.initialize()` creates
`rm_<archetype>` + its covering index with `projection_state.status = DISABLED`. Reads stay
100% legacy (`MODE` still `off`). No user-visible change.

**(b) Backfill to READY.** Run the backfill for the archetype (`runBackfill(archetype)` /
the scheduled backfill task). It flips status **DISABLED → BACKFILLING** first — which
**activates live dual-write** (live writes `INSERT ... DO UPDATE`, so they always win) — then
scans historical entities in batches with `ON CONFLICT DO NOTHING` (so the backfill can never
clobber a newer live write), and finally flips **BACKFILLING → READY**. It is advisory-leased
(only one instance runs it), resumable via `projection_state.watermark`, and idempotent — safe
to re-run. Watch backfill progress via the watermark / `qsp_backfill_progress`.

**(c) Shadow SOAK — the production gate.** Set `BUNSANE_QSP_MODE=shadow`. Every
covered+READY query now runs BOTH surfaces: it **serves legacy** and runs `rm_` in parallel,
asserting identical ordered `entity_id[]`, `count()`, and `hasNextPage`. Soak over a **real,
representative workload** until **`qsp_shadow_divergence_total` stays 0**.
**Do NOT flip to `route` until shadow divergence has held at 0 across a meaningful soak.**
Any non-zero divergence means a projection bug shipped — stay in shadow, investigate, fix,
re-soak. This step is where projection bugs die instead of reaching users.

**(d) Route.** Set `BUNSANE_QSP_MODE=route`. Covered + READY + opted-in queries are now
served from `rm_<archetype>`. Uncovered queries and any runtime error fall through to legacy
transparently (tracked as `qsp_fallback_total`). Mode is read per query, so this takes
effect without a redeploy; start on a canary if desired.

**(e) Rollback — instant.** Either set `projection_state.status = DISABLED`
(`ProjectionManager.setStatus(archetype, 'DISABLED')`) **or** remove the archetype from
`BUNSANE_QSP_ARCHETYPES`. `setStatus` invalidates the planner cache immediately in-process;
cluster-wide it takes effect within the 30s `PlannerCache` TTL backstop. Routing stops at
once and reads return to legacy — correct, just slower. The `rm_` table is left in place, so
re-enabling later needs no re-backfill (run a reconcile first if writes continued while
disabled — see below).

## Metrics to watch

| Metric | Meaning / action |
|---|---|
| `qsp_shadow_divergence_total{archetype}` | rm_ vs legacy mismatches in shadow. **Must be 0 before routing.** Non-zero = projection bug; stay in shadow. |
| `qsp_shadow_compared_total` | Shadow comparisons run (denominator for divergence). Confirms shadow is actually exercising covered queries. |
| `qsp_route_total{archetype}` | Queries served from rm_. Adoption / route coverage signal. |
| `qsp_fallback_total{reason}` | Route attempted but fell to legacy (`reason` e.g. `exec_error`). Reads stay correct; a spike means rm_ is unhealthy — investigate. |
| `qsp_drift_total{archetype}` | Rows the reconcile sweep found diverged from `components` and repaired. A spike = an out-of-band write path bypassed maintenance, or a missed shared-component fanout. |

If your access log is enabled, each request also carries the served surface
(`rm_` \| `entities` \| `legacy`).

## Backfill & reconcile notes

- **Backfill** is advisory-leased (`getDistributedLock`), watermark-resumable, and idempotent
  (`DO NOTHING`). Two instances will not double-run it. Tune throughput with
  `BUNSANE_QSP_BACKFILL_BATCH` / `BUNSANE_QSP_BACKFILL_THROTTLE_MS`.
- **Reconcile sweep** (`startReconcileSweep(intervalMs = 300_000)`) is the safety net for
  drift: it periodically samples READY `rm_` rows, recomputes them from `components`, repairs
  any mismatch (`DO UPDATE`), and increments `qsp_drift_total`. Run it in production so
  out-of-band component writes or missed fanouts self-heal. It only acts on READY archetypes
  and is advisory-leased (single instance).
- **Planner cache** has a 30s TTL. `ProjectionManager.setStatus()` invalidates it immediately
  in-process (BACKFILLING→READY and rollback→DISABLED apply at once locally); across processes
  the 30s TTL is the backstop (a Redis pub/sub invalidation seam is documented in
  `PlannerCache`).

## Shape changes (heads-up)

Adding a projected field is additive: `ADD COLUMN` + a per-field readiness gate — queries
touching the new field fall back to legacy until that column is filled, then route. A
type change / rename / removal is a blue/green (v2) flip. `projection_state.shape_hash` +
`shape_version` drive this and invalidate the planner cache; a shape mismatch on boot is
surfaced rather than silently serving stale columns.

## One-line invariant

Flags off ⇒ identical to legacy. Shadow clean ⇒ rm_ == legacy. Route ⇒ same results, one
index scan. Rollback ⇒ instant legacy. The legacy compiler is never modified for anything
QSP does not fully cover.
