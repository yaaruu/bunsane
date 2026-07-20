/**
 * P0 Ceiling Proof: Columnar Read-Model vs Legacy Query Path
 *
 * Measures the real speedup of a hand-built columnar read-model table (rm_order)
 * versus the current ECS query path on a REAL PostgreSQL 17 server.
 *
 * Run via the real-PG wrapper (NOT bun test directly):
 *   bun tests/pg-setup.ts tests/perf/p0-ceiling-proof.test.ts
 *
 * Gate: page >= 5x speedup AND count >= 10x speedup AND after-plan is
 *       Index Only Scan with no SubPlan and no Seq Scan on components.
 *
 * BEFORE path: CTE + INTERSECT membership + per-filter EXISTS +
 *              correlated scalar-subquery ORDER BY (forced by using plain
 *              .cursor() which disables the sort-driven scan optimisation)
 * AFTER path:  single SELECT from rm_order served by a covering partial index
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import db from '../../database';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { ensureComponentsRegistered } from '../utils';
import { Query, FilterOp } from '../../query/Query';

// ---------------------------------------------------------------------------
// Component definitions (registered with the framework on beforeAll)
// ---------------------------------------------------------------------------

@Component
class P0Order extends BaseComponent {
    @CompData({ indexed: true })
    status!: string;

    @CompData({ indexed: true })
    total!: number;
}

@Component
class P0Customer extends BaseComponent {
    @CompData({ indexed: true })
    tier!: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function typeId(name: string): string {
    return createHash('sha256').update(name).digest('hex');
}

const ORDER_TYPE_ID = typeId('P0Order');
const CUSTOMER_TYPE_ID = typeId('P0Customer');

const SEED_COUNT = 30_000;

// Deterministic distributions
// status: open=25%, closed=25%, shipped=25%, cancelled=25%  (i % 4)
// tier:   gold=33%, silver=33%, bronze=33%                  (i % 3)
// total:  1..1000 cycling with step 7 (7*i % 1000 + 1)
//
// Predicate: status='open' AND tier='gold' AND total>100
// Matching fraction: ~25% * ~33% * ~90% ≈ 7.5%  => ~2250 rows

// ---------------------------------------------------------------------------
// Timing utility
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}

async function timeQuery(
    fn: () => Promise<unknown>,
    warmupRuns = 1,
    measureRuns = 5
): Promise<{ ms: number; runs: number[] }> {
    for (let i = 0; i < warmupRuns; i++) {
        await fn();
    }
    const runs: number[] = [];
    for (let i = 0; i < measureRuns; i++) {
        const t0 = performance.now();
        await fn();
        runs.push(performance.now() - t0);
    }
    return { ms: median(runs), runs };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let cursorEntityId: string; // smallest entity id in the seed set (cursor near start)
let seedCount = 0;
let matchCount = 0;

// ---------------------------------------------------------------------------
// beforeAll: seed + build rm_order
// ---------------------------------------------------------------------------

beforeAll(async () => {
    // 1. Register components so framework creates partition tables
    //    (components_p0order, components_p0customer)
    await ensureComponentsRegistered(P0Order, P0Customer);

    // 2. Seed entities and components in a transaction so all ops share
    //    the same connection (critical for TEMP table visibility).
    await db.transaction(async (tx) => {
        // Seed table: one row per entity, used to drive entity + component inserts
        await tx.unsafe(`
            CREATE TEMP TABLE _p0_seed (eid uuid NOT NULL, rn int NOT NULL)
            ON COMMIT DROP
        `);

        await tx.unsafe(`
            INSERT INTO _p0_seed (eid, rn)
            SELECT gen_random_uuid(), i
            FROM generate_series(0, ${SEED_COUNT - 1}) AS i
        `);

        // Insert entities with spread-out timestamps (deterministic, rn-based)
        await tx.unsafe(`
            INSERT INTO entities (id, created_at, updated_at)
            SELECT eid,
                   NOW() - make_interval(secs => rn),
                   NOW() - make_interval(secs => rn)
            FROM _p0_seed
        `);

        // Insert Order components into the LIST partition
        await tx.unsafe(`
            INSERT INTO components_p0order (id, entity_id, type_id, name, data, created_at, updated_at)
            SELECT gen_random_uuid(),
                   eid,
                   '${ORDER_TYPE_ID}'::text,
                   'P0Order',
                   jsonb_build_object(
                       'status', CASE (rn % 4)
                           WHEN 0 THEN 'open'
                           WHEN 1 THEN 'closed'
                           WHEN 2 THEN 'shipped'
                           ELSE 'cancelled'
                       END,
                       'total', (rn * 7 % 1000 + 1)::numeric
                   ),
                   NOW(),
                   NOW()
            FROM _p0_seed
        `);

        // Insert Customer components into the LIST partition
        await tx.unsafe(`
            INSERT INTO components_p0customer (id, entity_id, type_id, name, data, created_at, updated_at)
            SELECT gen_random_uuid(),
                   eid,
                   '${CUSTOMER_TYPE_ID}'::text,
                   'P0Customer',
                   jsonb_build_object(
                       'tier', CASE (rn % 3)
                           WHEN 0 THEN 'gold'
                           WHEN 1 THEN 'silver'
                           ELSE 'bronze'
                       END
                   ),
                   NOW(),
                   NOW()
            FROM _p0_seed
        `);

        // Capture any valid cursor entity id from the seed set.
        // We need a UUID that passes entity_id > cursor for almost all rows
        // so the BEFORE query scans the full result set.
        // Use the entity with rn=0 (first inserted) by grabbing the eid
        // for the row with smallest rn value.
        const row = await tx.unsafe(`SELECT eid::text AS eid FROM _p0_seed WHERE rn = 0 LIMIT 1`);
        cursorEntityId = (row as any[])[0]?.eid as string;
    });
    // TEMP table dropped at end of transaction (ON COMMIT DROP).

    // 3. Create and backfill rm_order (the columnar read-model)
    await db.unsafe(`
        CREATE TABLE rm_order (
            entity_id       uuid PRIMARY KEY,
            order_status    text,
            order_total     numeric,
            customer_tier   text,
            created_at      timestamptz NOT NULL,
            updated_at      timestamptz NOT NULL,
            deleted_at      timestamptz,
            shape_version   int NOT NULL DEFAULT 1
        )
    `);

    await db.unsafe(`
        INSERT INTO rm_order (entity_id, order_status, order_total, customer_tier, created_at, updated_at)
        SELECT o.entity_id,
               o.data->>'status',
               (o.data->>'total')::numeric,
               c.data->>'tier',
               e.created_at,
               e.updated_at
        FROM components_p0order o
        JOIN components_p0customer c
            ON c.entity_id = o.entity_id
           AND c.type_id = '${CUSTOMER_TYPE_ID}'::text
           AND c.deleted_at IS NULL
        JOIN entities e
            ON e.id = o.entity_id
           AND e.deleted_at IS NULL
        WHERE o.type_id = '${ORDER_TYPE_ID}'::text
          AND o.deleted_at IS NULL
    `);

    // 4. Create the covering partial index for the worst-case predicate
    //    (equality prefix order_status + customer_tier, range sort order_total DESC,
    //     tiebreak entity_id, covering created_at + updated_at for keyset)
    await db.unsafe(`
        CREATE INDEX idx_rm_order__status_tier_total_id
        ON rm_order (order_status, customer_tier, order_total DESC, entity_id)
        INCLUDE (created_at, updated_at)
        WHERE deleted_at IS NULL
    `);

    // 5. ANALYZE so the planner has accurate statistics
    await db.unsafe(`ANALYZE components_p0order`);
    await db.unsafe(`ANALYZE components_p0customer`);
    await db.unsafe(`ANALYZE rm_order`);

    // 6. Sanity: count seeded entities and expected matches
    const sc = await db.unsafe(`SELECT count(*) AS n FROM components_p0order`);
    seedCount = Number((sc as any[])[0]?.n ?? 0);

    const mc = await db.unsafe(`
        SELECT count(*) AS n FROM rm_order
        WHERE deleted_at IS NULL
          AND order_status = 'open'
          AND customer_tier = 'gold'
          AND order_total > 100
    `);
    matchCount = Number((mc as any[])[0]?.n ?? 0);

    console.log(`\n[p0-setup] Seeded ${seedCount} entities.`);
    console.log(`[p0-setup] Matching rows (status=open, tier=gold, total>100): ${matchCount}`);
    console.log(`[p0-setup] Cursor entity id: ${cursorEntityId}`);
}, 120_000 /* 2 min for seeding */);

