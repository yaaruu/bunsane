# BEFORE baseline — list reads at 1M (commit 04f73c6)

Measured on the base worktree, not the main working tree. Other agents were editing framework code in the main tree while these numbers were taken.

Worktree: `G:/AA_JSCode/A_FRAMEWORK/bunsane-wt-base` (`../bunsane-wt-base`), detached HEAD `04f73c6f0f1779af615af1792c5a1e8498425b02` (same engine as package 0.8.0). Left in place for AFTER runs. The harness copies `tests/benchmark/scripts/pg-scenario.ts`, `pg-scale.ts`, and `pg-seed.ts` from the main tree into the worktree before each run, so the scenario is the new one and the Query/GraphQL code is 04f73c6.

Raw JSON:

- `docs/internal/benchmark-0.9/before-lg-1.json`
- `docs/internal/benchmark-0.9/before-lg-2.json`
- `docs/internal/benchmark-0.9/before-md.json`
- `docs/internal/benchmark-0.9/before-lg-concurrency.json`

## Environment

| | |
|---|---|
| Commit | `04f73c6f0f1779af615af1792c5a1e8498425b02` |
| Package | 0.8.0 |
| PostgreSQL | 17.10 (Debian 17.10-1.pgdg13+1), direct Docker port **10924** (`infra-postgres`). Not PgBouncer (`:6432` was not used). |
| Bun | 1.4.0 |
| Host | win32-x64, Intel Core Ultra 7 265K, 31.4 GB RAM |
| CompositeIndex | absent on this commit (feature-detect skipped it) |
| Parallel gather | **0** on the scratch database |

Docker Desktop gives this Postgres 64 MB of `/dev/shm`. POSIX DSM resize fails with `could not resize shared memory segment ... No space left on device` even when `df` shows free space. The first lg attempt died in the post-seed check on that error. `compare-pg.ts` now runs `ALTER DATABASE … SET max_parallel_workers_per_gather = 0` on each scratch DB. Plans below have **no Gather / Parallel Seq Scan**. A host with working DSM may pick parallel scans and different timings. Seq scan vs index is still visible.

Iterations 30, warmup 5, except the concurrency run. Percentile index is `floor(n * p)` (same helper as the 0.7 harness). `NODE_ENV=production`, cache off, `BUNSANE_QSP` / `DB_DISABLE_PREPARE` unset.

## Commands

From the main repo, after `git worktree add ../bunsane-wt-base 04f73c6` and `bun install` in the worktree:

```bash
bun tests/benchmark/scripts/compare-pg.ts --only base --scale lg
bun tests/benchmark/scripts/compare-pg.ts --only base --scale lg
bun tests/benchmark/scripts/compare-pg.ts --only base --scale md
bun tests/benchmark/scripts/compare-pg.ts --only base --scale lg --concurrency 16 --duration 30 --skip-shapes
```

`--skip-shapes` is only on the concurrency invocation so it does not repeat the 30-iteration shape loop already measured twice. The package script `bench:pg:concurrency` does not pass `--skip-shapes`.

## Seed

Server-side `INSERT … SELECT generate_series` in 50k chunks. Ids are `md5('bunsane-bench-v1:' || seq)` (core `md5()`, no pgcrypto). Deterministic. Checks passed on every run.

| run | seedMs (boot+insert+analyze) | insertMs | entities | component rows | cancelled | missing score | legacyScore `n/a` |
|---|---:|---:|---:|---:|---:|---:|---:|
| lg run 1 | 136483 | 132651 | 1000000 | 1300000 | 6000 (2%) | 10000 (5%) | 200 (0.1%) |
| lg run 2 | 110017 | 106144 | 1000000 | 1300000 | 6000 | 10000 | 200 |
| md | 10005 | 9045 | 100000 | 130000 | 600 (2%) | 1000 (5%) | 20 (0.1%) |

Lg insert is about 1.8–2.2 minutes, under the 3 minute budget. Analyze was ~1.3 s at lg and 0.65 s at md.

Reviews are strictly newer than every other entity (`reviewMin` = `otherMax` + 1 second; lg `2024-01-14T21:20:00Z` vs `21:19:59Z`). Users and orders overlap in `created_at` (`overlapped: true`).

## Lg shapes (two runs)

Id hashes are identical across the two lg runs for every shape, including the error hash for `g-legacyscore-sort` and the empty-page hash for `f-keyset-score-into-nulls`. Result sets did not move. p50 moved by at most 9.6% on the slow shapes (review DESC 98.81 → 89.37 ms) and 16% on username, which is 0.12 ms absolute (0.75 → 0.63).

