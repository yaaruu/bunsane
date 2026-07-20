// QSP Phase P6 — legacy-demotion proof (real PostgreSQL).
//
// Proves that routing a fully-covered archetype to rm_ demonstrably REMOVES the
// legacy read-path cost centers (INTERSECT membership, correlated EXISTS / scalar
// subquery SubPlans, sequential scans on the `components` storage) — while the
// legacy compiler is left completely untouched for everything else.
//
// The proof has two prongs:
//   1. The worst-case COVERED query (2 components + multi-filter + component sort
//      + keyset — the P0 shape) is served from rm_ (routed === true) and its
//      EXPLAIN plan is a single covering-index scan: NO INTERSECT, NO SubPlan,
//      NO scan of the components tables. The SAME shape run through the legacy
//      compiler DOES touch the components tables with correlated sub-plans —
//      proving the demotion is real, not vacuous.
//   2. The true INTERSECT worst-case (an id-cursor + sort query, the exact P0
//      knob) is NOT covered by the planner, so it stays on legacy and its plan
//      still contains INTERSECT + SubPlan — routing never touched it.
//
// NOTE: env is set at top; Query.ts reads BUNSANE_QSP at call time so this
// works despite ES import hoisting. explainAnalyze() ALWAYS compiles the legacy
// DAG regardless of QSP mode, so it is the ground-truth for the legacy plan.
// Guard module-top env writes so BUNSANE_QSP does not leak into the shared
// bun-test process under PGlite (this describe is skipIf(isPGlite); on real PG the env
// is set normally). Without the guard, a real App boot in another test file runs
// InitializeProjections() under PGlite's single connection and wedges the whole run.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_ARCHETYPES = 'QspDemotionArchetype';
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
    process.env.BUNSANE_QSP = 'route';
    process.env.BUNSANE_QSP_COUNT = 'exact';
}