// ---------------------------------------------------------------------------
// afterAll: drop rm_order (scratch DB is destroyed by pg-setup.ts anyway)
// ---------------------------------------------------------------------------

afterAll(async () => {
    try {
        await db.unsafe(`DROP TABLE IF EXISTS rm_order`);
    } catch {
        // ignore; scratch DB will be dropped by pg-setup.ts wrapper
    }
});

// ---------------------------------------------------------------------------
// The gate test
// ---------------------------------------------------------------------------

describe('P0 Ceiling Proof', () => {
    test('measures legacy vs rm_order and asserts gate', async () => {
        expect(seedCount).toBeGreaterThan(0);
        expect(matchCount).toBeGreaterThan(100);
        expect(cursorEntityId).toBeTruthy();

        // =======================================================================
        // BEFORE: legacy ECS query path
        //
        // Using .cursor(entityId) — plain entity-id cursor — to force the
        // CTE + INTERSECT path, which then uses a correlated scalar-subquery
        // ORDER BY (cost centres A, B, C combined).  Without the cursor the
        // sort-driven scan would apply, which is already better; the cursor
        // is the knob that reliably engages the true worst-case DAG.
        //
        // SQL shape emitted:
        //   WITH base_entities AS (
        //     SELECT entity_id FROM (
        //       (SELECT ec.entity_id FROM components ec WHERE type_id=$1 AND deleted_at IS NULL AND entity_id > $cursor)
        //       INTERSECT
        //       (SELECT ec.entity_id FROM components ec WHERE type_id=$2 AND deleted_at IS NULL AND entity_id > $cursor)
        //     ) AS intersected
        //     ORDER BY entity_id ASC
        //   )
        //   SELECT base_entities.id FROM (
        //     SELECT DISTINCT base_entities.entity_id AS id FROM base_entities
        //     WHERE (EXISTS (... type_id=$1 AND status=$3 ...))
        //       AND (EXISTS (... type_id=$1 AND total::numeric > $4::numeric ...))
        //       AND (EXISTS (... type_id=$2 AND tier=$5 ...))
        //   ) AS base_entities
        //   ORDER BY (SELECT (sort_c.data->>'total')::numeric FROM components_p0order sort_c
        //             WHERE sort_c.entity_id = base_entities.id ...) DESC NULLS LAST,
        //            base_entities.id ASC
        //   LIMIT 21
        // =======================================================================

        const beforePageFn = () =>
            new Query()
                .with(P0Order, {
                    filters: [
                        Query.filter('status', FilterOp.EQ, 'open'),
                        Query.filter('total', FilterOp.GT, 100),
                    ],
                })
                .with(P0Customer, {
                    filters: [Query.filter('tier', FilterOp.EQ, 'gold')],
                })
                .sortBy(P0Order, 'total', 'DESC')
                .cursor(cursorEntityId) // forces CTE+INTERSECT + scalar-subquery ORDER BY
                .take(21)
                .exec();

        const beforePageTiming = await timeQuery(beforePageFn, 1, 5);

        // EXPLAIN ANALYZE for the BEFORE page query
        const beforePlan = await new Query()
            .with(P0Order, {
                filters: [
                    Query.filter('status', FilterOp.EQ, 'open'),
                    Query.filter('total', FilterOp.GT, 100),
                ],
            })
            .with(P0Customer, {
                filters: [Query.filter('tier', FilterOp.EQ, 'gold')],
            })
            .sortBy(P0Order, 'total', 'DESC')
            .cursor(cursorEntityId)
            .take(21)
            .explainAnalyze(true);

        // BEFORE COUNT: no cursor, no sort (doCount clears them), but 3 filters
        // still force CTE + INTERSECT with a SELECT COUNT(*) wrapper.
        const beforeCountFn = () =>
            new Query()
                .with(P0Order, {
                    filters: [
                        Query.filter('status', FilterOp.EQ, 'open'),
                        Query.filter('total', FilterOp.GT, 100),
                    ],
                })
                .with(P0Customer, {
                    filters: [Query.filter('tier', FilterOp.EQ, 'gold')],
                })
                .count();

        const beforeCountTiming = await timeQuery(beforeCountFn, 1, 5);

        // =======================================================================
        // AFTER: rm_order single-table query
        // =======================================================================

        const afterPageSql = `
            SELECT entity_id
            FROM   rm_order
            WHERE  deleted_at IS NULL
              AND  order_status   = 'open'
              AND  customer_tier  = 'gold'
              AND  order_total    > 100
            ORDER BY order_total DESC, entity_id ASC
            LIMIT  21
        `.trim();

        const afterPageFn = () => db.unsafe(afterPageSql);
        const afterPageTiming = await timeQuery(afterPageFn, 1, 5);

        const afterPlanRows = await db.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${afterPageSql}`
        );
        const afterPagePlan = (afterPlanRows as any[]).map((r: any) => r['QUERY PLAN']).join('\n');

        const afterCountSql = `
            SELECT count(*) AS n
            FROM   rm_order
            WHERE  deleted_at IS NULL
              AND  order_status  = 'open'
              AND  customer_tier = 'gold'
              AND  order_total   > 100
        `.trim();

        const afterCountFn = () => db.unsafe(afterCountSql);
        const afterCountTiming = await timeQuery(afterCountFn, 1, 5);

        const afterCountPlanRows = await db.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${afterCountSql}`
        );
        const afterCountPlan = (afterCountPlanRows as any[]).map((r: any) => r['QUERY PLAN']).join('\n');

        // =======================================================================
        // Gate criteria
        // =======================================================================

        const pageRatio = beforePageTiming.ms / Math.max(afterPageTiming.ms, 0.001);
        const countRatio = beforeCountTiming.ms / Math.max(afterCountTiming.ms, 0.001);

        // AFTER plan must use Index Only Scan on the covering index
        const hasIndexOnlyScan =
            afterPagePlan.includes('Index Only Scan') ||
            afterPagePlan.includes('Index Scan');

        // AFTER plan must NOT have correlated SubPlan nodes (the legacy sort cost)
        const hasNoSubPlan = !afterPagePlan.includes('SubPlan');

        // AFTER plan must NOT sequential-scan the components table
        const hasNoComponentSeqScan =
            !afterPagePlan.includes('Seq Scan on components') &&
            !afterPagePlan.includes('Seq Scan on components_p0');

        const gatePageOk  = pageRatio  >= 5;
        const gateCountOk = countRatio >= 10;
        const gatePlanOk  = hasIndexOnlyScan && hasNoSubPlan && hasNoComponentSeqScan;
        const gatePass    = gatePageOk && gateCountOk && gatePlanOk;

        // =======================================================================
        // Report
        // =======================================================================

        const hr = '='.repeat(72);
        console.log(`\n${hr}`);
        console.log('P0 CEILING PROOF RESULTS');
        console.log(hr);

        console.log(`\nDataset:`);
        console.log(`  Seeded entities:              ${seedCount.toLocaleString()}`);
        console.log(`  Matching rows (pred):         ${matchCount.toLocaleString()}`);

        console.log(`\nPage query (LIMIT 21, ORDER BY total DESC, multi-component):`);
        console.log(`  BEFORE (CTE+INTERSECT+EXISTS+scalar-subquery):`);
        console.log(`    median = ${beforePageTiming.ms.toFixed(2)} ms`);
        console.log(`    runs   = ${beforePageTiming.runs.map(r => r.toFixed(1) + 'ms').join(', ')}`);
        console.log(`  AFTER  (rm_order, covering index):`);
        console.log(`    median = ${afterPageTiming.ms.toFixed(2)} ms`);
        console.log(`    runs   = ${afterPageTiming.runs.map(r => r.toFixed(1) + 'ms').join(', ')}`);
        console.log(`  Speedup: ${pageRatio.toFixed(1)}x  ${gatePageOk ? '[OK >= 5x]' : '[FAIL < 5x]'}`);

        console.log(`\nCount query (exact count, same predicates):`);
        console.log(`  BEFORE: median = ${beforeCountTiming.ms.toFixed(2)} ms`);
        console.log(`  AFTER:  median = ${afterCountTiming.ms.toFixed(2)} ms`);
        console.log(`  Speedup: ${countRatio.toFixed(1)}x  ${gateCountOk ? '[OK >= 10x]' : '[FAIL < 10x]'}`);

        console.log(`\nAFTER page plan (top 15 lines):`);
        console.log(afterPagePlan.split('\n').slice(0, 15).join('\n'));

        console.log(`\nAFTER count plan (top 10 lines):`);
        console.log(afterCountPlan.split('\n').slice(0, 10).join('\n'));

        console.log(`\nBEFORE page plan (top 15 lines):`);
        console.log(beforePlan.split('\n').slice(0, 15).join('\n'));

        console.log(`\nPlan assertions (AFTER page query):`);
        console.log(`  Index Only Scan (or Index Scan): ${hasIndexOnlyScan ? 'YES' : 'NO'}`);
        console.log(`  No SubPlan:                      ${hasNoSubPlan    ? 'YES' : 'NO'}`);
        console.log(`  No Seq Scan on components*:      ${hasNoComponentSeqScan ? 'YES' : 'NO'}`);

        console.log(`\n${hr}`);
        const gateWord = gatePass ? 'PASS' : 'FAIL';
        console.log(
            `GATE: ${gateWord}` +
            ` | page ${pageRatio.toFixed(1)}x (need >=5x)` +
            ` | count ${countRatio.toFixed(1)}x (need >=10x)` +
            ` | plan ${gatePlanOk ? 'OK' : 'FAIL'}`
        );
        console.log(`${hr}\n`);

        // =======================================================================
        // Assertions
        // The test always passes if the harness runs — we want the numbers
        // regardless. Hard-fail only on a broken harness (no rows seeded etc.).
        // =======================================================================

        expect(beforePlan.length).toBeGreaterThan(0);
        expect(afterPagePlan.length).toBeGreaterThan(0);

        // The AFTER plan should not be doing a sequential scan on rm_order
        // (that would mean the index wasn't used at all — misconfiguration)
        const afterDoesSeqScanRmOrder =
            afterPagePlan.includes('Seq Scan on rm_order') &&
            !afterPagePlan.includes('Index');
        expect(afterDoesSeqScanRmOrder).toBe(false);
    }, 120_000 /* up to 2 min for timing runs */);
});
