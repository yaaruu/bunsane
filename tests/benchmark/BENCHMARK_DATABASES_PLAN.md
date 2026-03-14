# PGlite Persistent Benchmark Databases Plan

## Overview

Create pre-populated PGlite databases at various scale tiers for consistent, reproducible query benchmarks without re-seeding overhead.

## Database Tiers

| Tier | Entities | Products | Orders | Users | Reviews | Est. Size |
|------|----------|----------|--------|-------|---------|-----------|
| xs   | 10,000   | 5,000    | 3,000  | 1,000 | 1,000   | ~50 MB    |
| sm   | 50,000   | 25,000   | 15,000 | 5,000 | 5,000   | ~250 MB   |
| md   | 100,000  | 50,000   | 30,000 | 10,000| 10,000  | ~500 MB   |
| lg   | 500,000  | 250,000  | 150,000| 50,000| 50,000  | ~2.5 GB   |
| xl   | 1,000,000| 500,000  | 300,000| 100,000| 100,000| ~5 GB     |

## Directory Structure

```
tests/benchmark/
├── BENCHMARK_DATABASES_PLAN.md   # This plan
├── databases/                     # Persistent PGlite databases (gitignored)
│   ├── bench-xs/                 # 10k entities
│   ├── bench-sm/                 # 50k entities
│   ├── bench-md/                 # 100k entities
│   ├── bench-lg/                 # 500k entities
│   └── bench-xl/                 # 1M entities
├── fixtures/
│   └── BenchmarkComponents.ts    # Reusable components for benchmarks
├── generators/
│   ├── index.ts                  # Main generator entry point
│   ├── DataGenerator.ts          # Realistic data generation utilities
│   ├── EntitySeeder.ts           # Batch entity creation with relations
│   └── ProgressReporter.ts       # CLI progress reporting
├── runners/
│   ├── QueryBenchmark.ts         # Query benchmark runner
│   └── RelationBenchmark.ts      # BelongsTo/HasMany benchmark
└── generate-databases.ts          # CLI script to generate all tiers
```

## Data Model (E-commerce Scenario)

### Components (from RealisticComponents.ts)

1. **Product** - Core product data (name, SKU, category, status, rating)
2. **Inventory** - Stock tracking (quantity, warehouse, stock status)
3. **Pricing** - Price info (base, sale, cost, discount, currency)
4. **Vendor** - Supplier info (name, region, rating, tier)
5. **ProductMetrics** - Analytics (views, purchases, conversion)

### Additional Components for Relations

6. **User** - Customer data (name, email, tier, region)
7. **Order** - Order data (userId, status, total, itemCount)
8. **OrderItem** - Line items (orderId, productId, quantity, price)
9. **Review** - Product reviews (userId, productId, rating, text)
10. **Wishlist** - User wishlists (userId, productIds[])

### Relation Structure

```
User (1) ──HasMany──> Order (N)
User (1) ──HasMany──> Review (N)
User (1) ──HasMany──> Wishlist (1)

Order (1) ──HasMany──> OrderItem (N)
Order (N) ──BelongsTo──> User (1)

OrderItem (N) ──BelongsTo──> Order (1)
OrderItem (N) ──BelongsTo──> Product (1)

Review (N) ──BelongsTo──> User (1)
Review (N) ──BelongsTo──> Product (1)

Product (1) ──HasMany──> Review (N)
Product (1) ──HasMany──> OrderItem (N)
Product (N) ──BelongsTo──> Vendor (1)
```

## Implementation Steps

### Phase 1: Infrastructure Setup

1. **Create directory structure**
   - Create `tests/benchmark/` directories
   - Add `databases/` to `.gitignore`

2. **Create BenchmarkComponents.ts**
   - Define User, Order, OrderItem, Review, Wishlist components
   - Define BenchmarkArchetypes with proper relations

3. **Create DataGenerator.ts**
   - Faker-like utilities for realistic data (names, emails, addresses)
   - Deterministic seeding with configurable seed for reproducibility
   - Batch generation for memory efficiency

### Phase 2: Seeding System

