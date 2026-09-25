// QSP Phase P4 — route-mode parity gate (real PostgreSQL).
// Serves rm_ for READY covered archetypes; compares SERVED-routed vs SERVED-legacy
// by flipping BUNSANE_QSP at call time (Query.ts reads env inside the function).
// NOTE: env is set at top; despite ES import hoisting, mode is re-read per call.
// Guard module-top env writes so BUNSANE_QSP does not leak into the shared
// bun-test process under PGlite (this describe is skipIf(isPGlite); on real PG the env
// is set normally). Without the guard, a real App boot in another test file runs
// InitializeProjections() under PGlite's single connection and wedges the whole run.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_ARCHETYPES = 'QspRouteArchetype';
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
    qspPlannerMetrics, resetQspPlannerMetrics,
} from '../../query/planner';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspRouteOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
    }
    @Component
    class QspRouteCustomer extends BaseComponent {
        @CompData({ indexed: true }) tier!: string;
    }
    /** Non-projected component used only for uncovered .without() fallback cases. */
    @Component
    class QspRouteOther extends BaseComponent {
        @CompData() note!: string;
    }
    @ArcheType({ name: 'QspRouteArchetype' })
    class QspRouteArchetype extends BaseArcheType {
        @ArcheTypeField(QspRouteOrder) order!: QspRouteOrder;
        @ArcheTypeField(QspRouteCustomer) customer!: QspRouteCustomer;
    }

    const STATUSES = ['open', 'closed', 'gold', 'pending'];
    const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
    // Deterministic LCG so the randomized suite is reproducible.
    const rnd = (seed: { s: number }) => {
        seed.s = (seed.s * 1103515245 + 12345) & 0x7fffffff;
        return seed.s / 0x7fffffff;
    };

    describe('QSP route parity (real PG)', () => {
        // NOTE: seed entities are created UNTRACKED (Entity.Create(), not ctx.tracker.create())
        // so the per-test afterEach cleanup neither deletes the shared dataset between tests nor
        // times out deleting thousands of rows. The ephemeral scratch DB is dropped by pg-setup.
        createTestContext(); // cache + EntityManager readiness hooks only
        const archetypeName = 'QspRouteArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const allEntities: Entity[] = [];
        /** Entities seeded with a known unique status for hasNextPage boundary tests. */
        const BOUNDARY_STATUS = 'route_boundary';
        const BOUNDARY_COUNT = 17;

        beforeAll(async () => {
            await ensureComponentsRegistered(QspRouteOrder, QspRouteCustomer, QspRouteOther);
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
            // Operator-disabled start: an existing DISABLED row is kept by initialize(), so
            // seeding below skips dual-write and the explicit runBackfill rebuilds rm_.
            await db.unsafe(`INSERT INTO projection_state (archetype, shape_hash, status) VALUES ($1, '', 'DISABLED')`, [archetypeName]);

            ProjectionManager.reset();
            await ProjectionManager.instance.initialize(); // creates rm_ table + covering index, status DISABLED

            // Phase A: seed with dual-write OFF (DISABLED) → rows land only in `components`.
            const seed = { s: 99 };
            const N_A = 2500;
            for (let i = 0; i < N_A; i++) {
                const e = Entity.Create();
                e.add(QspRouteOrder, { status: STATUSES[i % STATUSES.length], total: Math.floor(rnd(seed) * 1000) });
                e.add(QspRouteCustomer, { tier: TIERS[i % TIERS.length] });
                await e.save();
                allEntities.push(e);
            }

            // Backfill reconstructs rm_ from components → READY.
            await runBackfill(archetypeName);
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');
            await ProjectionManager.instance.setStatus(archetypeName, 'READY');
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('READY');

            // Phase B: live dual-write path (status READY) — exercises upsert + timestamp parity.
            const N_B = 400;
            for (let i = 0; i < N_B; i++) {
                const e = Entity.Create();
                e.add(QspRouteOrder, { status: STATUSES[(i + 1) % STATUSES.length], total: Math.floor(rnd(seed) * 1000) });
                e.add(QspRouteCustomer, { tier: TIERS[(i + 2) % TIERS.length] });
                await e.save();
                allEntities.push(e);
            }

            // Update a subset — exercises upsert + updated_at mirror of entities.updated_at.
            // Runs before the boundary set so we never overwrite BOUNDARY_STATUS rows.
            for (let i = 0; i < 150; i++) {
                const e = allEntities[(i * 10) % allEntities.length]!;
                await e.set(QspRouteOrder, { status: 'closed', total: Math.floor(rnd(seed) * 1000) });
                await e.save();
            }

            // Boundary set: exact M entities with a unique status for hasNextPage checks
            // (seeded last so nothing mutates them).
            for (let i = 0; i < BOUNDARY_COUNT; i++) {
                const e = Entity.Create();
                e.add(QspRouteOrder, { status: BOUNDARY_STATUS, total: 100 + i });
                e.add(QspRouteCustomer, { tier: 'bronze' });
                await e.save();
                allEntities.push(e);
            }

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

        /**
         * Compare SERVED legacy (mode off) vs SERVED route (mode route) for the same shape.
         * Asserts rm_ actually served (getLastRouteInfo().routed) and id-sets match.
         */
        async function routedParity(makeQuery: () => Query<any>) {
            process.env.BUNSANE_QSP = 'off';
            const legacyIds = (await makeQuery().exec()).map(e => e.id);
            process.env.BUNSANE_QSP = 'route';
            const q = makeQuery();
            const routedIds = (await q.exec()).map(e => e.id);
            expect(q.getLastRouteInfo().routed).toBe(true);
            expect(routedIds).toEqual(legacyIds);
            return { legacyIds, routedIds };
        }

        // --- Fix A: row hydration (BUNSANE_QSP_HYDRATE) ---------------------------------

        /**
         * Count statements that read `components` while running `fn`. This is the acceptance
         * criterion for Fix A: hydration is pointless unless it removes these.
         */
        async function countComponentReads(fn: () => Promise<any>): Promise<{ components: number; total: number }> {
            await PlannerCache.instance.refresh(); // settle cache traffic before counting
            const realUnsafe = (db as any).unsafe.bind(db);
            let components = 0;
            let total = 0;
            (db as any).unsafe = (sql: string, ...rest: any[]) => {
                total++;
                // Parent table or a partition leaf (`components_<type>`): populate() reads leaves.
                if (/\bFROM\s+components(?:_\w+)?\b/i.test(sql)) components++;
                return realUnsafe(sql, ...rest);
            };
            try {
                await fn();
            } finally {
                (db as any).unsafe = realUnsafe;
            }
            return { components, total };
        }

        test('hydration removes the components re-read that populate() would issue', async () => {
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'closed')))
                .with(QspRouteCustomer)
                .populate()
                .take(50);

            process.env.BUNSANE_QSP = 'route';

            delete process.env.BUNSANE_QSP_HYDRATE;
            const off = await countComponentReads(() => makeQuery().exec());

            process.env.BUNSANE_QSP_HYDRATE = 'on';
            try {
                const on = await countComponentReads(() => makeQuery().exec());

                // Off: rm_ gives ids, then populate() re-reads every component from `components`.
                expect(off.components).toBeGreaterThan(0);
                // On: the row already carries them — nothing left to fetch.
                expect(on.components).toBe(0);
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }
        });

        test('hydrated entities are indistinguishable from legacy-loaded ones', async () => {
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'open')))
                .with(QspRouteCustomer)
                .populate()
                .sortBy(QspRouteOrder, 'total', 'DESC')
                .take(25);

            process.env.BUNSANE_QSP = 'off';
            const legacy = await makeQuery().exec();

            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';
            let routed: Entity[];
            try {
                const q = makeQuery();
                routed = await q.exec();
                expect(q.getLastRouteInfo().routed).toBe(true);
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }

            expect(routed.map(e => e.id)).toEqual(legacy.map(e => e.id));
            expect(routed.length).toBeGreaterThan(0);

            for (let i = 0; i < legacy.length; i++) {
                for (const Ctor of [QspRouteOrder, QspRouteCustomer] as any[]) {
                    const l: any = legacy[i]!.getInMemory(Ctor);
                    const r: any = routed[i]!.getInMemory(Ctor);
                    expect(r).toBeDefined();

                    // Real component id — the F2 invariant that makes mutate+save safe.
                    expect(r.id).toBe(l.id);
                    expect(r.id).toMatch(/^[0-9a-f-]{36}$/i);
                    // _persisted/_dirty are protected; read them the same way for both sides.
                    expect(r._persisted).toBe(true);
                    expect(r._dirty).toBe(false);
                    expect(r._persisted).toBe(l._persisted);
                    expect(r._dirty).toBe(l._dirty);
                    expect(r.constructor.name).toBe(l.constructor.name);

                    const ld = l.data();
                    const rd = r.data();
                    for (const key of Object.keys(ld)) {
                        expect(`${key}=${rd[key]}`).toBe(`${key}=${ld[key]}`);
                        // numeric must stay a number — PG returns it as a string over the wire.
                        expect(typeof rd[key]).toBe(typeof ld[key]);
                    }
                }
            }
        });

        test('mutate-and-save on a hydrated entity keeps exactly ONE components row per type', async () => {
            // The F2 guard. A hydrated component carrying no real id would take the insert
            // branch, mint a fresh uuid, miss the (id, type_id) conflict target, and duplicate
            // its components row permanently — silent, unrecoverable read corruption.
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';

            let target: Entity;
            try {
                const routed = await new Query()
                    .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'pending')))
                    .with(QspRouteCustomer)
                    .populate()
                    .take(1)
                    .exec();
                expect(routed.length).toBe(1);
                target = routed[0]!;

                await target.set(QspRouteOrder, { status: 'pending', total: 4242 });
                await target.save();
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }

            const typeId = new QspRouteOrder().getTypeID();
            const rows: any[] = await db.unsafe(
                `SELECT count(*)::int AS n FROM components
                 WHERE entity_id = $1 AND type_id = $2 AND deleted_at IS NULL`,
                [target.id, typeId]
            );
            expect(rows[0].n).toBe(1);

            // And the write landed on that row, rather than in a phantom duplicate.
            const dataRows: any[] = await db.unsafe(
                `SELECT data FROM components
                 WHERE entity_id = $1 AND type_id = $2 AND deleted_at IS NULL`,
                [target.id, typeId]
            );
            const saved = typeof dataRows[0].data === 'string' ? JSON.parse(dataRows[0].data) : dataRows[0].data;
            expect(saved.total).toBe(4242);
        });

        // NOTE: eagerLoadComponents composition and the partial (non-empty) populate delta are
        // covered in qsp-hydrate-mixed.test.ts — this archetype is all-scalar, so every
        // component hydrates and the delta here is always empty.
        test('both projected components are served from the row on a routed query', async () => {
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';
            try {
                const q = new Query()
                    .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'gold')))
                    .with(QspRouteCustomer)
                    .populate()
                    .take(5);
                const routed = await q.exec();
                expect(q.getLastRouteInfo().routed).toBe(true);
                expect(routed.length).toBeGreaterThan(0);
                // Both projected components present and fully populated from the row.
                for (const e of routed) {
                    expect((e as any).getInMemory(QspRouteOrder).status).toBe('gold');
                    expect((e as any).getInMemory(QspRouteCustomer).tier).toBeDefined();
                }
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }
        });

        test('hydration is OFF by default — routed reads keep re-reading components', async () => {
            delete process.env.BUNSANE_QSP_HYDRATE;
            process.env.BUNSANE_QSP = 'route';
            const stats = await countComponentReads(() => new Query()
                .with(QspRouteOrder).with(QspRouteCustomer).populate().take(20).exec());
            expect(stats.components).toBeGreaterThan(0);
        });

        test('>=1000 randomized covered queries: zero routed-vs-legacy mismatches', async () => {
            resetQspPlannerMetrics();
            const seed = { s: 11 };
            const pick = <T>(a: T[]): T => a[Math.floor(rnd(seed) * a.length)]!;
            let routedCovered = 0;
            let countChecked = 0;
            let mismatches = 0;
            const maxIters = 5000;

            for (let i = 0; i < maxIters && routedCovered < 1000; i++) {
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

                const makeQuery = () => {
                    let q = new Query()
                        .with(QspRouteOrder, orderFilters.length ? Query.filters(...orderFilters) : undefined)
                        .with(QspRouteCustomer, custFilters.length ? Query.filters(...custFilters) : undefined);
                    if (sortKind === 0) q = q.sortBy(QspRouteOrder, 'total', dir);
                    else if (sortKind === 1) q = q.sortBy(QspRouteCustomer, 'tier', dir);
                    else if (sortKind === 2) q = q.sortByCreatedAt(dir);
                    else q = q.sortByUpdatedAt(dir);
                    return q.take(takeN);
                };

                const res = SurfacePlanner.instance.resolve(reqOf(makeQuery()));
                if (res.surface !== 'rm') continue;

                try {
                    await routedParity(makeQuery);
                    routedCovered++;

                    // Subset: exact count parity (mode off → route).
                    if (countChecked < 50) {
                        process.env.BUNSANE_QSP = 'off';
                        const legacyCount = await makeQuery().count();
                        process.env.BUNSANE_QSP = 'route';
                        const routedCount = await makeQuery().count();
                        expect(routedCount).toBe(legacyCount);
                        countChecked++;
                    }
                } catch (err) {
                    mismatches++;
                    console.error('QSP route parity mismatch at combo', routedCovered, err);
                    throw err;
                }
            }

            expect(routedCovered).toBeGreaterThanOrEqual(1000);
            expect(mismatches).toBe(0);
            expect(countChecked).toBeGreaterThan(0);
        }, 300_000);

        test('rm_ actually used: getLastRouteInfo + EXPLAIN index scan', async () => {
            process.env.BUNSANE_QSP = 'route';
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(
                    Query.filter('status', '=', 'open'),
                    Query.filter('total', '>=', 200),
                ))
                .with(QspRouteCustomer, Query.filters(Query.filter('tier', '=', 'silver')))
                .sortBy(QspRouteOrder, 'total', 'DESC')
                .take(20);

            const q = makeQuery();
            await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(true);
            expect(q.getLastRouteInfo().surface).toBe('rm');
            expect(q.getLastRouteInfo().archetype).toBe(archetypeName);

            const req = reqOf(makeQuery());
            const res = SurfacePlanner.instance.resolve(req);
            expect(res.surface).toBe('rm');
            const { sql, params } = buildRmQuery(res.archetype!, req);

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

        test('read-after-write: dual-write visible on routed surface (I2)', async () => {
            process.env.BUNSANE_QSP = 'route';
            const uniqueStatus = `raw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

            const e = Entity.Create();
            e.add(QspRouteOrder, { status: uniqueStatus, total: 42 });
            e.add(QspRouteCustomer, { tier: 'bronze' });
            await e.save();
            allEntities.push(e);

            const q = new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', uniqueStatus)))
                .with(QspRouteCustomer)
                .take(10);
            const rows = await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(true);
            expect(rows.map(r => r.id)).toContain(e.id);
        });

        test('keyset / hasNextPage boundary + keyset page continuity', async () => {
            process.env.BUNSANE_QSP = 'route';
            const M = BOUNDARY_COUNT;
            expect(M).toBeGreaterThan(1);

            // take(M) → hasNextPage false (fetched M+1, only M exist)
            const qFull = new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(M);
            const fullRows = await qFull.exec();
            expect(fullRows.length).toBe(M);
            expect(qFull.getLastRouteInfo().routed).toBe(true);
            expect(qFull.getLastRouteInfo().hasNextPage).toBe(false);

            // take(M-1) → hasNextPage true
            const qPartial = new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(M - 1);
            const partialRows = await qPartial.exec();
            expect(partialRows.length).toBe(M - 1);
            expect(qPartial.getLastRouteInfo().routed).toBe(true);
            expect(qPartial.getLastRouteInfo().hasNextPage).toBe(true);

            // Keyset page: page1 under route, cursor, page2 under route — no overlap, matches legacy.
            const k = 5;
            process.env.BUNSANE_QSP = 'route';
            const page1 = await new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(k)
                .populate()
                .exec();
            expect(page1.length).toBe(k);
            expect(page1[page1.length - 1]).toBeDefined();
            const last = page1[page1.length - 1]!;
            const sortVal = (last as any).componentData['QspRouteOrder'].total;
            const token = Query.encodeSortedCursor(sortVal, last.id);

            const page2 = await new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(k)
                .sortedCursor(token)
                .exec();
            expect(page2.length).toBeGreaterThan(0);
            const page1Ids = new Set(page1.map(e => e.id));
            for (const e of page2) {
                expect(page1Ids.has(e.id)).toBe(false);
            }

            // Legacy baseline for the same pages
            process.env.BUNSANE_QSP = 'off';
            const leg1 = (await new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(k)
                .exec()).map(e => e.id);
            const legLast = leg1[leg1.length - 1]!;
            // Re-fetch sort value for cursor from routed page1 (same ids as legacy page1)
            expect(page1.map(e => e.id)).toEqual(leg1);
            const legToken = Query.encodeSortedCursor(sortVal, legLast);
            const leg2 = (await new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', BOUNDARY_STATUS)))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(k)
                .sortedCursor(legToken)
                .exec()).map(e => e.id);
            expect(page2.map(e => e.id)).toEqual(leg2);
        });

        test('instant rollback: DISABLED stops routing immediately', async () => {
            process.env.BUNSANE_QSP = 'route';
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'open')))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'DESC')
                .take(15);

            // Confirm routing first
            const q1 = makeQuery();
            const routedIds = (await q1.exec()).map(e => e.id);
            expect(q1.getLastRouteInfo().routed).toBe(true);

            process.env.BUNSANE_QSP = 'off';
            const legacyIds = (await makeQuery().exec()).map(e => e.id);
            expect(routedIds).toEqual(legacyIds);

            // Rollback projection → PlannerCache invalidated via setStatus seam
            await ProjectionManager.instance.setStatus(archetypeName, 'DISABLED');
            process.env.BUNSANE_QSP = 'route';
            const q2 = makeQuery();
            const afterIds = (await q2.exec()).map(e => e.id);
            expect(q2.getLastRouteInfo().routed).toBe(false);
            expect(afterIds).toEqual(legacyIds);

            // Restore READY for later tests
            await ProjectionManager.instance.setStatus(archetypeName, 'READY');
            await PlannerCache.instance.refresh();
            const q3 = makeQuery();
            await q3.exec();
            expect(q3.getLastRouteInfo().routed).toBe(true);
        });

        test('transparent fallback (5a): uncovered query serves legacy, no throw', async () => {
            process.env.BUNSANE_QSP = 'off';
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'closed')))
                .with(QspRouteCustomer)
                .without(QspRouteOther) // exclusion → SurfacePlanner → legacy
                .take(20);
            const legacyIds = (await makeQuery().exec()).map(e => e.id);

            process.env.BUNSANE_QSP = 'route';
            const q = makeQuery();
            const ids = (await q.exec()).map(e => e.id);
            expect(q.getLastRouteInfo().routed).toBe(false);
            expect(ids).toEqual(legacyIds);

            const res = SurfacePlanner.instance.resolve(reqOf(makeQuery()));
            expect(res.surface).toBe('legacy');
        });

        test('transparent fallback (5b): forced rm_ error serves legacy, no throw', async () => {
            process.env.BUNSANE_QSP = 'off';
            const makeQuery = () => new Query()
                .with(QspRouteOrder, Query.filters(Query.filter('status', '=', 'open')))
                .with(QspRouteCustomer)
                .sortBy(QspRouteOrder, 'total', 'ASC')
                .take(25);
            const legacyIds = (await makeQuery().exec()).map(e => e.id);

            // Prove it would route before destroying the table
            process.env.BUNSANE_QSP = 'route';
            const qOk = makeQuery();
            await qOk.exec();
            expect(qOk.getLastRouteInfo().routed).toBe(true);

            resetQspPlannerMetrics();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);

            const q = makeQuery();
            const ids = (await q.exec()).map(e => e.id);
            expect(ids).toEqual(legacyIds);
            expect(q.getLastRouteInfo().routed).toBe(false);
            expect(qspPlannerMetrics.fallbackTotal['exec_error'] ?? 0).toBeGreaterThanOrEqual(1);
        });
    });
}

if (isPGlite) {
    describe.skip('QSP route parity (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