Statements per iteration are 1 except `d-populate-100` (2), `e-graphql-list-50` (54), `e2-graphql-list-50-batched` (5), and `g` (0, errored before timing).

| shape | rows | lg1 p50 | lg1 p95 | lg1 p99 | lg2 p50 | lg2 p95 | Δp50% | id hash |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| a-sort-rating-20 | 20 | 50.33 | 56.14 | 56.98 | 46.89 | 52.77 | -6.8 | `5de8f32d155e2e026c2745ae772ef80f4c5e5f553abace106c130eb320828ab6` |
| a-sort-rating-100 | 100 | 48.85 | 54.32 | 56.74 | 47.03 | 52.71 | -3.7 | `088415562fa6b84b51127e826f5468c28cbdc96b9c29d6829ee4d33e983e3958` |
| a-sort-rating-asc-20 | 20 | 47.10 | 56.14 | 60.05 | 48.12 | 51.54 | +2.2 | `4ae8f4197611393543cc2c52e39c8bc7c06bd2db055456e88069174d5d757215` |
| a-sort-username-asc-50 | 50 | 0.75 | 1.52 | 2.11 | 0.63 | 0.91 | -16.0 | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| a-sort-score-desc-20 | 20 | 50.53 | 57.46 | 61.39 | 46.40 | 51.78 | -8.2 | `0de1a43bea164c43521531317d8ac8902affa2066818ea4956d772a8b5cfd519` |
| b-created-at-20 | 20 | 212.73 | 239.54 | 249.18 | 221.06 | 251.17 | +3.9 | `a7c9e1a22f96c72e895d79b0e261cf3f03f62896127afd2362560eeecd7ae28e` |
| b-created-at-100 | 100 | 211.78 | 235.24 | 258.39 | 212.95 | 236.42 | +0.6 | `cf7a81fb08c3268256b1c2023008a78f46381860cc3d5176b9897c69fe79a1fb` |
| b-created-at-review-desc-20 | 20 | 98.81 | 122.46 | 139.74 | 89.37 | 111.32 | -9.6 | `d3119814ab93f3c47651f60978d30f6fa11ed8566aa1028f13c553633f169102` |
| b-created-at-review-asc-20 | 20 | 96.67 | 129.98 | 146.16 | 89.77 | 173.70 | -7.1 | `e97bf3ac6fbb1bfa770fdac119d802351f45ae0e7125192c9a88df5819e5b42f` |
| b-created-at-keyset-20 | 20 | 277.72 | 320.96 | 332.47 | 275.27 | 315.68 | -0.9 | `ef6316d5cef6d04094990157069a7d0c581442a860293aeb64e8f5eeaac2303b` |
| c-two-filter-sort-20 | 20 | 84.45 | 104.20 | 117.43 | 87.14 | 98.91 | +3.2 | `dd92e368062f8b3105d175b8ceb8e47978c6dbeeb4696936a1c12f262bd2a99e` |
| c-selective-filter-sort-20 | 20 | 4.81 | 7.07 | 9.93 | 5.13 | 6.61 | +6.7 | `a4f0ea25a7df6ffb26b433917bb42c7f99b65c67aa4e794ff718ef9ecde17b27` |
| d-populate-100 | 100 | 118.13 | 127.87 | 128.29 | 119.76 | 129.74 | +1.4 | `c0fc5f28c72b28302ebfa5e11806d6eb8755656238ae2e14d55df3c4b2b56b34` |
| d-count-two-components | 300000 | 157.38 | 163.60 | 164.96 | 161.05 | 170.68 | +2.3 | `dd52e688b16995d3459230ec733348172e41f22f11574e6250d62a5fbcbd75c0` |
| e-graphql-list-50 | 50 | 16.15 | 18.53 | 19.65 | 16.21 | 19.83 | +0.4 | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| e2-graphql-list-50-batched | 50 | 7.61 | 11.50 | 11.59 | 7.50 | 9.52 | -1.4 | `c678a11d0328c0272e22fa5fe6157e6fca3dcd3da70ecc4cc0ef193444a74e82` |
| f-keyset-next-20 | 20 | 62.53 | 69.36 | 72.48 | 61.86 | 68.20 | -1.1 | `6ef20c761dbfa9915c9f303d8ed74916714c155ed6793e60109cd4a0f6f0ecc0` |
| f-keyset-deep-20 | 20 | 59.28 | 67.08 | 71.05 | 58.98 | 63.42 | -0.5 | `4e226822bd976bfe09d4110c8dac5ab55649e9d175815bbb59794a4c3a0eb5e4` |
| f-keyset-before-20 | 20 | 54.10 | 59.10 | 60.20 | 49.26 | 53.27 | -8.9 | `156c30f7be2de07fb19ec25f4f6874474c286cb6fa50e26b7265fe34fad8655a` |
| f-keyset-score-into-nulls | 0 | 52.26 | 58.97 | 59.55 | 51.83 | 54.22 | -0.8 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| g-legacyscore-sort | 0 | error | | | error | | | `invalid input syntax for type numeric: "n/a"` |