4. **Create EntitySeeder.ts**
   ```typescript
   interface SeederConfig {
     tier: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
     seed?: number;           // For reproducibility
     batchSize?: number;      // Default 1000
     showProgress?: boolean;  // CLI progress bar
   }

   class EntitySeeder {
     async seedProducts(count: number): Promise<string[]>;
     async seedUsers(count: number): Promise<string[]>;
     async seedOrders(userIds: string[], productIds: string[]): Promise<void>;
     async seedReviews(userIds: string[], productIds: string[]): Promise<void>;
     async createIndexes(): Promise<void>;
     async vacuum(): Promise<void>;
   }
   ```

5. **Create ProgressReporter.ts**
   - CLI progress bars for long-running operations
   - ETA calculation
   - Memory usage monitoring

### Phase 3: Generator Script

6. **Create generate-databases.ts**
   ```bash
   # Generate all tiers
   bun tests/benchmark/generate-databases.ts --all

   # Generate specific tier
   bun tests/benchmark/generate-databases.ts --tier=md

   # Regenerate (delete existing + recreate)
   bun tests/benchmark/generate-databases.ts --tier=sm --force

   # Custom seed for reproducibility
   bun tests/benchmark/generate-databases.ts --tier=xs --seed=42
   ```

7. **Generation Process**
   ```
   For each tier:
   1. Check if database directory exists (skip if exists, unless --force)
   2. Create PGlite with dataDir
   3. Run database migrations (PrepareDatabase)
   4. Register components
   5. Seed entities in batches with progress
   6. Create relation foreign keys
   7. Create indexes (CreateRelationIndexes)
   8. Run VACUUM ANALYZE
   9. Report final stats (entity count, db size, time taken)
   ```

### Phase 4: Benchmark Runner

8. **Create benchmark loading utility**
   ```typescript
   // tests/benchmark/runners/loadBenchmarkDb.ts
   export async function loadBenchmarkDatabase(
     tier: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
   ): Promise<{ pg: PGlite; server: PGLiteSocketServer; cleanup: () => Promise<void> }>;
   ```

9. **Create QueryBenchmark.ts**
   ```typescript
   interface BenchmarkResult {
     name: string;
     tier: string;
     entityCount: number;
     queryTimeMs: number;
     rowsReturned: number;
     memoryUsedMB: number;
   }

   // Benchmark scenarios
   - Simple filter (single component, indexed field)
   - Multi-component filter (2-3 components with AND)
   - Complex query (multi-component + sort + limit)
   - BelongsTo resolution (N users with their orders)
   - HasMany resolution (N products with their reviews)
   - Deep nesting (Order -> User -> Reviews -> Products)
   ```

### Phase 5: npm Scripts

10. **Add to package.json**
    ```json
    {
      "scripts": {
        "bench:generate": "bun tests/benchmark/generate-databases.ts --all",
        "bench:generate:xs": "bun tests/benchmark/generate-databases.ts --tier=xs",
        "bench:generate:sm": "bun tests/benchmark/generate-databases.ts --tier=sm",
        "bench:generate:md": "bun tests/benchmark/generate-databases.ts --tier=md",
        "bench:generate:lg": "bun tests/benchmark/generate-databases.ts --tier=lg",
        "bench:generate:xl": "bun tests/benchmark/generate-databases.ts --tier=xl",
        "bench:query": "bun tests/benchmark/runners/QueryBenchmark.ts",
        "bench:relations": "bun tests/benchmark/runners/RelationBenchmark.ts"
      }
    }
    ```

## Data Generation Details

### Realistic Distribution

```typescript
// Product categories follow power-law distribution
// ~40% in top 3 categories, ~60% in remaining 7
const categoryWeights = {
  'Electronics': 0.20,
  'Clothing': 0.12,
  'Home & Garden': 0.08,
  // ... rest evenly distributed
};

// Order counts per user follow exponential distribution
// Most users: 1-5 orders, some power users: 50+ orders
function getOrderCountForUser(): number {
  const r = Math.random();
  if (r < 0.7) return randomInt(1, 5);
  if (r < 0.9) return randomInt(6, 20);
  return randomInt(21, 100);
}

// Reviews are skewed toward extreme ratings (1, 4, 5 stars)
function getReviewRating(): number {
  const r = Math.random();
  if (r < 0.05) return 1;      // 5% - 1 star
  if (r < 0.10) return 2;      // 5% - 2 stars
  if (r < 0.20) return 3;      // 10% - 3 stars
  if (r < 0.50) return 4;      // 30% - 4 stars
  return 5;                     // 50% - 5 stars
}
```