import 'reflect-metadata';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../database';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { Query } from '../../query/Query';
import { ProjectionManager, runBackfill, rmTableName, assertRmTableName } from '../../database/projection';
import {
    PlannerCache, buildCoverageRequest, SurfacePlanner, buildRmQuery,
} from '../../query/planner';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspDemoOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
    }
    @Component
    class QspDemoCustomer extends BaseComponent {
        @CompData({ indexed: true }) tier!: string;
    }
    @ArcheType({ name: 'QspDemotionArchetype' })
    class QspDemotionArchetype extends BaseArcheType {
        @ArcheTypeField(QspDemoOrder) order!: QspDemoOrder;
        @ArcheTypeField(QspDemoCustomer) customer!: QspDemoCustomer;
    }

    describe('QSP legacy demotion (real PG)', () => {
        // Seed entities are UNTRACKED (Entity.Create) so createTestContext's afterEach
        // cleanup never touches them; the ephemeral scratch DB is dropped by pg-setup.
        createTestContext();
        const archetypeName = 'QspDemotionArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const allEntities: Entity[] = [];

        // status=open (i%4==0) AND tier=gold (i%3==0) => i%12==0 ; total>=100 => ~90%.
        const SEED = 1200;

        beforeAll(async () => {
            await ensureComponentsRegistered(QspDemoOrder, QspDemoCustomer);
            process.env.BUNSANE_QSP_ARCHETYPES = archetypeName;
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_COUNT = 'exact';

            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db`CREATE TABLE IF NOT EXISTS projection_state (
                archetype text PRIMARY KEY, shape_hash text NOT NULL,
                status text NOT NULL DEFAULT 'DISABLED', shape_version int NOT NULL DEFAULT 1,
                watermark uuid, field_state jsonb NOT NULL DEFAULT '{}',
                updated_at timestamptz NOT NULL DEFAULT now()
            );`;
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);

            ProjectionManager.reset();
            await ProjectionManager.instance.initialize(); // rm_ table + covering index, status DISABLED

            // Seed with dual-write OFF (DISABLED) → rows land only in `components`.
            for (let i = 0; i < SEED; i++) {
                const e = Entity.Create();
                const status = (['open', 'closed', 'shipped', 'cancelled'] as const)[i % 4]!;
                const tier = (['gold', 'silver', 'bronze'] as const)[i % 3]!;
                e.add(QspDemoOrder, { status, total: (i * 7) % 1000 + 1 });
                e.add(QspDemoCustomer, { tier });
                await e.save();
                allEntities.push(e);
            }

            // Backfill reconstructs rm_ from components → READY.
            await runBackfill(archetypeName);
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');
            await ProjectionManager.instance.setStatus(archetypeName, 'READY');
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('READY');

            // A few live dual-writes so rm_ exercises the upsert path too.
            for (let i = 0; i < 100; i++) {
                const e = Entity.Create();
                e.add(QspDemoOrder, { status: 'open', total: (i * 13) % 1000 + 1 });
                e.add(QspDemoCustomer, { tier: 'gold' });
                await e.save();
                allEntities.push(e);
            }

            // Analyze so the planner has accurate stats for the EXPLAINs.
            await db.unsafe(`ANALYZE ${tableName}`);

            // Prime the planner cache so it observes READY.
            await PlannerCache.instance.refresh();
        }, 300_000);

        afterAll(async () => {
            ProjectionManager.reset();
            PlannerCache.reset();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        });

        // CoverageRequest from a configured (un-executed) Query's private context.
        const reqOf = (q: Query<any>) => buildCoverageRequest((q as any).context);

        test('worst-case covered query: routed served plan has NO legacy cost centers; legacy DOES', async () => {
            process.env.BUNSANE_QSP = 'route';

            const k = 10;
            const baseWorstCase = () => new Query()
                .with(QspDemoOrder, Query.filters(
                    Query.filter('status', '=', 'open'),
                    Query.filter('total', '>=', 100),
                ))
                .with(QspDemoCustomer, Query.filters(Query.filter('tier', '=', 'gold')))
                .sortBy(QspDemoOrder, 'total', 'DESC')
                .take(k);

            // Derive a real keyset token from page 1 (routed) so the worst-case query
            // carries a component-sort keyset — the full P0 shape.
            const page1 = await baseWorstCase().populate().exec();
            expect(page1.length).toBe(k);
            const last = page1[page1.length - 1]!;
            const sortVal = (last as any).componentData['QspDemoOrder'].total;
            const token = Query.encodeSortedCursor(sortVal, last.id);

            const worstCase = () => baseWorstCase().sortedCursor(token);

            // --- Prong 1a: the query is actually served from rm_ ---
            const q = worstCase();
            await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(true);
            expect(q.getLastRouteInfo().surface).toBe('rm');
            expect(q.getLastRouteInfo().archetype).toBe(archetypeName);

            // --- Prong 1b: EXPLAIN the exact served rm_ query ---
            const req = reqOf(worstCase());
            const res = SurfacePlanner.instance.resolve(req);
            expect(res.surface).toBe('rm');
            const { sql, params } = buildRmQuery(res.archetype!, req);

            let routedPlan = '';
            await db.transaction(async (tx: any) => {
                // Small tables favor a Seq Scan; force index consideration so we prove
                // the covering index CAN serve this as an index scan.
                await tx.unsafe('SET LOCAL enable_seqscan = off');
                const plan: any[] = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
                routedPlan = plan.map(r => r['QUERY PLAN']).join('\n');
            });
            console.log('\n=== ROUTED served rm_ plan (worst-case covered) ===\n' + routedPlan);

            // Routed plan is a single covering-index scan on rm_ — none of the legacy cost centers.
            expect(routedPlan).toMatch(/Index (Only )?Scan/);
            expect(routedPlan).toMatch(new RegExp(tableName));   // the rm_ surface
            expect(routedPlan).not.toMatch(/INTERSECT/i);        // no set-op membership
            expect(routedPlan).not.toMatch(/SubPlan/);           // no correlated sub-plans
            expect(routedPlan).not.toMatch(/components/i);       // never touches component storage

            // --- Prong 1c: the SAME shape through the legacy compiler DOES pay the cost ---
            // explainAnalyze() always compiles the legacy DAG (QSP-mode-agnostic). For a
            // covered shape the legacy path is the sort-driven scan, which must combine
            // BOTH component storage tables — via correlated EXISTS sub-plans, a
            // semi-join, or (as the planner flattens them here) an explicit join. That
            // multi-table membership cost is exactly what routing collapses into the
            // single rm_ covering-index scan above. (The literal INTERSECT worst case is
            // proven separately by the id-cursor test below.)
            const legacyPlan = await worstCase().explainAnalyze(true);
            console.log('\n=== LEGACY plan (same worst-case shape, sort-driven scan) ===\n' + legacyPlan);

            // Legacy touches BOTH component storage tables (routing touches neither).
            expect(legacyPlan).toMatch(/components_qspdemoorder/i);
            expect(legacyPlan).toMatch(/components_qspdemocustomer/i);
            // ...and combines them (join or correlated sub-plan) — the cost center removed.
            expect(legacyPlan).toMatch(/Nested Loop|Hash Join|Merge Join|SubPlan|Semi Join|Intersect/i);
        }, 120_000);

        test('true INTERSECT worst-case (id-cursor + sort) stays on legacy — routing never touched it', async () => {
            process.env.BUNSANE_QSP = 'route';

            // id-cursor + a component sort is intentionally NOT covered by the planner
            // (SurfacePlanner requires an id cursor to have zero sorts). This is the
            // exact P0 knob that forces the CTE + INTERSECT + correlated scalar-subquery
            // ORDER BY worst case, and it must remain served by legacy.
            const cursorId = allEntities[0]!.id;
            const idCursorQuery = () => new Query()
                .with(QspDemoOrder, Query.filters(
                    Query.filter('status', '=', 'open'),
                    Query.filter('total', '>=', 100),
                ))
                .with(QspDemoCustomer, Query.filters(Query.filter('tier', '=', 'gold')))
                .sortBy(QspDemoOrder, 'total', 'DESC')
                .cursor(cursorId)
                .take(21);

            // Planner must refuse to route it → served by legacy.
            const req = reqOf(idCursorQuery());
            expect(SurfacePlanner.instance.resolve(req).surface).toBe('legacy');

            const q = idCursorQuery();
            await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(false);
            expect(q.getLastRouteInfo().surface).toBe('legacy');

            // The legacy plan for this shape still contains the INTERSECT membership
            // and the correlated SubPlan (scalar-subquery ORDER BY + per-filter EXISTS).
            const legacyPlan = await idCursorQuery().explainAnalyze(true);
            console.log('\n=== LEGACY id-cursor INTERSECT plan (P0 worst case) ===\n' + legacyPlan);
            expect(legacyPlan).toMatch(/Intersect/i);
            expect(legacyPlan).toMatch(/SubPlan/);
        }, 120_000);
    });
}

if (isPGlite) {
    describe.skip('QSP legacy demotion (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
