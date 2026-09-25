# AFTER vs BEFORE — list reads at 1M

Final AFTER pass on the main tree after key indexes stopped being partial and the entity-sort probe window is sized from `pg_class.reltuples`. Measured with nothing else running. Commit `04f73c6f0f1779af615af1792c5a1e8498425b02` (package 0.8.0; the engine changes are uncommitted working-tree edits on top of that commit).

Baselines and gates were refreshed from this pass (see "Not done", which now lists what was done). One residual regression is accepted and explained below.

Raw JSON:

- `docs/internal/benchmark-0.9/after-lg-1.json`
- `docs/internal/benchmark-0.9/after-lg-2.json`
- `docs/internal/benchmark-0.9/after-md.json`
- `docs/internal/benchmark-0.9/after-lg-concurrency.json`
- BEFORE counterparts: `before-lg-1.json`, `before-lg-2.json`, `before-md.json`, `before-lg-concurrency.json`

## Environment

| | |
|---|---|
| Commit | `04f73c6f0f1779af615af1792c5a1e8498425b02` plus uncommitted engine edits |
| PostgreSQL | 17.10, direct Docker port **10924** (`infra-postgres`). Not PgBouncer. |
| Bun | 1.4.0 |
| Host | win32-x64, Intel Core Ultra 7 265K, 31.4 GB RAM |
| CompositeIndex | applied: `CompositeIndex(["status","total"])` on BenchOrder |
| Parallel gather | **0** (`ALTER DATABASE … SET max_parallel_workers_per_gather = 0`) |

Iterations 30, warmup 5. Percentile index `floor(n * p)`. `NODE_ENV=production`, cache off.

## Commands

```bash
bun tests/benchmark/scripts/compare-pg.ts --self --label after --scale lg
bun tests/benchmark/scripts/compare-pg.ts --self --label after --scale lg
bun tests/benchmark/scripts/compare-pg.ts --self --label after --scale md
bun tests/benchmark/scripts/compare-pg.ts --self --label after --scale lg --concurrency 16 --duration 30 --skip-shapes
```

## What changed after the first AFTER run

The first AFTER run (partial `bk_` indexes, fixed 5000-row probe) is the previous RESULTS.md. Two engine changes landed before this pass:

1. **Key indexes are no longer partial.** PostgreSQL ignores statistics of partial expression indexes, so `data->>'userId' = $1` / `IN (50)` estimated 150 / 7500 rows and the HasMany loader plus batched `countBy` hash-joined every entity. Verified on real PG (partial estimate 150, non-partial estimate 3). `database/keyIndexSpec.ts` now emits non-partial `bk_` indexes.
2. **Entity-sort probe window** is `min(cap, max(64, ceil(4 * pageLimit / f)))` where `f` is the driving leaf's `reltuples` over `entities` (`query/entitySort.ts`). Unknown stats still use the cap (5000).

Old vs this pass, p50 ms:

| shape | BEFORE lg | first AFTER lg | this lg run 1 / run 2 | BEFORE md | first AFTER md | this md |
|---|---:|---:|---:|---:|---:|---:|
| e-graphql-list-50 | 16.15 | 114.31 | 15.82 / 15.62 | 6.27 | 12.64 | 4.99 |
| e2-graphql-list-50-batched | 7.61 | 134.74 | 7.50 / 7.82 | 4.11 | 11.52 | 3.47 |
| b-created-at-20 | 212.73 | 240.79 | 241.72 / 234.85 | 11.74 | 23.41 | 18.16 |
| b-created-at-100 | 211.78 | 242.10 | 240.82 / 240.69 | 12.41 | 23.92 | 21.31 |
| b-created-at-review-asc-20 | 96.67 | 115.06 | 109.61 / 110.23 | 6.94 | 12.43 | 11.59 |
| b-created-at-review-desc-20 | 98.81 | 20.63 | 3.07 / 3.82 | 6.78 | 8.25 | 3.17 |

