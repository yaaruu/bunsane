# RFC: Materialized Read Models — ECS Projection Layer

**Status:** Draft
**Author:** yaaruu (drafted with Claude)
**Date:** 2026-06-27
**Companion:** `docs/RFC_ECS_PG_SORT_DENORMALIZATION.md` — defines the L0–L4 solution ladder. This RFC operationalizes its **L1 (generated columns)** and **L3 (projection tables)** rungs, and adds the developer-facing API + GraphQL integration story that the companion left open.

---

## 1. Problem statement

BunSane stores every component as a JSONB row in a single partitioned `components` table. One entity composed of *K* components is *K* rows. This is excellent for write flexibility and runtime authoring, but it is a structural impedance mismatch for the read side of typical line-of-business apps (ERP, CRM):

- **Read amplification.** Reading one archetype assembles *K* rows + JSONB decode + app-side stitching, versus one typed row in a conventional schema.
- **Optimizer blindness.** Filters/sorts compile to `data->>'field'` expressions (see `query/ComponentInclusionNode.ts`). Postgres has no column statistics on JSONB-extracted values, so selectivity estimates and join planning are poor.
- **Reporting is the real pain.** `SUM(...) GROUP BY region` across components, ad-hoc BI tooling (Metabase/PowerBI), and multi-field constraints all expect typed columns in real tables. EAV/JSONB is notoriously weak here.

These workloads are **read-heavy** (reports ≫ writes), so the cost lands exactly where it hurts most.

The fix is not to abandon ECS. It is to keep ECS as the write path and **derive** typed, indexed read structures from it — a CQRS split where the framework, not the application developer, owns the fan-out.

## 2. Core principle (inherited from companion)

> **JSONB is the single source of truth, always.** Every derived structure (generated column, projection table, read model) is **disposable and reconstructable**. A field change is a *reconcile / rebuild*, never a data migration. Derived structures are a cache, not a second source of truth.

Extension for this RFC: **the framework owns the projection lifecycle** (DDL, sync, backfill, reconcile). Application code declares *what* to project, never *how* to keep it in sync. There is exactly one write path — `Entity.save()` — in every tier.

## 3. Verdict: what NOT to build

- **No second write API.** Developers never write to a projection directly. One write path, always ECS.
- **No fake unification of CRUD and reporting.** "Fetch my entity" and "run a report" are different mental models. We make the entity path *transparently faster* (Tier M1/M2) and keep reports an *explicit, honest* surface (Tier M3). We do **not** invent a single magic API pretending they are the same — that is the leaky abstraction previously rejected for REST+GraphQL.
- **No `LISTEN/NOTIFY` as the primary refresh path.** We reuse the existing transactional outbox (`core/remote/`), which is already multi-instance-safe and durable.
- **No new ORM / query language over projection tables.** Read models are queried via existing GraphQL operations or direct SQL.
- **No `pg_ivm` / materialized-view extension dependency.** Refresh is application-driven via hooks/outbox so it works on managed Postgres and PGlite alike.

## 4. The three materialization tiers

The tiers map onto the existing abstractions rather than introducing a parallel concept. **ArcheType is already a read model** — it maps components → typed GraphQL fields, emits the type, and generates the resolver. The only thing it does not currently decide is *where the resolver reads from*. That insight drives the fork below.

| Tier | Capability | Backs which abstraction | Companion rung | Separate concept? | Sync cost |
|------|-----------|------------------------|----------------|-------------------|-----------|
| **M1** | Typed generated column on a component field | `@CompData({ projected: true })` | L1 | No — same component, same table | **Zero** (Postgres derives on write) |
| **M2** | Denormalized one-row-per-entity table for an archetype | `@ArcheType({ materialize })` | L3 (single-entity) | No — same archetype, swap resolver source | Async (hook/outbox) |
| **M3** | Cross-entity / aggregate read model (joins, rollups) | `@ReadModel(...)` | L3 (multi-entity) | **Yes** — archetype is single-entity, cannot express it | Async (hook/outbox) |

Decision rule:

```
single component field, just needs index/typed filter  → M1  (CompData.projected)
single entity + its components, faster whole reads      → M2  (ArcheType.materialize)
cross-entity joins / aggregates / report shapes         → M3  (ReadModel, read-only)
```

Rationale (Gall's Law, per global guidelines): extend the thing that already works before adding a concept. M1 and M2 reuse existing decorators and the existing schema pipeline. M3 earns a new concept only because its shape (multi-entity join) is structurally inexpressible as an archetype.

### 4.1 Tier M1 — projected generated columns

**Developer surface (unchanged mental model):**

```typescript
@Component
class Invoice extends BaseComponent {
    @CompData({ indexed: true, projected: true }) status: string = "draft";
    @CompData({ projected: true }) total: number = 0;
}
```

```typescript
// write — UNCHANGED
await entity.set(Invoice, { status: "paid", total: 500 });

// query — UNCHANGED API, silently routes to the typed column
new Query().with(Invoice, { filters: [["status", "=", "paid"]] }).exec();
```

`projected: true` causes the migration layer to emit, on the component's **LIST leaf partition** (`components_invoice`):

```sql
ALTER TABLE components_invoice
  ADD COLUMN IF NOT EXISTS proj_status text
  GENERATED ALWAYS AS ((data->>'status')) STORED;
CREATE INDEX IF NOT EXISTS idx_components_invoice_proj_status
  ON components_invoice (proj_status);
```

The Query builder consults component metadata at SQL-build time; when a filtered/sorted field is `projected`, it emits `c.proj_status = $1` (B-tree, with stats) instead of `c.data->>'status' = $1`. **No schema change, no sync, no staleness** — Postgres computes the column on every write. This is the cheapest tier and the recommended first step.

**Hard constraint:** generated columns are only emitted under the **LIST** partition strategy (per-component leaf tables exist). Under **HASH** partitioning there are no per-component tables (16 generic buckets spanning all types), so M1 is a no-op + warning there. See §6.

### 4.2 Tier M2 — materialized archetype

```typescript
@ArcheType({
    components: [Invoice, LineItems],
    materialize: "generated" | "table" | "none"   // default "none"
})
class InvoiceArcheType extends BaseArcheType { ... }
```

| `materialize` | Resolver reads from | Sync |
|---------------|---------------------|------|
| `"none"` (default) | current populate / DataLoader waterfall | — |
| `"generated"` | component leaf partitions, but filters/sorts use M1 columns | zero |
| `"table"` | a denormalized `rm_invoicearchetype` table, one row per entity | async (§5) |

**Why this needs no GraphQL change:** the emitted SDL is built in `core/archetype/zodSchemaBuilder.ts` and is fully decoupled from the resolver built in `core/archetype/fieldResolvers.ts`. `materialize` swaps **only** the resolver's data source; the GraphQL type, field set, and client contract are byte-identical. Consumers cannot tell which tier backs a type, so M1↔M2↔none can be changed without breaking clients.

### 4.3 Tier M3 — read model (cross-entity, read-only)

```typescript
@ReadModel({
    from: [Invoice, Customer],          // Customer is a *different* entity (relation)
    join: { on: "Invoice.customerId = Customer.id" },
    refresh: "async",                   // outbox-driven, eventual
    rebuildable: true,                  // re-derive from JSONB anytime
})
class InvoiceReport {
    @Project(Invoice, "total")   total!: number;
    @Project(Customer, "region") region!: string;
    @Project(Invoice, "status")  status!: string;
}
```

```typescript
// still ONE write path — ECS
await invoiceEntity.set(Invoice, { status: "paid", total: 500 });

// report query — typed table, BI-shaped
await ReadModel(InvoiceReport).where("status", "paid").groupBy("region").sum("total");
```

A `ReadModel` contributes a **read-only** GraphQL type (no mutations — it is derived) into the same weaver pipeline an archetype uses. The framework owns table DDL, sync wiring, and reconcile. Developers write **zero** sync code.

## 5. Refresh paths (Gall's Law — simplest that works)

All M2-`table` and M3 sync reuses existing infrastructure. No new transport.

| Path | Mechanism | Consistency | When |
|------|-----------|-------------|------|
| **Write-through** | `remoteManager.emit(target, evt, payload, { trx })` inside `doSave` — outbox row atomic with the entity write | Strong (atomic, no lost update on crash) | Small tables, strict consistency |
| **Post-commit hook** | `EntityHookManager` `entity.created` / `entity.updated` handler upserts the projection row | Eventual (~ms) | General case |
| **Outbox fan-out** | outbox row → `OutboxWorker` → Redis Stream → per-instance consumer upserts | Eventual (~1s) | Multi-instance |
| **Batch rebuild** | scheduled scan of `components` partitions → `INSERT ... ON CONFLICT DO UPDATE` | Eventual (minutes) | Initial backfill, post schema-drift reconcile |

The `handleCacheAfterSave` step in `core/entity/cacheStrategies.ts` is the exact pattern a projection step follows (same signature: `entity`, `changedComponentTypeIds`, `removedComponentTypeIds`; same error-swallow discipline; runs in the tracked post-commit microtask so shutdown/tests can drain it).

`refresh: "sync"` selects write-through; `refresh: "async"` selects the post-commit/outbox path.

## 6. Constraints & gotchas (recon-verified)

1. **Partition strategy gates M1/M2-table.** Generated columns live on LIST leaf partitions (`components_<name>`). Postgres forbids them on the partitioned parent; HASH buckets span all component types so per-field columns are impractical. → M1/M2-table are **LIST-only**; emit a one-time warning and fall back to JSONB under HASH. Guard mirrors the existing `partitionStrategy === 'hash'` check at `core/components/ComponentRegistry.ts:318`.
2. **PGlite.** `CREATE INDEX CONCURRENTLY` must stay gated on `!process.env.USE_PGLITE` (existing pattern, `database/DatabaseHelper.ts:339`). PGlite generated-column support must be verified empirically in Phase 0; if absent, M1 degrades to plain JSONB transparently.
3. **Filter/sort SQL is not DRY.** Field→SQL is built in ~4 independent sites that all must learn projection routing, or be refactored to a shared helper first:
   - `query/ComponentInclusionNode.ts:71-112` `buildFilterCondition()`
   - `query/ComponentInclusionNode.ts:1043-1088` `applyComponentFiltersWithState()`
   - `query/Query.ts:785-793` `doAggregate()`
   - the four sort-expression builders gated by `isNumericProperty()` (`ComponentInclusionNode.ts:16-35`)
   Recommended: introduce `getProjectedColumn(typeId, field)` and route through it in one shared `buildFieldSql()` helper to avoid drift.
4. **Component events are pre-commit.** `component.added/updated/removed` fire on in-memory `entity.add/set/remove` (`core/entity/componentAccess.ts`), *before* the transaction commits. Projection sync MUST use post-commit `entity.created/updated` hooks or the outbox — never the component events — for durability.
5. **`doDelete` post-delete side effects** run in a bare `queueMicrotask` not tracked by `drainPendingSideEffects` (per `RFC_REFACTOR_TARGETS.md`). A deletion-projection step shares that visibility gap; tighten before relying on it for M3 row removal.
6. **SqlIdentifier validation** (`query/SqlIdentifier.ts`) already guards interpolated field names; new generated-column names must pass `assertIdentifier` too.
7. **Weaver name collisions.** `weaveAllArchetypes()` weaves all registered ZodObjects together; an M3 read-model whose component types overlap an archetype must use distinct type names or identical schemas (dedup warning otherwise).

## 7. Integration map (where each tier hooks in)

| Tier | Metadata | DDL / migration | Read path |
|------|----------|-----------------|-----------|
| **M1** | add `projected?: boolean` to `ComponentPropertyMetadata` (`core/metadata/definitions/Component.ts:7`), thread through `CompData()` (`core/components/Decorators.ts:54`) | new `ensureGeneratedColumn()` in `database/DatabaseHelper.ts`, called from `ComponentRegistry.setupComponentFeatures()` (`core/components/ComponentRegistry.ts:295`, after the index block ~323), LIST-guarded | `getProjectedColumn()` consulted in the 4 SQL-build sites (§6.3) |
| **M2** | `materialize` option on `@ArcheType` decorator (`core/archetype/decorators.ts:28`) | reuse M1 for `"generated"`; new `rm_<archetype>` table DDL for `"table"` | branch in `buildFieldResolvers()` (`core/archetype/fieldResolvers.ts:30`) before the DataLoader waterfall (lines 69-154) — SDL untouched |
| **M3** | new `@ReadModel` / `@Project` decorators + storage map | new `rm_<name>` table DDL; sync handler registered on `EntityHookManager` / `RemoteManager` | register ZodObject via `allArchetypeZodObjects.set()` (`core/archetype/weaver.ts:14`) + `@GraphQLOperation` Query-only service; live via `ServiceRegistry.rebuildSchema()` (`service/ServiceRegistry.ts:87`) |
| **sync** | — | `remote_outbox` (`core/remote/outboxSchema.ts`), `OutboxWorker` (`core/remote/OutboxWorker.ts`) | post-commit step in `runPostCommitSideEffects` (`core/entity/saveEntity.ts:101-136`), modeled on `cacheStrategies.ts:17-73` |

## 8. Phases (each ships working) — RE-PRIORITIZED after Phase 0

Phase 0 measurement (§9) showed the 100× is a **missing-index** problem the framework can already fix with a B-tree expression index. So the order changed: ship the cheap index-default fix first; generated columns / projection tables follow as second-stage wins for aggregation/reporting.

- **Phase 0 — prove the speedup.** ✅ DONE 2026-06-27. `tests/benchmark/projection-benchmark.ts`, fair 3-way (GIN / btree-expr / generated) on staging PG 17.10 @ 1M rows. Result: missing-index = 100–182×; generated-over-btree = 1.2–1.84×. (Sync-loop half — post-commit upsert proof — not yet done.)
- **Phase 1 — fix the scalar index default (HIGHEST ROI, near-zero cost). ✅ DONE 2026-06-27.** `@CompData({ indexed: true })` now picks the index type by property type: scalar string/uuid/enum/bool/date → **B-tree** `((data->>'field'))`, number → **numeric** functional index, array/object → **GIN** (containment). Existing scalar-GIN footguns are dropped on startup (idempotent migration, no double-indexing). Implementation: `database/IndexingStrategy.ts` (`pickScalarIndexType`, `ensureLegacyIndexedFields`, `dropIndexIfExists`) wired into `core/components/ComponentRegistry.ts` `setupComponentFeatures()`; the old GIN-only `UpdateComponentIndexes` path is no longer used for this. Query layer needed **zero** changes — it already emits `data->>'field'`, which the new B-tree serves. Tests: `tests/integration/database/LegacyIndexType.test.ts` (4/4 PGlite — type mapping, footgun drop, idempotency, Index-Scan plan assertion); no regression across DB/component/query parity suites. **This is the change that actually answers "why was it slow."**
- **Phase 2 — M1 generated columns (`@CompData({ projected })`).** For fields needing the extra aggregation/stats win or typed routing. DDL emission + route the 4 SQL sites via shared `getProjectedColumn()`. LIST-guard + PGlite gate. Justified by the 1.84× aggregation gain + clean column routing, **not** by the 100×.
- **Phase 3 — M2 `materialize: "generated" | "table"` + reconciler.** Archetype-level materialization; resolver swap with byte-identical SDL assertion; projection table DDL, post-commit upsert, batch backfill, startup shape-hash drift → rebuild (reconcile-not-migrate).
- **Phase 4 — M3 read models.** `@ReadModel` cross-entity join projection, read-only GraphQL type, outbox-driven multi-instance fan-out.

Each phase is independently shippable; Phases 2–4 are gated on measured demand (see Open questions). **Phase 1 should ship regardless** — it is a bug-class fix, not a feature.

## 9. Expected gain — MEASURED (Phase 0, ✅ 2026-06-27)

Benchmark `tests/benchmark/projection-benchmark.ts`, **real staging Postgres 17.10** (`infra-postgres`, direct, isolated scratch DB), **1,000,000 rows**, 30 runs/query, median. **Fair 3-way** comparison — this is the corrected result after an initial run conflated "missing index" with "generated column":

- **A — GIN-only**: `data->>'field'` filter with the per-field **GIN** index `@CompData({ indexed: true })` creates today (`((data->'field') jsonb_path_ops)`).
- **B — btree-expr**: same SQL, with the **B-tree expression index** `((data->>'field'))` that `@IndexedField('btree')` already creates today.
- **C — generated col (M1)**: typed `GENERATED ALWAYS AS (...) STORED` column + B-tree (this RFC's proposal).

| Query | A: GIN-only | B: btree-expr | C: generated | A→C | **B→C (true M1 gain)** |
|-------|------------|--------------|--------------|-----|------------------------|
| Selective filter `customerId = ?` (~1 row) | 43.0ms | 0.48ms | **0.40ms** | 108× | **1.20×** |
| Sort + limit `ORDER BY total LIMIT 20` | 70.8ms | 0.48ms | **0.39ms** | 182× | **1.23×** |
| Aggregation `SUM(total) GROUP BY region` | 268ms | 106.5ms | **57.9ms** | 4.6× | **1.84×** |

### 9.1 What the numbers actually say (corrected verdict)

**The 100–182× is a missing-index problem, not a generated-column win.** JSONB `data->>'field'` equality/ordering cannot use a GIN index (GIN serves containment `@>`, not `->>`), so column A seq-scans / full-sorts. A *plain B-tree expression index* (column B) — which BunSane can **already** create via `@IndexedField('btree')` — recovers ~99% of the gap (plans A→B: Seq Scan → Index Scan, Sort → Index Scan Backward).

**The true marginal value of generated columns over a btree expression index is modest: ~1.2× for filter/sort, ~1.84× for aggregation.** Generated columns win meaningfully only where typed column **statistics** and narrower row width matter — i.e. aggregation/reporting (1.84×, from `HashAggregate`-friendly stats + `numeric` column vs per-row text cast).

### 9.2 The real, cheap, high-value finding

`@CompData({ indexed: true })` defaulting to **GIN** is a **footgun**: a developer who marks a scalar field `indexed: true` expecting fast `=` / `ORDER BY` silently gets a GIN index the planner cannot use for those → seq scan. The highest-ROI fix is **not** generated columns — it is **making scalar `indexed: true` create a B-tree expression index** (GIN only for array/object fields). That single change captures the 100×, with zero new concepts, zero sync, zero storage doubling.

This **re-prioritizes the RFC** (see updated §8): generated columns (M1) and projection tables (M2/M3) remain valuable for **aggregation/reporting and clean query routing**, but they are a *second-stage* optimization. The first stage is fixing the index default.

Cost-benefit unchanged in shape (`profit = read_freq × latency_saved − write_freq × cost − storage − complexity`), but the cheap win (index default) has near-zero cost terms and should ship first.

## 10. Non-Goals

- Not a replacement for the JSONB component store — projections are derived only.
- No synchronous-only coupling that charges projection cost to the save budget (post-commit by default).
- No ORM/query DSL over projection tables in Phases 0–3.
- No materialized-view extension dependency.
- M1/M2-table under HASH partitioning is explicitly out of scope (LIST-only).

## 11. Open questions

- **Measure first.** What are the row counts + read/write ratios of the hottest archetypes? This gates whether Phases 3–4 are worth building at all (companion RFC: "MEASURE before building").
- **Opt-in granularity.** Per-field (`projected`) and per-archetype (`materialize`) opt-in is assumed. Is a framework-wide default ever desirable? (Leaning no.)
- **Schema-drift ownership.** On projected-field change, does the framework auto-reconcile (drop + rebuild generated column / projection table) on startup, or require an explicit migration flag? Default proposal: auto for M1 (cheap, derived), explicit-confirm for M2-table/M3 (larger rebuild).
- **Deletion durability.** Close the `doDelete` post-commit tracking gap (§6.5) before M3 relies on hook-driven row removal.
- **Should M2 and M3 eventually merge?** If archetypes ever span relations, M3 and M2 converge into one materialized-view concept. Deferred — only if archetype scope expands.
