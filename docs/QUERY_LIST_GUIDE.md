# Query List Guide (app authors)

**Audience:** teams building admin/ops list endpoints on BunSane 0.6.x  
**Date:** 2026-08-07  
**Deeper engine detail:** `docs/READ_PATH_PERFORMANCE.md` · QSP ops: `docs/QSP_OPERATIONS.md`

This guide is the **product-facing** checklist for “filter + sort + page + hydrate” lists.
It reflects real usage in multi-component apps (POS-style order lists, ride-hailing admin lists).

---

## 1. Default list shape (prefer this)

```ts
const q = new Query()
  .with(StatusComp, Query.filters(Query.filter('status', Query.filterOp.EQ, status)))
  .with(InfoComp, infoFilters)
  .with(TimelineComp)
  .sortBy(TimelineComp, 'createdAt', 'DESC')
  .take(pageSize); // explicit take enables hasNextPage (LIMIT n+1)

const items = await q.exec();
const { hasNextPage, routed, surface, archetype } = q.getLastRouteInfo();
```

| Do | Don’t |
|----|--------|
| Explicit `.take(N)` and use `hasNextPage` | Call `.count()` on every page for infinite scroll |
| One sort key + `sortedCursor` for deep pages | Deep `.offset(10000)` or `.cursor(id)` with `sortBy` |
| `@CompData({ indexed: true })` on filter/sort fields | Filter/sort unindexed JSON paths |
| `.eagerLoadComponents([...])` or `.populate()` for fields you read | `await entity.get(C)` in a loop without eager load |
| Batch FK companions (`WHERE order_id = ANY($1)`) | Nested `new Query().with(...).filter(fk, parent.id)` per row |

**RP-06b:** `.sortBy(...).cursor(entityId)` **throws**. Use:

```ts
const token = Query.encodeSortedCursor(lastSortValue, lastEntityId);
await new Query() /* same with/sort */ .take(N).sortedCursor(token).exec();
```

---

## 2. Tags, multi-component sets, and QSP

### Empty tag components

```ts
class OrderTag extends BaseComponent {} // no @CompData fields
```

- Fine as **membership markers** on legacy queries: `.with(OrderTag)`.
- **Break QSP coverage** if included in `.with()`: tags project **no columns**, so the query set never equals the archetype projected set.
- **Workaround for hot QSP lists:** drop the tag from the list query; require the data components every real entity has. Document role/type in a real field if you need to filter by it on the fast path.

### Full GraphQL archetype ≠ list surface

Optional components (void, receipt, delivery extras) should **not** all be `@ArcheTypeField` on the QSP list archetype, or entities missing them never appear in `rm_` membership the way you expect for “all orders.”

**Pattern:** list-only archetype for QSP + Query builder locked to that set; GraphQL response type can still be the full archetype after hydrate.

### Multi-archetype / cross-entity

There is **no** QSP join across archetypes. Patterns that work today:

1. List primary entities with a covered Query.
2. Second query: child components `filter('parentId', 'IN', ids)` in chunks.
3. Merge in the service layer (thumbs, line items, attempts).

Matcher-style queries (many tags + `.without` + spatial) stay on **legacy** — invest in indexes and batch scoring, not QSP day one.

---

## 3. Hydration and N+1

| Layer | Symptom | Fix |
|-------|---------|-----|
| Membership SQL | Slow single statement | Indexes, sort-driven shape, QSP for covered sets |
| Hydrate | `get` after `exec` without eager load | `.eagerLoadComponents([A,B,C])` or `.populate()` |
| GraphQL relations | N queries for `@BelongsTo` / `@HasMany` | Request DataLoaders (`createRequestLoaders`) |
| GraphQL computed fields | Query-per-parent in `@ArcheTypeFunction` | Batch by parent ids once; attach map |
| Stats / dashboards | `take(50000)` + sum in JS | Cross-entity: `@ReadModel` + `ReadModel(T).where/groupBy/sum`. Same entity: `Query.groupBy` + `countBy`/`sumBy`/`maxBy`. Open rows: `FilterOp.IS_NULL` |

**Diagnose:** per-request `dbQueryCount` in access logs. If it scales with page size while `EXPLAIN` looks fine, you have N+1, not a bad INTERSECT.

---

## 4. Count and pagination modes

| Need | API |
|------|-----|
| Load more / infinite scroll | `.take(N)` + `getLastRouteInfo().hasNextPage` |
| Exact total pages | `.count()` (expensive; cache if possible) |
| QSP count strategy | `BUNSANE_QSP_COUNT=n_plus_1` \| `estimate` \| `exact` |
| Deep sorted pages | `sortedCursor` (not OFFSET) |
| Unsorted id pages | `.cursor(entityId)` **without** `sortBy` |

