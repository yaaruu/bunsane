/**
 * PGlite Persistent Benchmark Databases
 *
 * Provides pre-generated databases at various tiers for consistent
 * query performance benchmarking.
 *
 * Usage:
 *   # Generate a database tier
 *   bun run bench:generate:xs
 *
 *   # Run benchmarks against a tier
 *   bun run bench:run:xs
 *
 * Database Tiers:
 *   xs:  10k entities  (1k users, 2k products, 3k orders, 3k items, 1k reviews)
 *   sm:  50k entities  (5k users, 10k products, 15k orders, 15k items, 5k reviews)
 *   md: 100k entities (10k users, 20k products, 30k orders, 30k items, 10k reviews)
 *   lg: 500k entities (50k users, 100k products, 150k orders, 150k items, 50k reviews)
 *   xl:   1M entities (100k users, 200k products, 300k orders, 300k items, 100k reviews)
 */
export * from './fixtures';
export * from './runners';