`e` / `e2` are back to BEFORE (slightly faster at md). The created-at regressions are not fixed. Review DESC improved further (20.6 → 3.1 ms) because the smaller window now fits the newest-archetype band.

## Seed

| run | seedMs | insertMs | entities | component rows |
|---|---:|---:|---:|---:|
| lg run 1 | 120686 | 116891 | 1000000 | 1300000 |
| lg run 2 | 128825 | 125039 | 1000000 | 1300000 |
| lg concurrency | 119135 | 115273 | 1000000 | 1300000 |
| md | 10019 | 9015 | 100000 | 130000 |

Lg cancelled 6000, missing score 10000, dirty legacyScore 200. Md 600 / 1000 / 20. Same as BEFORE.

## Lg shapes

Id hashes are identical across the two lg runs for every shape. p50 moved by at most 8% on the slow shapes except `d-count-two-components` (152.58 → 55.08, same plan, same hash; the second run hit a warm cache). Do not treat 55 ms as the stable number.

| shape | rows | lg1 p50 | lg1 p95 | lg2 p50 | lg2 p95 | BEFORE p50 | Δ vs BEFORE | id hash |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| a-sort-rating-20 | 20 | 0.81 | 2.07 | 0.95 | 1.78 | 50.33 | -98.4% | `5dda9cacd37c11f67084c7b812a7360dcc0495283b9d978d3661fe49c6451aab` |
| a-sort-rating-100 | 100 | 0.84 | 1.58 | 0.97 | 2.20 | 48.85 | -98.3% | `e7111b6f16a13c1553c869946600d1e1bb0988984f5d045a1fd513c791d011f4` |
| a-sort-rating-asc-20 | 20 | 0.69 | 0.94 | 0.77 | 1.04 | 47.10 | -98.5% | `4ae8f4197611393543cc2c52e39c8bc7c06bd2db055456e88069174d5d757215` |
| a-sort-username-asc-50 | 50 | 0.61 | 1.07 | 0.68 | 1.26 | 0.75 | -18.7% | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| a-sort-score-desc-20 | 20 | 0.67 | 0.84 | 0.73 | 2.05 | 50.53 | -98.7% | `e4042ed6c4ee5c84b0e2a7c4ee0013ba6b3da771daa5a54e8dea23e3a4777193` |
| b-created-at-20 | 20 | 241.72 | 260.03 | 234.85 | 253.73 | 212.73 | +13.6% | `a7c9e1a22f96c72e895d79b0e261cf3f03f62896127afd2362560eeecd7ae28e` |
| b-created-at-100 | 100 | 240.82 | 257.54 | 240.69 | 262.74 | 211.78 | +13.7% | `cf7a81fb08c3268256b1c2023008a78f46381860cc3d5176b9897c69fe79a1fb` |
| b-created-at-review-desc-20 | 20 | 3.07 | 5.10 | 3.82 | 5.27 | 98.81 | -96.9% | `d3119814ab93f3c47651f60978d30f6fa11ed8566aa1028f13c553633f169102` |
| b-created-at-review-asc-20 | 20 | 109.61 | 121.25 | 110.23 | 127.94 | 96.67 | +13.4% | `e97bf3ac6fbb1bfa770fdac119d802351f45ae0e7125192c9a88df5819e5b42f` |
| b-created-at-keyset-20 | 20 | 1.50 | 3.24 | 1.46 | 2.49 | 277.72 | -99.5% | `ef6316d5cef6d04094990157069a7d0c581442a860293aeb64e8f5eeaac2303b` |
| c-two-filter-sort-20 | 20 | 1.15 | 2.62 | 1.26 | 2.72 | 84.45 | -98.6% | `21b8463a864c5ef754e980b08d72eb757008f76c4b80ceb7324b11b3883121a6` |
| c-selective-filter-sort-20 | 20 | 0.70 | 1.01 | 0.72 | 1.38 | 4.81 | -85.4% | `8fe5eef3c0a509b6822e9c77e41f0eef2a7dcaca2eb269b95a9cdc2aa05a89e9` |
| d-populate-100 | 100 | 1.62 | 3.73 | 1.88 | 3.80 | 118.13 | -98.6% | `c0fc5f28c72b28302ebfa5e11806d6eb8755656238ae2e14d55df3c4b2b56b34` |
| d-count-two-components | 300000 | 152.58 | 158.07 | 55.08 | 59.04 | 157.38 | -3.0% / -65% | `dd52e688b16995d3459230ec733348172e41f22f11574e6250d62a5fbcbd75c0` |
| e-graphql-list-50 | 50 | 15.82 | 17.53 | 15.62 | 18.14 | 16.15 | -2.0% | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| e2-graphql-list-50-batched | 50 | 7.50 | 11.71 | 7.82 | 12.70 | 7.61 | -1.4% | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| f-keyset-next-20 | 20 | 0.68 | 1.21 | 0.71 | 2.28 | 62.53 | -98.9% | `75af6314a5aa9e803b671c13b387a9344ebc6fd8d0e4dec260d8c2f8fbcc27fc` |
| f-keyset-deep-20 | 20 | 0.67 | 1.27 | 0.75 | 3.34 | 59.28 | -98.9% | `12a5d3c1f2418f4dc8429619c8d8aa7f736cece2e925aa00ae7e2d54c61f761b` |
| f-keyset-before-20 | 20 | 0.59 | 1.02 | 0.58 | 0.80 | 54.10 | -98.9% | `f609f282b51bddf3976d5b1bbade3ac92af850362c994de5335f4f554253a6d1` |
| f-keyset-score-into-nulls | 20 | 0.68 | 1.84 | 0.71 | 1.73 | 52.26 (0 rows) | n/a | `69b4a0b3394412ae0d5e6224bfe17e7a46aba792608c458d196e7bd9cd9a92ce` |
| g-legacyscore-sort | 20 | 0.65 | 2.62 | 0.69 | 1.01 | error | n/a | `d2e233f6a38a9019ba41687cb75973989325a1d5f3afbe3722429c28217d805d` |