`e` and `e2` return the same ids (same hash). `e2` is not skipped: `core/archetype/functionReturn.ts` exists at 04f73c6, so the batch feature-detect is true. The N+1 list still issues 54 statements vs 5 for the batched field.

## Md shapes (one run)

| shape | rows | p50 | p95 | p99 | stmts | id hash |
|---|---:|---:|---:|---:|---:|---|
| a-sort-rating-20 | 20 | 5.15 | 6.99 | 7.17 | 1 | `afc0b3c16fa3491c663601b3d1d34de5bb38d91b7e5384764cf02aabef3818e4` |
| a-sort-rating-100 | 100 | 5.16 | 6.82 | 7.81 | 1 | `46eae063c5f14f7f78730d902f336c096179607aea0c290a89c7c167e644aa55` |
| a-sort-rating-asc-20 | 20 | 5.22 | 6.72 | 7.47 | 1 | `8bcb3a2f514e153571944e7b7c089f32638dc085efda201a84abd61f3d4e89fd` |
| a-sort-username-asc-50 | 50 | 0.62 | 0.95 | 1.41 | 1 | `4b353af7e117c80693cde130a37aab1dbbc4b8de2a4eb1a2791a93fe7d9a8569` |
| a-sort-score-desc-20 | 20 | 5.20 | 6.65 | 6.71 | 1 | `18736f1ce46cc967968bcb30ac77f1521cae3bd439b02ad04f60ca026a42245e` |
| b-created-at-20 | 20 | 11.74 | 14.18 | 15.74 | 1 | `911cabfba0f8d34a1b08b404582ed828160fab63c814d1b7edec2d0ccf6b2956` |
| b-created-at-100 | 100 | 12.41 | 15.28 | 15.81 | 1 | `0d6c16b8bf95ebe8461c660f968b666eebe56d4af54464687e6e2cd4577aafd6` |
| b-created-at-review-desc-20 | 20 | 6.78 | 9.06 | 9.44 | 1 | `604ec6d5740508260aef9a2c52793da766f5aeba48bf05ac838e00f43be55f77` |
| b-created-at-review-asc-20 | 20 | 6.94 | 8.01 | 9.35 | 1 | `f000b6ea7d8d39e84040d29caf3fccc2d206eaf4ebb70d6aec848a9fc19b14e1` |
| b-created-at-keyset-20 | 20 | 20.83 | 24.89 | 26.20 | 1 | `1c8f2def5e71069db373f18cef1d3bad537dece8d239887582288c2e29e93902` |
| c-two-filter-sort-20 | 20 | 8.65 | 11.05 | 11.53 | 1 | `0c8a2846b2d1651b4e4075be7404d95da91dcd2f4af03e95f9af6ddc167d5aee` |
| c-selective-filter-sort-20 | 20 | 0.86 | 1.66 | 2.25 | 1 | `6d402194a904fac5ffbf9eed53a4dd64106c7ea9a0504436226beb153483d8c1` |
| d-populate-100 | 100 | 13.71 | 16.16 | 18.70 | 2 | `3895561be538c42eb51803fce8c1b795527fb58ec98e117a22e50a142cd09711` |
| d-count-two-components | 30000 | 14.68 | 17.48 | 19.53 | 1 | `8a894068bd1ac2c58892a5920cb59b6531fa093fd6620d80f3d63e3792fbb1b3` |
| e-graphql-list-50 | 50 | 6.27 | 9.26 | 9.28 | 54 | `4b353af7e117c80693cde130a37aab1dbbc4b8de2a4eb1a2791a93fe7d9a8569` |
| e2-graphql-list-50-batched | 50 | 4.11 | 7.11 | 7.31 | 5 | `4b353af7e117c80693cde130a37aab1dbbc4b8de2a4eb1a2791a93fe7d9a8569` |
| f-keyset-next-20 | 20 | 6.89 | 8.30 | 9.71 | 1 | `6848f516876fdea7a3671992659e88960f7ab84a37b240e78a31166345bd2e75` |
| f-keyset-deep-20 | 20 | 6.62 | 8.24 | 8.33 | 1 | `3dee943ecfb871ec1082d1cb4dfc854858b08c47da0712b752c95640a72ccec5` |
| f-keyset-before-20 | 20 | 5.53 | 7.47 | 7.61 | 1 | `4e2eea7ce14ca932dcb81f427c277e66732f10af761ccb146b129679a1fd60cf` |
| f-keyset-score-into-nulls | 0 | 5.57 | 7.39 | 8.29 | 1 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| g-legacyscore-sort | 0 | error | | | 0 | `invalid input syntax for type numeric: "n/a"` |

