# Partition Strategy Benchmark Suite

This directory contains a comprehensive benchmark suite for comparing LIST vs HASH partitioning strategies in Bunsane.

## Overview

The benchmark suite compares three partitioning approaches:

1. **LIST** - LIST partitioning with parent table queries (PostgreSQL partition pruning)
2. **LIST+Direct** - LIST partitioning with direct partition table access (NEW)
3. **HASH** - HASH partitioning (current baseline)

## Files

- `partition-benchmark-utils.ts` - Core benchmark utilities and test scenarios
- `partition-strategy.test.ts` - Bun test suite for benchmark scenarios
- `run-partition-benchmark.ts` - Command-line benchmark runner
- `README.md` - This documentation

## Test Scenarios

The benchmark runs these query types:

1. **Single Component Filter** - Simple WHERE clause on one component type
2. **Multi Component AND** - Multiple component types with AND logic
3. **OR Query** - OR logic across multiple component types
4. **Sort Query** - Sorting by component data fields
5. **Populate Single Type** - Loading single component type data
6. **Populate Multi Type** - Loading multiple component types data
7. **Count Query** - COUNT operations with filters

## Running Benchmarks

### Quick Test (Small Dataset)

```bash
# Run a quick test with 500 entities
bun run test/benchmarks/run-partition-benchmark.ts --entities 500
```

### Full Benchmark Suite

```bash
# Run complete benchmark with 1000 entities (default)
bun run test/benchmarks/run-partition-benchmark.ts

# Run with larger dataset for more accurate results
bun run test/benchmarks/run-partition-benchmark.ts --entities 5000
```

### Single Strategy Testing

```bash
# Test only LIST partitioning
bun run test/benchmarks/run-partition-benchmark.ts --strategy list

# Test only LIST with direct partition access
bun run test/benchmarks/run-partition-benchmark.ts --strategy list-direct

# Test only HASH partitioning (baseline)
bun run test/benchmarks/run-partition-benchmark.ts --strategy hash
```

### Save Results to File

```bash
# Save detailed JSON results
bun run test/benchmarks/run-partition-benchmark.ts --output results/benchmark-results.json
```

### Run Individual Tests

```bash
# Run specific test scenarios (using Bun test runner)
bun test test/benchmarks/partition-strategy.test.ts
```

### Command Chaining Examples

```bash
# Run tests and generate coverage report
bun test test/benchmarks/partition-strategy.test.ts; bun run coverage

# Set environment and run test (semicolon ensures both commands run)
BUNSANE_PARTITION_STRATEGY=list; BUNSANE_USE_DIRECT_PARTITION=true; bun test test/benchmarks/partition-strategy.test.ts

# Sequential execution (run commands one after another)
npm run build; bun test test/benchmarks/partition-strategy.test.ts
```

## Expected Results

Based on our analysis, you should expect these performance characteristics:

### Performance Hierarchy (Fastest to Slowest)

1. **LIST+Direct** - Best performance for single-component queries
2. **LIST** - Good performance with PostgreSQL partition pruning
3. **HASH** - Baseline performance (current implementation)

### Expected Improvements

- **Single Component Filter**: LIST+Direct should be 2-3x faster than HASH
- **Multi Component AND**: LIST+Direct should be 1.5-2x faster than HASH
- **OR Queries**: LIST+Direct should be 1.5-2x faster than HASH
- **Sort Queries**: LIST+Direct should be 2-3x faster than HASH

### Sample Output

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Partition Strategy Benchmark Results                                              │
├────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────┤
│ Query Type         │ Strategy │ Direct   │ Planning │ Execution│ Total    │ Rows  │
├────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────┤
│ Single Filter      │ list     │ YES      │ 0.1      │ 1.2      │ 1.3      │ 234   │
│ Single Filter      │ list     │ NO       │ 0.2      │ 2.1      │ 2.3      │ 234   │
│ Single Filter      │ hash     │ NO       │ 0.3      │ 4.5      │ 4.8      │ 234   │
│ Multi AND          │ list     │ YES      │ 0.2      │ 2.1      │ 2.3      │ 156   │
│ Multi AND          │ list     │ NO       │ 0.3      │ 3.2      │ 3.5      │ 156   │
│ Multi AND          │ hash     │ NO       │ 0.4      │ 6.1      │ 6.5      │ 156   │
└────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────┘