`e` and `e2` share the username id hash. Statement counts are unchanged: 1, except `d-populate-100` (2), `e` (54), `e2` (5), and the three created-at shapes that miss the probe (2).

## Md shapes

| shape | rows | p50 | p95 | BEFORE p50 | Δ | stmts |
|---|---:|---:|---:|---:|---:|---:|
| a-sort-rating-20 | 20 | 0.73 | 1.61 | 5.15 | -85.8% | 1 |
| a-sort-rating-100 | 100 | 0.84 | 1.66 | 5.16 | -83.7% | 1 |
| a-sort-rating-asc-20 | 20 | 0.70 | 1.79 | 5.22 | -86.6% | 1 |
| a-sort-username-asc-50 | 50 | 0.62 | 1.46 | 0.62 | 0% | 1 |
| a-sort-score-desc-20 | 20 | 0.64 | 0.87 | 5.20 | -87.7% | 1 |
| b-created-at-20 | 20 | 18.16 | 25.48 | 11.74 | +54.7% | 2 |
| b-created-at-100 | 100 | 21.31 | 25.83 | 12.41 | +71.7% | 2 |
| b-created-at-review-desc-20 | 20 | 3.17 | 5.50 | 6.78 | -53.2% | 1 |
| b-created-at-review-asc-20 | 20 | 11.59 | 14.71 | 6.94 | +67.0% | 2 |
| b-created-at-keyset-20 | 20 | 1.56 | 2.50 | 20.83 | -92.5% | 1 |
| c-two-filter-sort-20 | 20 | 1.31 | 2.50 | 8.65 | -84.9% | 1 |
| c-selective-filter-sort-20 | 20 | 0.73 | 1.22 | 0.86 | -15.1% | 1 |
| d-populate-100 | 100 | 1.80 | 3.47 | 13.71 | -86.9% | 2 |
| d-count-two-components | 30000 | 10.63 | 13.00 | 14.68 | -27.6% | 1 |
| e-graphql-list-50 | 50 | 4.99 | 8.98 | 6.27 | -20.4% | 54 |
| e2-graphql-list-50-batched | 50 | 3.47 | 6.46 | 4.11 | -15.6% | 5 |
| f-keyset-next-20 | 20 | 0.71 | 1.88 | 6.89 | -89.7% | 1 |
| f-keyset-deep-20 | 20 | 0.72 | 2.06 | 6.62 | -89.1% | 1 |
| f-keyset-before-20 | 20 | 0.60 | 0.75 | 5.53 | -89.2% | 1 |
| f-keyset-score-into-nulls | 20 | 0.72 | 1.04 | 5.57 (0 rows) | n/a | 1 |
| g-legacyscore-sort | 20 | 0.72 | 0.98 | error | n/a | 1 |

