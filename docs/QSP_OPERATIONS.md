# Query Surface Planner (QSP) — Operator Runbook

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
it through the lifecycle automatically — no archetype list, no manual backfill, no manual mode
flips required.

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `BUNSANE_QSP` | `off` | The single master knob. `off` = 100% legacy, zero footprint. `shadow` = auto-project lazily + verify parity, **never serve `rm_`** (permanent ops canary). `route` = auto-project + auto-shadow + **auto-promote to serving**. Read at query time — flip without redeploy. |
| `BUNSANE_QSP_ARCHETYPES` | (empty) | Optional CSV scope limiter. Empty/unset = **ALL** archetypes eligible. Set it to bound the blast radius to specific archetypes. |
| `BUNSANE_QSP_COUNT` | `exact` | `count()` strategy on rm_: `exact` (`count(*)`) \| `n_plus_1` (page-boundary only) \| `estimate` (planner row estimate). |
| `BUNSANE_QSP_PROMOTE_MIN` | `50` | Clean shadow comparisons an archetype must accumulate (with zero divergences, in `route` mode) before SHADOW auto-promotes to READY. |
| `BUNSANE_QSP_BACKFILL_BATCH` | `5000` | Backfill rows per batch. |
| `BUNSANE_QSP_BACKFILL_THROTTLE_MS` | `50` | Sleep between backfill batches. Raise to reduce write-path pressure during a live backfill. |
| `BUNSANE_QSP_ENTITIES_ACCEL` | `false` | R1 generic `entities` accelerator (P5, independent of the rm_ path). |

Flags are validated on boot by `core/validateEnv.ts`. (`BUNSANE_QSP` replaces the removed
`BUNSANE_QSP_ENABLED` + `BUNSANE_QSP_MODE` pair.)

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
(Per-archetype force-disable via `projection_state.status` remains available for surgical rollback;
run a reconcile first if writes continued while disabled — see below.)

**Multi-instance.** `projection_state` is the shared source of truth. Each instance polls it every
~30s to sync its status cache + dependency map, so an archetype triggered on instance A is picked up
by instance B (which then dual-writes and eventually routes). Gap-window writes B misses before it
syncs are covered by the one-time backfill or surface as SHADOW divergence → reconcile → then
promote. Safe-by-construction: slow, never wrong (READY-gate + full-coverage-only + transparent
fallback all hold).

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
  drift: it periodically samples `rm_` rows, recomputes them from `components`, repairs
  any mismatch (`DO UPDATE`), and increments `qsp_drift_total`. Run it in production so
  out-of-band component writes or missed fanouts self-heal. It acts on READY **and SHADOW**
  archetypes (so a SHADOW divergence is repaired before it can block auto-promotion) and is
  advisory-leased (single instance).
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