🎯 BENCHMARK SUMMARY
================================================================================

🏆 Overall Winner: list+Direct
📊 Average Query Time: 2.8ms
🔢 Total Queries Run: 21

📈 Per-Query Performance:
------------------------------------------------------------
Single Component Filter      | list+Direct |  62.5% faster
Multi Component AND          | list+Direct |  61.5% faster
OR Query                      | list+Direct |  55.3% faster
Sort Query                    | list+Direct |  64.2% faster
Populate Single Type          | list+Direct |  58.7% faster
Populate Multi Type           | list        |  23.1% faster
Count Query                   | list+Direct |  59.8% faster
```

## Implementation Details

### Environment Variables

- `BUNSANE_PARTITION_STRATEGY`: `'list'` or `'hash'`
- `BUNSANE_USE_DIRECT_PARTITION`: `'true'` or `'false'`

### Test Data

The benchmark generates realistic test data:
- 10-5000 entities (configurable)
- 20 component types with varied properties
- Realistic data distributions (80% users, 60% orders, etc.)

### Database Setup

Each strategy test:
1. Sets environment variables
2. Reinitializes database schema
3. Generates fresh test data
4. Runs all benchmark scenarios
5. Cleans up for next strategy

## Troubleshooting

### Common Issues

1. **Slow Performance**: Ensure PostgreSQL has enough memory for query planning
2. **Out of Memory**: Reduce `--entities` count for large datasets
3. **Connection Errors**: Check database connection settings
4. **Missing Components**: Ensure ComponentRegistry is properly initialized

### Debug Mode

```bash
# Enable debug logging
DEBUG=true bun run test/benchmarks/run-partition-benchmark.ts
```

### Performance Tips

- Run benchmarks on a dedicated database instance
- Ensure sufficient RAM (4GB+ recommended)
- Use SSD storage for best results
- Run multiple times and average results

## Results Interpretation

### Key Metrics

- **Planning Time**: How long PostgreSQL takes to plan the query
- **Execution Time**: How long the query actually runs
- **Buffer Hit Ratio**: Percentage of data read from memory vs disk
- **Rows Returned**: Number of entities returned (should be consistent)

### What to Look For

1. **LIST+Direct should consistently outperform HASH**
2. **Planning time should be similar across strategies**
3. **Buffer hit ratio should be high (90%+)**
4. **Results should be reproducible across runs**

### Benchmark Validation

- All strategies should return the same row counts
- Buffer hit ratios should be >80%
- No queries should fail
- Planning time should be <1ms for simple queries

## Default Configuration

**LIST+Direct is now the default partitioning strategy** based on benchmark results:

| Query Type | HASH | LIST+Direct | Winner |
|------------|------|-------------|--------|
| Single Component Filter | 3.0ms | 2.8ms | ✅ LIST+Direct |
| Multi Component AND | 4.2ms | 3.6ms | ✅ LIST+Direct |
| OR Query | 6.1ms | 1.3ms | ✅ LIST+Direct (5x faster) |
| Sort Query | 10.8ms | 2.4ms | ✅ LIST+Direct (4x faster) |
| Populate Single | 4.0ms | 2.6ms | ✅ LIST+Direct |
| Populate Multi | 3.5ms | 3.8ms | HASH (marginal) |
| Count Query | 1.6ms | 3.0ms | HASH |

### Changing Strategy (if needed)

To use HASH partitioning instead:
```bash
export BUNSANE_PARTITION_STRATEGY=hash
export BUNSANE_USE_DIRECT_PARTITION=false
```

## Next Steps

After running benchmarks:

1. **Verify Results**: Run `bun run test/benchmarks/run-partition-benchmark.ts` to confirm
2. **Monitor Performance**: Track query performance in production
3. **Database Migration**: If switching from HASH to LIST, the framework will automatically recreate tables

## Architecture Impact

This benchmark validates the hybrid approach:

- **Direct partition access** for single-type queries (fastest)
- **Parent table queries** for complex multi-type operations (reliable)
- **PostgreSQL partition pruning** as automatic optimization (smart)

The implementation maintains backward compatibility while providing significant performance improvements for common query patterns.