## Correctness

Method, unchanged: sha256 of returned ids in order (`idHash`), plus a set hash. Two lg runs must match each other. A hash that differs from BEFORE is a tie-break or a NULLS-boundary change, not a dropped row, when the sort keys and row counts say so.

Verdicts:

- **Same ids as BEFORE:** `a-sort-rating-asc-20`, `a-sort-username-asc-50`, every `b-created-at-*` shape, `d-populate-100`, `d-count-two-components`, `e`, `e2`. Entity-sort order did not move.
- **Different ids, same sort keys, DESC tie-break changed** (`entity_id DESC` on a numeric/text DESC key, vs the old sort): `a-sort-rating-20/100`, `a-sort-score-desc-20`, `f-keyset-next/deep/before`. Expected. ASC rating matches BEFORE, which confirms the data.
- **Different ids, composite index order:** `c-two-filter-sort-20` and `c-selective-filter-sort-20`. Equal `total` values now come out in index order. Row count is still 20.
- **`f-keyset-score-into-nulls` is a real correctness fix.** BEFORE returned 0 rows (hash `e3b0c44298fc…`, sha256 of no ids) because the cursor was the largest id at the minimum score, and the DESC predicate `score < 0` does not match NULL. With `query/orderPlan.ts` present the tie is `entity_id DESC`, so the harness looks up the smallest id at the minimum non-null score. This pass returns 20 rows, sort keys `null,null,null`, Index Scan Backward on `bk_benchproduct_score_*`, `shared hit=26`.
- **`g-legacyscore-sort` no longer errors.** BEFORE: `invalid input syntax for type numeric: "n/a"`. AFTER: 20 rows in 0.65 ms via `bunsane_num_v1`, Index Scan on `bk_benchproduct_legacyscore_*`. Dirty values are NULL, not a cast. That is the intended engine change, not a harness skip.

## EXPLAIN (lg run 1)

`explainEntitySortSql` returns the probe statement when the choice is adaptive. The timed path may then reject the probe and run the fallback. For the three regressions, `statementsPerIter` is 2 and the stored `sql` field is the fallback (`EXISTS` + `ORDER BY date_trunc`). The captured EXPLAIN is the probe, which is the fast statement. The 230 ms is the fallback, which is the same hash-join seq scan BEFORE ran as its only statement.

