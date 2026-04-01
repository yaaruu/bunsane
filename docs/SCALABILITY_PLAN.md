# BunSane Scalability Plan: 1M+ Entities

## Problem Statement

At 50k entities, complex multi-component queries with sorting degrade catastrophically:
- 10k entities: 20ms
- 50k entities: 7,880ms (394x slower)
- Projected 1M: minutes to hours

Root cause: Cartesian product explosion in nested loop joins when sorting on JSONB fields.

## Bottleneck Analysis

### 1. Multi-Component Query Pattern (Critical)

Current SQL for 2-component query:
```sql
SELECT DISTINCT ec.entity_id
FROM entity_components ec
WHERE ec.type_id IN ($1, $2) AND ec.deleted_at IS NULL
GROUP BY ec.entity_id
HAVING COUNT(DISTINCT ec.type_id) = 2
```

**Problem**: Scans ALL entity_components for ALL matching types, then aggregates.
At 1M entities × 3 components = 3M rows scanned before filtering.

**Solution**: Use INTERSECT or EXISTS pattern:
```sql
-- Option A: INTERSECT (better for 2-3 components)
SELECT entity_id FROM entity_components WHERE type_id = $1 AND deleted_at IS NULL
INTERSECT
SELECT entity_id FROM entity_components WHERE type_id = $2 AND deleted_at IS NULL

-- Option B: EXISTS (better for many components)
SELECT DISTINCT e.entity_id
FROM entity_components e
WHERE e.type_id = $1 AND e.deleted_at IS NULL
AND EXISTS (SELECT 1 FROM entity_components e2
            WHERE e2.entity_id = e.entity_id AND e2.type_id = $2 AND e2.deleted_at IS NULL)
```

### 2. Sorting on JSONB Fields (Critical)

Current pattern:
```sql
ORDER BY c.data->>'age' DESC
```

**Problem**: Can't use B-tree indexes, falls to sequential scan + in-memory sort.

**Solutions**:

A. **Expression Index** (per-field, must exist):
```sql
CREATE INDEX idx_testuser_age_btree ON components_testuser ((data->>'age'));
-- For numeric sorting:
CREATE INDEX idx_testuser_age_numeric ON components_testuser (((data->>'age')::numeric));
```

B. **Query must cast for numeric sort**:
```sql
ORDER BY (c.data->>'age')::numeric DESC  -- Uses numeric index
```

C. **Covering Index** (include entity_id for index-only scan):
```sql
CREATE INDEX idx_testuser_age_covering
ON components_testuser ((data->>'age'), entity_id)
WHERE deleted_at IS NULL;
```

### 3. Missing Index on entities.deleted_at

Every query does `WHERE deleted_at IS NULL` on entities table.

**Fix**:
```sql
CREATE INDEX idx_entities_deleted_null ON entities (id) WHERE deleted_at IS NULL;
```

### 4. OFFSET Pagination Scaling

`OFFSET 900000` requires scanning 900k rows to skip them.

**Already implemented**: `cursor(entityId)` pagination in Query.ts.
**Action**: Document as required pattern for large datasets.

## Implementation Plan

### Phase 1: Quick Wins (Immediate)

1. **Add missing index on entities**
   - File: `database/DatabaseHelper.ts`
   - Add: `idx_entities_deleted_null`

2. **Numeric cast in ORDER BY**
   - File: `query/ComponentInclusionNode.ts`
   - Detect numeric fields and add `::numeric` cast

3. **Use INTERSECT for 2-3 component queries**
   - File: `query/ComponentInclusionNode.ts`
   - Threshold: Use INTERSECT when componentIds.size <= 3

### Phase 2: Index Strategy (Short-term)

4. **Auto-create expression indexes for sortable fields**
   - File: `database/IndexingStrategy.ts`
   - Add: `createSortIndex(table, field, type: 'text' | 'numeric' | 'date')`

5. **Query hints for sort fields**
   - New decorator: `@SortableField(type)`
   - Creates appropriate expression index at registration

### Phase 3: Query Restructuring (Medium-term)

6. **EXISTS pattern for multi-component with filters**
   - Rewrite CTE to use correlated EXISTS
   - Push filters into EXISTS subqueries

7. **Batch entity lookup optimization**
   - Use `= ANY($1::uuid[])` instead of `IN (...)` for large ID lists
   - Better plan caching with array parameter

### Phase 4: Denormalization Options (Long-term)

8. **entity_component_summary table**
```sql
CREATE TABLE entity_component_summary (
    entity_id UUID PRIMARY KEY,
    component_types TEXT[],  -- Array of type_ids
    updated_at TIMESTAMP
);
CREATE INDEX idx_ecs_types_gin ON entity_component_summary USING GIN (component_types);
```

Query pattern:
```sql
SELECT entity_id FROM entity_component_summary
WHERE component_types @> ARRAY[$1, $2]::text[]
```

9. **Materialized views for hot paths**
   - Pre-join common component combinations
   - Refresh on schedule or trigger

## Benchmarks Required

| Scenario | Target (1M entities) |
|----------|---------------------|
| Single component, no filter | < 50ms |
| Single component, indexed filter | < 20ms |
| 2-component intersection | < 100ms |
| 3-component intersection | < 200ms |
| Sort on indexed field, limit 100 | < 50ms |
| Complex (2-comp + filter + sort) | < 500ms |
| Count | < 100ms |
| Cursor pagination (any page) | < 50ms |

## Migration Strategy

1. New indexes are additive (no breaking changes)
2. Query optimizations are **always on** (no feature flag needed)
3. INTERSECT + scalar subquery patterns enabled by default since v0.2.7
4. LATERAL joins disabled for INTERSECT queries to fix SQL generation bug (2026-03-14)

## Files to Modify

- `database/DatabaseHelper.ts` - Add entity index
- `database/IndexingStrategy.ts` - Sort index creation
- `query/ComponentInclusionNode.ts` - INTERSECT pattern, numeric cast
- `query/QueryDAG.ts` - Component count threshold for strategy selection
- `core/components/Decorators.ts` - @SortableField decorator
- New: `query/strategies/IntersectStrategy.ts`
- New: `query/strategies/ExistsStrategy.ts`