Md rating p50 ~5.2 ms vs lg ~47–50 ms (~10× rows, ~10× time). Created-at on orders is 11.7 ms at md and 213–221 ms at lg (~18×) because the plan reads every entity, and lg has 10× entities plus a larger sort. Username stays sub-millisecond at both scales.

## EXPLAIN (lg run 1)

Full text is in the JSON `explain` field. Node summary:

| shape | plan | rows actually read | buffers |
|---|---|---|---|
| a-sort-rating-20/100/asc, a-sort-score-desc-20 | Seq Scan `components_benchproduct` + top-N heapsort. Numeric btree **not** used. | 200000 | ~9k pages (hit+read), e.g. rating-20 `shared hit=3244 read=5847` |
| a-sort-username-asc-50 | **Index Scan** `idx_components_benchuser_username_btree` + incremental sort | 51 | `shared hit=54` |
| b-created-at-20/100 | Seq Scan `entities` (1000000) + Seq Scan `components_benchorder` (300000) + hash join + sort. Temp files. | 1e6 + 3e5 | `shared hit=4549 read=14804, temp read=5015 written=5015` (20) |
| b-created-at-review-desc/asc | Same shape: Seq Scan all entities + Seq Scan reviews (100000) + hash join + sort. DESC and ASC are the same plan. Newer reviews are not used. | 1e6 + 1e5 | `shared hit=6633 read=3662` (desc) |
| b-created-at-keyset-20 | Seq Scan entities (899960 after the keyset filter) + order partition + sort on `date_trunc('milliseconds', created_at)`. Still no created_at index walk. | ~9e5 + 3e5 | `shared hit=11329 read=8024, temp read=4613 written=4613` |
| c-two-filter-sort-20 | Seq Scan orders (194968 delivered) + Bitmap Index Scan `idx_…_fulfilled_btree` (90024) + hash join + top-N sort | 194968 + 90024 | `shared hit=11991 read=7556` |
| c-selective-filter-sort-20 | **Bitmap Index Scan** `idx_components_benchorder_status_btree` (6000 cancelled) + bitmap heap + top-N heapsort. No composite `(status, total)` index on this commit. | 6000 | `shared hit=6007` |
| d-populate-100 / d-count-two-components | Seq Scan both order partitions (300000 each) + intersect. Count wraps that in `COUNT(*)` and still sorts. | 300000 + 300000 | populate `shared hit=14672 read=4804, temp read=490 written=2218`; count similar plus the aggregate |
| f-keyset-next-20 | Seq Scan products, filter to 199980, sort | 199980 | `shared hit=1152 read=7939` |
| f-keyset-deep-20 | Seq Scan products, filter to 119999 (cursor at 40% by rating DESC). Not cheaper than next-page. | 119999 | `shared hit=2336 read=6755` |
| f-keyset-before-20 | Seq Scan products; filter leaves 39 rows (cursor at rank 40) but still reads the partition | 39 output | `shared hit=3520 read=5571` |
| f-keyset-score-into-nulls | Seq Scan products; DESC keyset predicate `score < 0 OR (score = 0 AND entity_id > …)` matches **0** rows. NULL does not satisfy `<`. Page does not cross into missing scores. | 0 | `shared hit=4704 read=4387` |
| g-legacyscore-sort | EXPLAIN failed with the same numeric cast error. No plan. | | |
| e / e2 | GraphQL. No EXPLAIN captured. | | |

Md plans are the same node types at 10× smaller cardinality (rating seq scan 20000 rows, `shared hit=910`; username index scan 51 rows, `shared hit=53`; cancelled bitmap 600 rows, `shared hit=602`; created-at seq scan 100000 entities).

## Surprises

