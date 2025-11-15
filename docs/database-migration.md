# Database Partitioning Strategy: HASH Partitioning

## Overview

This document describes the migration from LIST partitioning to HASH partitioning for the `components` table in Bunsane Framework. This is part of Phase 4 of the query performance optimization plan.

## Background

### Previous State (LIST Partitioning)
- **Partitioning Key**: `type_id` with LIST strategy
- **Partitions**: One partition per component type (e.g., `components_GoogleMapAccountQuota`)
- **Issues**: High planning time due to 44+ partitions explored during query planning

### New State (HASH Partitioning)
- **Partitioning Key**: `type_id` with HASH strategy
- **Partitions**: Fixed number of partitions (8-32) distributed by hash of `type_id`
- **Benefits**: Reduced planning time, better partition pruning, scalable to many component types

## Implementation

### Configuration
Set the environment variable to use hash partitioning:

```bash
export BUNSANE_PARTITION_STRATEGY=hash
```

Or in `.env`:
```
BUNSANE_PARTITION_STRATEGY=hash
```

### Database Setup
When `PrepareDatabase()` is called, it will create hash-partitioned components table with 16 partitions by default.

To customize partition count, modify `CreateHashPartitionedComponentTable(partitionCount)`.

### Partition Count Selection
Recommended partition counts:
- **8 partitions**: For smaller datasets (< 1M rows)
- **16 partitions**: Balanced performance (default)
- **32 partitions**: For large datasets (> 10M rows)

## Performance Expectations

### Planning Time Reduction
- **Before**: ~16ms planning time
- **After**: <3ms planning time (81% improvement)

### Query Optimization
Hash partitioning enables better partition pruning when queries filter on `type_id`:

```sql
-- This will prune to 1 partition
SELECT * FROM components WHERE type_id = 'GoogleMapAccountQuota';
```

## Monitoring

### Check Partition Distribution
```sql
SELECT 
    inhrelid::regclass as partition_name,
    pg_size_pretty(pg_total_relation_size(inhrelid)) as size,
    (SELECT count(*) FROM inhrelid::regclass) as row_count
FROM pg_inherits 
WHERE inhparent = 'components'::regclass
ORDER BY pg_total_relation_size(inhrelid) DESC;
```

### Verify Partition Pruning
```sql
SET constraint_exclusion = partition;
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM components WHERE type_id = 'GoogleMapAccountQuota';
```

Look for "Partitions scanned: 1" in the EXPLAIN output.

## Benchmarking

Use the `BenchmarkPartitionCounts()` function to test different partition counts:

```typescript
import { BenchmarkPartitionCounts } from './database/DatabaseHelper';

const results = await BenchmarkPartitionCounts([8, 16, 32]);
console.log(results);
```

## Troubleshooting

### Partition Pruning Not Working
- Ensure `constraint_exclusion = partition` (default in PostgreSQL 12+)
- Check that queries filter on `type_id`
- Verify partition bounds with hash function

### Uneven Data Distribution
Hash partitioning distributes based on hash of `type_id`. If certain `type_id` values cluster, consider:
- Using a composite partitioning key
- Adjusting partition count
- Switching to RANGE partitioning if needed

### Index Recreation
After changing partitioning strategy, indexes need recreation on partitions.

## Future Considerations

### Scaling Beyond HASH
If hash partitioning shows limitations:
- Consider RANGE partitioning on a composite key
- Evaluate partial indexes for hot partitions
- Monitor for partition skew over time

### Related Documentation
- [PostgreSQL Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Bunsane Query Optimization](../query-optimization.md)
- [Index Strategy](../database/indexing-strategy.md)