### Batch Insertion Strategy

```typescript
// Avoid memory issues with large datasets
const BATCH_SIZE = 1000;

async function seedInBatches<T>(
  total: number,
  generator: (batchIndex: number, batchSize: number) => Promise<T[]>,
  inserter: (items: T[]) => Promise<void>
) {
  const batches = Math.ceil(total / BATCH_SIZE);
  for (let i = 0; i < batches; i++) {
    const items = await generator(i, Math.min(BATCH_SIZE, total - i * BATCH_SIZE));
    await inserter(items);
    // Allow GC between batches
    if (i % 10 === 0) await Bun.sleep(1);
  }
}
```

## Benchmark Scenarios

### Query Performance Matrix

| Scenario | Description | Expected Behavior |
|----------|-------------|-------------------|
| Q1 | Filter by indexed field | O(log n), <50ms at 1M |
| Q2 | Filter by non-indexed field | O(n), slower |
| Q3 | Multi-component AND | Uses INTERSECT optimization |
| Q4 | Multi-component + Sort | Uses scalar subquery sort |
| Q5 | BelongsTo single | DataLoader batched |
| Q6 | HasMany collection | Single filtered query |
| Q7 | Nested relations 3-deep | DataLoader + batching |
| Q8 | Pagination (offset) | Cursor recommended at scale |
| Q9 | Count aggregation | Fast with proper indexes |
| Q10 | Full table scan | Baseline comparison |

### Expected Performance Targets

| Tier | Q1 (indexed) | Q3 (multi) | Q5 (BelongsTo) | Q7 (nested) |
|------|--------------|------------|----------------|-------------|
| xs   | <10ms        | <20ms      | <30ms          | <50ms       |
| sm   | <15ms        | <40ms      | <50ms          | <100ms      |
| md   | <20ms        | <60ms      | <80ms          | <150ms      |
| lg   | <30ms        | <100ms     | <150ms         | <300ms      |
| xl   | <50ms        | <150ms     | <250ms         | <500ms      |

## Files to Create

1. `tests/benchmark/fixtures/BenchmarkComponents.ts`
2. `tests/benchmark/fixtures/BenchmarkArchetypes.ts`
3. `tests/benchmark/generators/DataGenerator.ts`
4. `tests/benchmark/generators/EntitySeeder.ts`
5. `tests/benchmark/generators/ProgressReporter.ts`
6. `tests/benchmark/generators/index.ts`
7. `tests/benchmark/generate-databases.ts`
8. `tests/benchmark/runners/loadBenchmarkDb.ts`
9. `tests/benchmark/runners/QueryBenchmark.ts`
10. `tests/benchmark/runners/RelationBenchmark.ts`

## Gitignore Addition

```gitignore
# Benchmark databases (large, generated locally)
tests/benchmark/databases/
```

## Usage Example

```bash
# First time: Generate benchmark databases
bun run bench:generate:xs   # Quick: ~30s
bun run bench:generate:md   # Medium: ~5min
bun run bench:generate:xl   # Large: ~30min

# Run benchmarks (uses pre-generated databases)
bun run bench:query --tier=md
bun run bench:relations --tier=lg

# Results output
# ┌─────────────────────────────────────────────────────────┐
# │ Query Benchmark Results - Tier: md (100,000 entities)  │
# ├──────────────────────┬─────────┬──────────┬────────────┤
# │ Scenario             │ Time    │ Rows     │ Memory     │
# ├──────────────────────┼─────────┼──────────┼────────────┤
# │ Q1: Indexed filter   │ 18ms    │ 1,234    │ 2.3 MB     │
# │ Q3: Multi-component  │ 52ms    │ 456      │ 4.1 MB     │
# │ Q5: BelongsTo batch  │ 71ms    │ 100      │ 5.8 MB     │
# │ Q7: Nested 3-deep    │ 142ms   │ 50       │ 12.4 MB    │
# └──────────────────────┴─────────┴──────────┴────────────┘
```

## Next Steps

1. Review and approve this plan
2. Create the directory structure
3. Implement Phase 1-2 (components + seeder)
4. Implement Phase 3 (generator script)
5. Generate xs/sm tiers for initial testing
6. Implement Phase 4 (benchmark runners)
7. Generate remaining tiers
8. Document results and establish baselines