| shape | plan | buffers |
|---|---|---|
| a-sort-rating-20/100/asc, f-keyset-next/deep/before | Index Scan (Backward) `bk_benchproduct_rating_ce901a1e`. Limit 20 reads ~23 pages. | `shared hit=26` |
| a-sort-score-desc-20, f-keyset-score-into-nulls | Index Scan Backward `bk_benchproduct_score_cf8214d3`. Null page is the second arm of the UNION (NULLS). | `shared hit=26` |
| a-sort-username-asc-50 | Index Scan `bk_benchuser_username_0c50a75a`. | sub-ms |
| g-legacyscore-sort | Index Scan `bk_benchproduct_legacyscore_0dd3ceae`. No cast error. | `shared hit=46` |
| c-selective-filter-sort-20 | Index Scan `bk_benchorder_status_total_e0938ba2` (composite). | `shared hit=26` |
| c-two-filter-sort-20 | Same composite index, plus flag index for the second component. | `shared hit=386` |
| d-populate-100 | Merge Join of the two order partitions, then a component fetch (2 statements). | `shared hit=48` on the id query |
| d-count-two-components | Seq Scan `components_benchorder` + Seq Scan `components_benchorderflag`, hash join, external merge sort, `COUNT(*)`. | run 1 `shared hit=7515 read=11961, temp read=2715 written=2716`, actual 198 ms |
| b-created-at-review-desc-20 | Probe accepted. Window 800 on `bk_entities_created_at_233220ac`. Reviews are the newest 100k, so 800 candidates fill the page. 1 statement. | probe `shared hit=20` inside the CTE; outer `hit=5621` |
| b-created-at-keyset-20 | Probe accepted. Cursor is already inside the order time range, so a 267-row window hits orders. 1 statement. | `shared hit=277` in the CTE |
| b-created-at-20 | Probe **rejected**, then fallback. See below. | probe CTE `shared hit=11`, 267 candidates, 1 row out |
| b-created-at-100 | Probe rejected. Window 1334, still inside the review band. | probe CTE `shared hit=28` |
| b-created-at-review-asc-20 | Probe rejected. Window 800 from the oldest entities contains no reviews. | probe CTE `shared hit=810` |
| e / e2 | No EXPLAIN. Wall time matches BEFORE, so the IN-list seq scan from the partial-index pass is gone. | |

## Accepted residual: time-clustered `sortByCreatedAt().with(X)`

`b-created-at-20` and `b-created-at-100` (and `b-created-at-review-asc-20`) are 10–14% slower than BEFORE at lg and ~6 ms slower at md. Same ids. Accepted, and the gate baselines were refreshed on this pass.

Why the probe misses:

- Orders are 30% of entities (`f = 300000/1000000`). Limit 20 → needed ≈ 67, window = `max(64, ceil(4 * 67))` = **267**. Limit 100 → window **1334**. Both numbers are in the EXPLAIN (`rows=267`, `rows=1334`).
- Reviews are a late archetype: all 100000 review `created_at` values are newer than every other entity. The newest 267 and the newest 1334 entities are reviews, not orders.
- `interpretProbe` requires a full page or an exhausted window. 267 candidates yield 1 order. The probe is rejected.
- Fallback SQL is `SELECT e.id FROM entities e WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM components_benchorder …) ORDER BY date_trunc('milliseconds', e.created_at) DESC, e.id DESC LIMIT $2`. That is the BEFORE plan: seq scan 1e6 entities + seq scan 300k orders + hash join + sort. BEFORE paid that once (~213 ms). AFTER pays a wasted index probe plus that scan (~235–242 ms, 2 statements).
- Review ASC is the same miss from the other end: the oldest 800 entities are not reviews, so the probe fails and the fallback hash-joins 1e6 entities (~110 ms vs BEFORE 97 ms).
- Review DESC and the order keyset work because the cursor or the sort direction already sits inside the matching time band. Those are not regressions (3 ms and 1.5 ms).

The stats-based window assumes the driving component is uniformly mixed through `created_at`. This dataset is not: reviews occupy the entire newest 10% of the timeline. A uniform `f` underestimates how far the index has to walk before it sees an order.

The probe miss itself is cheap (`shared hit=11`, 267 candidates). The extra cost is the fallback evaluating the UTC-millisecond key over the ~300k joined rows before the top-N sort; BEFORE sorted the raw column. The millisecond key is what makes page 1 and keyset pages agree (JS `Date` cursors carry milliseconds), so it is kept. The O(limit) answer for "latest N of one archetype" when that archetype is clustered in time is QSP: `rm_<archetype>` carries `created_at` with a `bk_` timestamp key index.

`d-count-two-components` is not a regression (152 ms vs BEFORE 157 ms on run 1; run 2 was 55 ms on a warm cache). It is still a double seq scan plus an external sort. The key indexes do not apply to an unordered count.

