// QSP Phase P3 — shadow-mode parity gate (real PostgreSQL).
// Enables a projected archetype, backfills to READY, runs queries in shadow mode and
// asserts the rm_ surface returns byte-identical ordered id-sets to the legacy compiler.
// NOTE: env is set at top; Query.ts reads BUNSANE_QSP at call time so this works
// despite ES import hoisting.
// Guard module-top env writes so BUNSANE_QSP does not leak into the shared
// bun-test process under PGlite (this describe is skipIf(isPGlite); on real PG the env
// is set normally). Without the guard, a real App boot in another test file runs
// InitializeProjections() under PGlite's single connection and wedges the whole run.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_ARCHETYPES = 'QspShadowArchetype';
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
    process.env.BUNSANE_QSP = 'shadow';
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
    drainShadows, qspPlannerMetrics, resetQspPlannerMetrics,
} from '../../query/planner';
import { resolveHydrationPlan } from '../../query/planner/RmHydrationPlan';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspShadowOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
    }
    @Component
    class QspShadowCustomer extends BaseComponent {
        @CompData({ indexed: true }) tier!: string;
    }
    @ArcheType({ name: 'QspShadowArchetype' })
    class QspShadowArchetype extends BaseArcheType {
        @ArcheTypeField(QspShadowOrder) order!: QspShadowOrder;
        @ArcheTypeField(QspShadowCustomer) customer!: QspShadowCustomer;
    }

    const STATUSES = ['open', 'closed', 'gold', 'pending'];
    const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
    // Deterministic LCG so the randomized suite is reproducible.
    const rnd = (seed: { s: number }) => {
        seed.s = (seed.s * 1103515245 + 12345) & 0x7fffffff;
        return seed.s / 0x7fffffff;
    };

    describe('QSP shadow parity (real PG)', () => {
        // NOTE: seed entities are created UNTRACKED (Entity.Create(), not ctx.tracker.create())
        // so the per-test afterEach cleanup neither deletes the shared dataset between tests nor
        // times out deleting thousands of rows. The ephemeral scratch DB is dropped by pg-setup.
        createTestContext(); // cache + EntityManager readiness hooks only
        const archetypeName = 'QspShadowArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const allEntities: Entity[] = [];

        beforeAll(async () => {
            await ensureComponentsRegistered(QspShadowOrder, QspShadowCustomer);
            process.env.BUNSANE_QSP_ARCHETYPES = archetypeName;
            process.env.BUNSANE_QSP = 'shadow';

            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db`CREATE TABLE IF NOT EXISTS projection_state (
                archetype text PRIMARY KEY, shape_hash text NOT NULL,
                status text NOT NULL DEFAULT 'DISABLED', shape_version int NOT NULL DEFAULT 1,
                watermark uuid, field_state jsonb NOT NULL DEFAULT '{}',
                updated_at timestamptz NOT NULL DEFAULT now()
            );`;
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);

            ProjectionManager.reset();
            await ProjectionManager.instance.initialize(); // creates rm_ table + covering index, status DISABLED

            // Phase A: seed with dual-write OFF (DISABLED) → rows land only in `components`.
            const seed = { s: 42 };
            const N_A = 1800;
            for (let i = 0; i < N_A; i++) {
                const e = Entity.Create();
                e.add(QspShadowOrder, { status: STATUSES[i % STATUSES.length], total: Math.floor(rnd(seed) * 1000) });
                e.add(QspShadowCustomer, { tier: TIERS[i % TIERS.length] });
                await e.save();
                allEntities.push(e);
            }

            // Backfill reconstructs rm_ from components → READY.
            await runBackfill(archetypeName);
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');

            // Phase B: live dual-write path (status READY) — exercises upsert + timestamp parity.
            const N_B = 300;
            for (let i = 0; i < N_B; i++) {
                const e = Entity.Create();
                e.add(QspShadowOrder, { status: STATUSES[(i + 1) % STATUSES.length], total: Math.floor(rnd(seed) * 1000) });
                e.add(QspShadowCustomer, { tier: TIERS[(i + 2) % TIERS.length] });
                await e.save();
                allEntities.push(e);
            }

            // Update a subset — component saves bump entities.updated_at in the
            // same transaction, and upsertProjection copies that column (not a
            // separate clock). Parity still requires rm_.updated_at to mirror
            // entities.updated_at after the bump.
            for (let i = 0; i < 150; i++) {
                const e = allEntities[(i * 10) % allEntities.length]!;
                await e.set(QspShadowOrder, { status: 'closed', total: Math.floor(rnd(seed) * 1000) });
                await e.save();
            }

            // Prime the planner cache so it observes READY.
            await PlannerCache.instance.refresh();
        }, 180_000);

        afterAll(async () => {
            await drainShadows();
            ProjectionManager.reset();
            PlannerCache.reset();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        });

        // CoverageRequest from a configured (un-executed) Query's private context.
        const reqOf = (q: Query<any>) => buildCoverageRequest((q as any).context);

        // Independent parity: legacy exec vs rm_ plan run directly — identical ordered ids.
        async function assertDirectParity(makeQuery: () => Query<any>) {
            const legacy = await makeQuery().exec();
            const legacyIds = legacy.map(e => e.id);
            const req = reqOf(makeQuery());
            const res = SurfacePlanner.instance.resolve(req);
            expect(res.surface).toBe('rm');
            const { sql, params } = buildRmQuery(res.archetype!, req);
            const rows: any[] = await db.unsafe(sql, params);
            const rmIds = rows.map(r => r.entity_id);
            expect(rmIds).toEqual(legacyIds);
        }

        test('worst-case covered query routes to rm and matches legacy (direct)', async () => {
            await assertDirectParity(() => new Query()
                .with(QspShadowOrder, Query.filters(
                    Query.filter('status', '=', 'closed'),
                    Query.filter('total', '>', 100),
                ))
                .with(QspShadowCustomer, Query.filters(Query.filter('tier', '=', 'gold')))
                .sortBy(QspShadowOrder, 'total', 'DESC')
                .take(25));
        });

        test('rm plan for covering-index query is index scan, no SubPlan / no Seq Scan', async () => {
            const q = new Query()
                .with(QspShadowOrder, Query.filters(Query.filter('status', '=', 'open'), Query.filter('total', '>=', 200)))
                .with(QspShadowCustomer, Query.filters(Query.filter('tier', '=', 'silver')))
                .sortBy(QspShadowOrder, 'total', 'DESC')
                .take(20);
            const req = reqOf(q);
            const res = SurfacePlanner.instance.resolve(req);
            expect(res.surface).toBe('rm');
            const { sql, params } = buildRmQuery(res.archetype!, req);

            // Small tables favor a Seq Scan; force index consideration so we prove a
            // key index can serve this sort (no correlated SubPlan, no data->> scan).
            let text = '';
            await db.transaction(async (tx: any) => {
                await tx.unsafe('SET LOCAL enable_seqscan = off');
                const plan: any[] = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
                text = plan.map(r => r['QUERY PLAN']).join('\n');
            });
            expect(text).toMatch(/Index (Only )?Scan/);
            expect(text).not.toMatch(/SubPlan/);
            expect(text).not.toMatch(/Seq Scan on rm_/i);
        });

        test('sort-by-createdAt + keyset parity (timestamp-parity gate)', async () => {
            for (const dir of ['ASC', 'DESC'] as const) {
                const page1 = await new Query().with(QspShadowOrder).with(QspShadowCustomer)
                    .sortByCreatedAt(dir).take(30).exec();
                expect(page1.length).toBeGreaterThan(0);
                const lastId = page1[page1.length - 1]!.id;
                const cr: any[] = await db.unsafe(`SELECT created_at FROM entities WHERE id = $1`, [lastId]);
                const token = Query.encodeSortedCursor(new Date(cr[0].created_at), lastId);
                await assertDirectParity(() => new Query().with(QspShadowOrder).with(QspShadowCustomer)
                    .sortByCreatedAt(dir).take(30).sortedCursor(token));
            }
        });

        test('sort-by-updatedAt parity (updated rows mirror entities.updated_at)', async () => {
            await assertDirectParity(() => new Query().with(QspShadowOrder).with(QspShadowCustomer)
                .sortByUpdatedAt('DESC').take(40));
        });

        test('component-sort keyset parity (numeric total, both directions)', async () => {
            for (const dir of ['ASC', 'DESC'] as const) {
                const page1 = await new Query().with(QspShadowOrder).with(QspShadowCustomer)
                    .sortBy(QspShadowOrder, 'total', dir).take(25).populate().exec();
                expect(page1.length).toBeGreaterThan(0);
                const last = page1[page1.length - 1]!;
                const token = Query.encodeSortedCursor((last as any).componentData['QspShadowOrder'].total, last.id);
                await assertDirectParity(() => new Query().with(QspShadowOrder).with(QspShadowCustomer)
                    .sortBy(QspShadowOrder, 'total', dir).take(25).sortedCursor(token));
            }
        });

        test('projected component ids match components.id for backfilled AND dual-written rows', async () => {
            // Without this the hydrator silently skips every component (no id => never serve),
            // so Fix A would degrade to a no-op instead of failing.
            const mismatches: any[] = await db.unsafe(`
                SELECT r.entity_id,
                       r.qsp_shadow_order__cid AS rm_order_cid,
                       o.id AS real_order_cid,
                       r.qsp_shadow_customer__cid AS rm_customer_cid,
                       c.id AS real_customer_cid
                FROM ${tableName} r
                LEFT JOIN components o ON o.entity_id = r.entity_id
                     AND o.type_id = $1 AND o.deleted_at IS NULL
                LEFT JOIN components c ON c.entity_id = r.entity_id
                     AND c.type_id = $2 AND c.deleted_at IS NULL
                WHERE r.deleted_at IS NULL
                  AND (r.qsp_shadow_order__cid IS DISTINCT FROM o.id
                    OR r.qsp_shadow_customer__cid IS DISTINCT FROM c.id)
                LIMIT 5
            `, [
                new QspShadowOrder().getTypeID(),
                new QspShadowCustomer().getTypeID(),
            ]);

            if (mismatches.length > 0) console.error('cid mismatches:', mismatches);
            expect(mismatches.length).toBe(0);

            const [{ total, withIds }] = await db.unsafe(`
                SELECT count(*)::int AS total,
                       count(qsp_shadow_order__cid)::int AS "withIds"
                FROM ${tableName} WHERE deleted_at IS NULL
            `);
            expect(total).toBeGreaterThan(0);
            expect(withIds).toBe(total);
        });

        test('row-hydration data parity: zero field divergences across every projected type', async () => {
            resetQspPlannerMetrics();
            process.env.BUNSANE_QSP_HYDRATE_SHADOW = 'on';
            try {
                // Both components are all-scalar, so the F1 gate admits both.
                const descriptor = ProjectionManager.instance.getDescriptor(archetypeName)!;
                const plan = resolveHydrationPlan(archetypeName, descriptor,
                    PlannerCache.instance.getState(archetypeName)?.fieldState ?? {});
                expect(plan.components.has('QspShadowOrder')).toBe(true);
                expect(plan.components.has('QspShadowCustomer')).toBe(true);

                const queries = [
                    () => new Query().with(QspShadowOrder, Query.filters(Query.filter('status', '=', 'closed')))
                        .with(QspShadowCustomer).sortBy(QspShadowOrder, 'total', 'DESC').take(50),
                    () => new Query().with(QspShadowOrder, Query.filters(Query.filter('total', '>', 500)))
                        .with(QspShadowCustomer, Query.filters(Query.filter('tier', '=', 'gold'))).take(40),
                    () => new Query().with(QspShadowOrder).with(QspShadowCustomer)
                        .sortByCreatedAt('DESC').take(60),
                ];
                for (const make of queries) await make().exec();

                await drainShadows();

                // `total` is numeric — PG returns it as a string over the wire. If coerce did not
                // Number() it, every row would report a type-only divergence here.
                if (qspPlannerMetrics.hydrationDivergenceTotal !== 0) {
                    console.error('QSP hydration divergences:', qspPlannerMetrics.hydrationDivergenceByArchetype);
                }
                expect(qspPlannerMetrics.hydrationRowsCompared).toBeGreaterThan(0);
                expect(qspPlannerMetrics.hydrationDivergenceTotal).toBe(0);
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE_SHADOW;
            }
        }, 120_000);

        test('hydration shadow stays off by default and never feeds shadow promotion counters', async () => {
            resetQspPlannerMetrics();
            delete process.env.BUNSANE_QSP_HYDRATE_SHADOW;
            await new Query().with(QspShadowOrder).with(QspShadowCustomer).take(20).exec();
            await drainShadows();
            expect(qspPlannerMetrics.hydrationRowsCompared).toBe(0);
            // id-parity still ran — the two signals are independent.
            expect(qspPlannerMetrics.shadowComparedTotal).toBeGreaterThan(0);
        });

        test('>=100 randomized covered combos: zero shadow divergences', async () => {
            resetQspPlannerMetrics();
            const seed = { s: 7 };
            const pick = <T>(a: T[]): T => a[Math.floor(rnd(seed) * a.length)]!;
            let combos = 0;

            for (let i = 0; i < 140; i++) {
                const orderFilters: any[] = [];
                if (rnd(seed) < 0.7) orderFilters.push(Query.filter('status', pick(['=', '!=']), pick(STATUSES)));
                if (rnd(seed) < 0.6) orderFilters.push(Query.filter('total', pick(['>', '<', '>=', '<=']), Math.floor(rnd(seed) * 1000)));
                if (rnd(seed) < 0.3) orderFilters.push(Query.filter('status', 'IN', [pick(STATUSES), pick(STATUSES)]));
                const custFilters: any[] = [];
                if (rnd(seed) < 0.6) custFilters.push(Query.filter('tier', '=', pick(TIERS)));
                if (rnd(seed) < 0.2) custFilters.push(Query.filter('tier', 'IN', [pick(TIERS), pick(TIERS)]));

                const sortKind = Math.floor(rnd(seed) * 4);
                const dir = rnd(seed) < 0.5 ? 'ASC' : 'DESC';
                const takeN = 10 + Math.floor(rnd(seed) * 40);

                let q = new Query()
                    .with(QspShadowOrder, orderFilters.length ? Query.filters(...orderFilters) : undefined)
                    .with(QspShadowCustomer, custFilters.length ? Query.filters(...custFilters) : undefined);
                if (sortKind === 0) q = q.sortBy(QspShadowOrder, 'total', dir);
                else if (sortKind === 1) q = q.sortBy(QspShadowCustomer, 'tier', dir);
                else if (sortKind === 2) q = q.sortByCreatedAt(dir);
                else q = q.sortByUpdatedAt(dir);
                q = q.take(takeN);

                const res = SurfacePlanner.instance.resolve(reqOf(q));
                if (res.surface !== 'rm') continue; // only covered queries are shadow-compared
                combos++;
                await q.exec(); // legacy served + shadow rm_ fired
            }

            await drainShadows();
            expect(combos).toBeGreaterThanOrEqual(100);
            expect(qspPlannerMetrics.shadowComparedTotal).toBeGreaterThanOrEqual(combos);
            if (qspPlannerMetrics.shadowDivergenceTotal !== 0) {
                // Surface the first divergence to make failures debuggable.
                console.error('QSP divergences:', JSON.stringify(qspPlannerMetrics.lastDivergences.slice(0, 3), null, 2));
            }
            expect(qspPlannerMetrics.shadowDivergenceTotal).toBe(0);
        }, 180_000);
    });
}

if (isPGlite) {
    describe.skip('QSP shadow parity (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