Framework default LIMIT (when you never call `.take`) does **not** run n+1 / hasNextPage — only **explicit** `.take(N)`.

---

## 5. When to turn on QSP

| Good first candidates | Bad first candidates |
|----------------------|----------------------|
| Stable multi-comp order/admin lists | Spatial driver match pools |
| Ledger / payment event lists by date | Admin OR search (ILIKE across fields) |
| Customer order history (fixed comps) | Queries that need `.without(Tag)` |
| | Lists that require empty tags in `.with()` |

Ops: `docs/QSP_OPERATIONS.md` checklist (`shadow` → soak → `route`, scope `BUNSANE_QSP_ARCHETYPES`, start reconcile sweep yourself).

---

## 6. Filters still weak on legacy

Prefer:

- Indexed EQ / range / IN on scalar fields  
- Sort-driven path: multi-`.with` + **one** `sortBy` + `take` (+ optional `sortedCursor`)  
- `BUNSANE_USE_DIRECT_PARTITION=true` (default) on list partitions  

Avoid / accept cost:

- OR across components (admin search) — works; may force entity-id order or multi-query merge  
- Unindexed ILIKE `%term%`  
- Exact count on huge filtered sets  
- Post-filter in memory after `take(LIST_MAX)` for voids/tags (prefer SQL when possible)

---

## 7. Quick checklist before shipping a list endpoint

- [ ] Every filtered/sorted field is `@CompData({ indexed: true })` (or entity column sort)
- [ ] Explicit `.take` + `hasNextPage` (or intentional exact count with caching)
- [ ] No `cursor(id)` + `sortBy` (use `sortedCursor`)
- [ ] Eager load / populate / loaders for every field the response reads
- [ ] No per-row nested Query in GraphQL list resolvers
- [ ] If QSP: list archetype exact set, no empty tags, ops runbook followed
- [ ] Real-PG `EXPLAIN` once on staging for the hot query (not only PGlite)

---

## 8. Aggregates (not lists)

`Query.exec()` hydrates entities. Do **not** pull a month of orders with `take(50000)` and reduce in JS.

| Need | API |
|------|-----|
| Cross-entity join + `GROUP BY` | `@ReadModel` / `@Project`, then `ReadModel(T).where(...).where("paidAt", "gte", start).groupBy("region").sum("total")` |
| Date range / `IN` / count / avg | `where(field, op, value)` with `gte`/`lte`/`in`, `.count()`, `.avg()` — SQL on `m3_*`, not a JS loop |
| Single-component scalar SUM/AVG | `new Query().with(C).sum(C, "amount")` / `.average(C, "amount")` |
| Per-key COUNT/SUM/MAX/MIN | `new Query().with(C).groupBy(C, "customerId").countBy()` / `.sumBy(C, "total")` / `.maxBy(C, "createdAt")` / `.minBy(...)` |
| Open rows / last event | `FilterOp.IS_NULL` / `IS_NOT_NULL` (missing, JSON null, or `''`). Last-seen: `.groupBy(C, "ownerId").maxBy(C, "createdAt")` |
| Average duration | `.groupBy(C, "techId").avgIntervalMinutesBy(C, "assignedAt", "completedAt")` (same component, Date fields) |
| List screens | QSP / `Query.exec` (this guide) |

```ts
@ReadModel({
  from: [Invoice, Customer],
  join: { on: "Invoice.customerId = Customer.id" },
})
class InvoiceReport {
  @Project(Invoice, "total") total!: number;
  @Project(Customer, "region") region!: string;
  @Project(Invoice, "status") status!: string;
  @Project(Invoice, "paidAt") paidAt!: Date;
}

await ReadModel(InvoiceReport)
  .where("status", "paid")
  .where("paidAt", "gte", start)
  .where("paidAt", "lte", end)
  .groupBy("region")
  .sum("total");
```

Grain today is **one row per join pair**, not a daily fact `(outlet, day)`. Daily KPIs either group a date column at read time (`trunc` / `timeBucket`) or wait for a later rollup. QSP `rm_*` tables are list coverage, not this.

Site: `bunsane-docs/docs/query-aggregates.md`, `bunsane-docs/docs/read-models.md`.

## 9. Code map

| Concern | Location |
|---------|----------|
| Query builder | `query/Query.ts` |
| Filter coalesce / pushdown | `query/FilterBuilder.ts`, `ComponentInclusionNode.ts`, `CTENode.ts` |
| Numeric index predicates | `database/numericJsonField.ts` |
| QSP planner | `query/planner/SurfacePlanner.ts` |
| Projection metadata | `database/projection/ProjectionMetadata.ts` |
| M3 read models | `core/readmodel/`, `database/readmodel/` |
| Request DataLoaders | `core/RequestLoaders.ts` |
| Config flags | `docs/CONFIGURATION.md` |