1. **Only the text username sort is index-driven.** Rating, score, and created-at all seq-scan then sort. The numeric btree on `rating` / `score` / `total` is not chosen for `ORDER BY (data->>'f')::numeric`. That is the 0.9 list-read gap: limit 20 still reads 200k product rows (~50 ms) or 1M entities (~213 ms).
2. **Late reviews do not help `sortByCreatedAt`.** DESC and ASC on BenchReview are the same hash-join-everything plan and almost the same p50 (lg 98.81 vs 96.67, run 2 89.37 vs 89.77). The planner never walks `created_at` and stops. The 1-second gap is invisible.
3. **Keyset into nulls returns an empty page** (`rows=0`, hash `e3b0c44298fc…`, sha256 of no ids). The cursor is the last non-null score (`0`), and the DESC predicate does not include `IS NULL`. A correct NULLS LAST next page should be the missing-score rows. Base does not cross that boundary. The query still seq-scans ~9k pages to return nothing.
4. **`g-legacyscore-sort` errors on base**, as intended: `invalid input syntax for type numeric: "n/a"`. The partial numeric index excludes dirty rows; `ORDER BY (data->>'legacyScore')::numeric` still casts every row. Recorded as the shape error, not a harness failure. Same error at md and both lg runs.
5. **Selective status filter is already cheap** (lg 4.8 ms, bitmap on `status`, 6000 rows) versus the two-component delivered+fulfilled join (84 ms, seq scan 195k). A composite `(status, total)` index is absent here; the 4.8 ms is sort-of-6000 after a bitmap, not an index-ordered limit.
6. **Deep keyset is not a deeper index probe.** Offset-at-40% and page-2 keyset both seq-scan the product partition. lg p50 59 ms vs 62 ms.
7. **`e2` ran on 04f73c6.** The batch API file is present. Same ids as `e`, 5 statements vs 54.
8. **16-way mix collapses the index win.** Solo username is 0.75 ms; under 16 clients it is 1590 ms p50, in line with the seq-scan shapes. The pool (`max=16`) is held by the heavy scans, so a fast query waits for a slot. Throughput is 8.62 queries/s, 0 errors. p99 equals the max sample because each shape has only 15–16 points (`floor(n * 0.99)`).

## Concurrency

Lg, 16 clients, one process, framework pool `POSTGRES_MAX_CONNECTIONS=16`. Warmup 3 s, measured window 30 s (elapsed 32362 ms). Shapes skipped (already measured above). `g-legacyscore-sort` excluded after a probe error. GraphQL is not in the mix. 18 Query shapes, round-robin, staggered start. Seed for this run: 131101 ms total, insert 126994 ms.

**279 successful queries, 0 errors, 8.62 queries/s.**

| shape | samples | p50 | p95 | p99 | errors |
|---|---:|---:|---:|---:|---:|
| a-sort-rating-20 | 16 | 1636.48 | 3391.69 | 3391.69 | 0 |
| a-sort-rating-100 | 16 | 1655.45 | 3380.49 | 3380.49 | 0 |
| a-sort-rating-asc-20 | 16 | 1639.80 | 3402.67 | 3402.67 | 0 |
| a-sort-username-asc-50 | 16 | 1590.89 | 3305.46 | 3305.46 | 0 |
| a-sort-score-desc-20 | 16 | 1638.23 | 3445.11 | 3445.11 | 0 |
| b-created-at-20 | 15 | 1819.38 | 3371.74 | 3371.74 | 0 |
| b-created-at-100 | 15 | 1738.12 | 3447.56 | 3447.56 | 0 |
| b-created-at-review-desc-20 | 15 | 1618.68 | 3483.43 | 3483.43 | 0 |
| b-created-at-review-asc-20 | 15 | 1603.23 | 2910.69 | 2910.69 | 0 |
| b-created-at-keyset-20 | 15 | 1735.83 | 2423.28 | 2423.28 | 0 |
| c-two-filter-sort-20 | 15 | 1689.36 | 2832.07 | 2832.07 | 0 |
| c-selective-filter-sort-20 | 15 | 1511.36 | 3105.26 | 3105.26 | 0 |
| d-populate-100 | 16 | 3226.24 | 5790.80 | 5790.80 | 0 |
| d-count-two-components | 15 | 1743.89 | 2986.67 | 2986.67 | 0 |
| f-keyset-next-20 | 15 | 1502.36 | 1753.43 | 1753.43 | 0 |
| f-keyset-deep-20 | 16 | 1623.00 | 3491.11 | 3491.11 | 0 |
| f-keyset-before-20 | 16 | 1622.73 | 3436.47 | 3436.47 | 0 |
| f-keyset-score-into-nulls | 16 | 1646.42 | 3387.11 | 3387.11 | 0 |

Latency includes pool wait. Solo p50s are not comparable to these numbers. `d-populate-100` is the outlier (3.2 s p50, 5.8 s p95) because it holds a connection for the intersect plus a component fetch while the other 15 clients are also scanning.