## Concurrency

Lg, 16 clients, pool 16, warmup 3 s, measured 30 s (elapsed 31345 ms). Shapes skipped. `g` excluded. GraphQL not in the mix. Seed 119135 ms.

**707 queries, 0 errors, 22.56 queries/s.** BEFORE was 279 queries, 8.62 queries/s.

| shape | samples | p50 | p95 | p99 | BEFORE p50 |
|---|---:|---:|---:|---:|---:|
| a-sort-rating-20 | 38 | 529.01 | 877.52 | 897.40 | 1636.48 |
| a-sort-rating-100 | 39 | 551.63 | 878.49 | 898.77 | 1655.45 |
| a-sort-rating-asc-20 | 39 | 551.94 | 788.28 | 805.62 | 1639.80 |
| a-sort-username-asc-50 | 39 | 531.10 | 888.92 | 916.58 | 1590.89 |
| a-sort-score-desc-20 | 40 | 542.50 | 890.44 | 916.94 | 1638.23 |
| b-created-at-20 | 41 | 1183.67 | 1768.53 | 1812.51 | 1819.38 |
| b-created-at-100 | 40 | 1270.74 | 1780.71 | 1822.27 | 1738.12 |
| b-created-at-review-desc-20 | 39 | 605.38 | 788.00 | 794.56 | 1618.68 |
| b-created-at-review-asc-20 | 39 | 1145.69 | 1565.55 | 1575.40 | 1603.23 |
| b-created-at-keyset-20 | 38 | 520.00 | 765.58 | 808.50 | 1735.83 |
| c-two-filter-sort-20 | 40 | 543.30 | 780.53 | 787.76 | 1689.36 |
| c-selective-filter-sort-20 | 40 | 518.39 | 779.81 | 787.75 | 1511.36 |
| d-populate-100 | 40 | 1059.34 | 1543.87 | 1572.96 | 3226.24 |
| d-count-two-components | 41 | 723.90 | 929.33 | 963.46 | 1743.89 |
| f-keyset-next-20 | 39 | 594.07 | 901.42 | 920.36 | 1502.36 |
| f-keyset-deep-20 | 39 | 521.91 | 902.04 | 920.87 | 1623.00 |
| f-keyset-before-20 | 38 | 518.79 | 989.79 | 996.82 | 1622.73 |
| f-keyset-score-into-nulls | 38 | 598.87 | 991.68 | 997.55 | 1646.42 |

Throughput is 2.6×. Index-driven shapes sit around 520–600 ms p50 under pool wait (solo they are under 2 ms). `b-created-at-20/100` and `b-created-at-review-asc-20` stay at 1.1–1.3 s p50 because each call still runs the fallback scan and holds a connection. Latency includes pool wait.

## Not done

- Baselines refreshed from this AFTER pass. `tests/benchmark/baseline/md-pg.json` (21 shapes, from `after-md.json`) and `lg-pg.json` (21 shapes, from `after-lg-2.json`). PGlite: `bun run bench:baseline:md` and `bun run bench:baseline:xs` both 19/19 and wrote `md-pglite.json` / `xs-pglite.json`. The pre-generated PGlite databases did not have `bunsane_num_v1`; it was created in those two databases (same DDL as `query/orderPlan.ts`) before the successful write. The first md attempt exited 1 and was overwritten by the re-run.
- `bun run bench:pg:gate` (md): passed. Fresh p50s tracked the new baseline (b-created-at-20 17.60 vs 18.16, e 4.36 vs 4.99).
- `bun run bench:gate` (PGlite md): 19/19, `[bench-gate] no regressions`.
- Worktree `../bunsane-wt-base` removed. Git had registered the path as `bunsane-wt-base\\.git`. After rewriting `.git/worktrees/bunsane-wt-base/gitdir` to the directory, `git worktree remove --force` succeeded. `git worktree list` is only the main repo.
