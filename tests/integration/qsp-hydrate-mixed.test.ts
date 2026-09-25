// QSP Fix A — PARTIAL row hydration (real PostgreSQL).
//
// The other QSP fixtures are all-scalar, so every component hydrates and the populate delta is
// always empty. This file covers the case that actually exercises the delta logic: an archetype
// containing one fully-columnar component AND one MIXED component (a scalar plus an arrayOf
// field, which projection skips). The mixed component passes component-SET coverage — so the
// query still routes — but has no column for its array field and must therefore keep coming
// from `components` while its neighbour is served from the rm_ row.
//
// Also covers the FILLING degrade and eager-load composition on a routed query.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_ARCHETYPES = 'QspMixedArchetype';
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
    process.env.BUNSANE_QSP = 'route';
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
import { PlannerCache } from '../../query/planner';
import { resolveHydrationPlan, resetHydrationPlanCache } from '../../query/planner/RmHydrationPlan';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    /** Fully columnar — every field projects, so it can be served from the row. */
    @Component
    class QspMixedScalar extends BaseComponent {
        @CompData({ indexed: true }) tier!: string;
        @CompData() score!: number;
    }
    /** MIXED — `labels` is an array, so it gets no column and the component is not hydratable. */
    @Component
    class QspMixedNote extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData({ arrayOf: String }) labels!: string[];
    }
    /** Never part of the archetype — used to drive eagerLoadComponents. */
    @Component
    class QspMixedExtra extends BaseComponent {
        @CompData() memo!: string;
    }
    @ArcheType({ name: 'QspMixedArchetype' })
    class QspMixedArchetype extends BaseArcheType {
        @ArcheTypeField(QspMixedScalar) scalar!: QspMixedScalar;
        @ArcheTypeField(QspMixedNote) note!: QspMixedNote;
    }
    void QspMixedArchetype;

    const TIERS = ['bronze', 'silver', 'gold'];
    const STATUSES = ['open', 'closed'];

    describe('QSP partial row hydration (real PG)', () => {
        createTestContext();
        const archetypeName = 'QspMixedArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const scalarTypeId = () => new QspMixedScalar().getTypeID();
        const noteTypeId = () => new QspMixedNote().getTypeID();

        beforeAll(async () => {
            await ensureComponentsRegistered(QspMixedScalar, QspMixedNote, QspMixedExtra);
            process.env.BUNSANE_QSP_ARCHETYPES = archetypeName;
            process.env.BUNSANE_QSP = 'route';

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
            resetHydrationPlanCache();
            await ProjectionManager.instance.initialize();

            for (let i = 0; i < 120; i++) {
                const e = Entity.Create();
                e.add(QspMixedScalar, { tier: TIERS[i % TIERS.length], score: i });
                e.add(QspMixedNote, {
                    status: STATUSES[i % STATUSES.length],
                    labels: [`l${i % 3}`, `m${i % 5}`], // the field with no rm_ column
                });
                e.add(QspMixedExtra, { memo: `memo-${i}` });
                await e.save();
            }

            await runBackfill(archetypeName);
            await ProjectionManager.instance.setStatus(archetypeName, 'READY');
            await PlannerCache.instance.refresh();
        }, 180_000);

        afterAll(async () => {
            delete process.env.BUNSANE_QSP_HYDRATE;
            ProjectionManager.reset();
            PlannerCache.reset();
            resetHydrationPlanCache();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        });

        /**
         * Statements reading component data, captured with their SQL so we can tell WHICH
         * component was fetched. Matches the parent `components` table and the per-component
         * partitions (`components_<name>`) — a single-type delta uses the direct partition, so
         * a parent-table-only matcher would report zero reads and look like a passing no-op.
         */
        async function captureComponentReads(fn: () => Promise<any>): Promise<string[]> {
            await PlannerCache.instance.refresh();
            const realUnsafe = (db as any).unsafe.bind(db);
            const seen: string[] = [];
            (db as any).unsafe = (sql: string, ...rest: any[]) => {
                // Params are captured alongside the SQL: a multi-type fetch hits the parent
                // `components` table and passes type_ids as bind params, so the SQL text alone
                // cannot tell you which component was read.
                if (/\bFROM\s+components/i.test(sql)) seen.push(`${sql} -- params:${JSON.stringify(rest)}`);
                return realUnsafe(sql, ...rest);
            };
            try {
                await fn();
            } finally {
                (db as any).unsafe = realUnsafe;
            }
            return seen;
        }

        /** A component is fetched either by type_id param or via its dedicated partition table. */
        const fetches = (sql: string, componentName: string, typeId: string): boolean =>
            sql.toLowerCase().includes(`components_${componentName.toLowerCase()}`) || sql.includes(typeId);

        test('the mixed component is excluded from the plan while its neighbour is included', () => {
            const descriptor = ProjectionManager.instance.getDescriptor(archetypeName)!;
            const plan = resolveHydrationPlan(archetypeName, descriptor,
                PlannerCache.instance.getState(archetypeName)?.fieldState ?? {});
            expect(plan.components.has('QspMixedScalar')).toBe(true);
            expect(plan.components.has('QspMixedNote')).toBe(false);
        });

        test('partial hydration: row serves the columnar component, components serves the mixed one', async () => {
            const makeQuery = () => new Query()
                .with(QspMixedScalar, Query.filters(Query.filter('tier', '=', 'gold')))
                .with(QspMixedNote)
                .populate()
                .take(20);

            process.env.BUNSANE_QSP = 'off';
            const legacy = await makeQuery().exec();
            expect(legacy.length).toBeGreaterThan(0);

            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';
            let routed: Entity[] = [];
            let reads: string[] = [];
            try {
                const q = makeQuery();
                reads = await captureComponentReads(async () => { routed = await q.exec(); });
                expect(q.getLastRouteInfo().routed).toBe(true);
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }

            expect(routed.map(e => e.id)).toEqual(legacy.map(e => e.id));

            // The delta is NOT empty here — the mixed component still needs a real fetch...
            expect(reads.length).toBeGreaterThan(0);
            const deltaSql = reads.join('\n');
            // ...but that fetch must be restricted to the mixed component only. If the delta
            // were ignored, the fully-columnar component would be re-read and would OVERWRITE
            // the row-hydrated objects — the no-op failure mode Fix A exists to avoid.
            expect(fetches(deltaSql, 'QspMixedNote', noteTypeId())).toBe(true);
            expect(fetches(deltaSql, 'QspMixedScalar', scalarTypeId())).toBe(false);

            for (let i = 0; i < legacy.length; i++) {
                const ls: any = legacy[i]!.getInMemory(QspMixedScalar as any);
                const rs: any = routed[i]!.getInMemory(QspMixedScalar as any);
                const ln: any = legacy[i]!.getInMemory(QspMixedNote as any);
                const rn: any = routed[i]!.getInMemory(QspMixedNote as any);

                // Served from the row.
                expect(rs.tier).toBe(ls.tier);
                expect(rs.score).toBe(ls.score);
                expect(typeof rs.score).toBe('number');
                expect(rs.id).toBe(ls.id);

                // Served from `components` — including the array field that has no rm_ column.
                // This is the F1 guarantee: a mixed component is never silently served without it.
                expect(rn.status).toBe(ln.status);
                expect(rn.labels).toEqual(ln.labels);
                expect(Array.isArray(rn.labels)).toBe(true);
                expect(rn.labels.length).toBeGreaterThan(0);
                expect(rn.id).toBe(ln.id);
            }
        });

        test('eagerLoadComponents still loads a non-projected component on a hydrated query', async () => {
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';
            try {
                const q = new Query()
                    .with(QspMixedScalar, Query.filters(Query.filter('tier', '=', 'silver')))
                    .with(QspMixedNote)
                    .eagerLoadComponents([QspMixedExtra as any])
                    .take(10);
                const routed = await q.exec();
                expect(q.getLastRouteInfo().routed).toBe(true);
                expect(routed.length).toBeGreaterThan(0);
                for (const e of routed) {
                    // QspMixedExtra is not in the archetype and has no rm_ column at all.
                    expect((e as any).getInMemory(QspMixedExtra as any).memo).toMatch(/^memo-/);
                }
            } finally {
                delete process.env.BUNSANE_QSP_HYDRATE;
            }
        });

        test('F3: a FILLING column drops its component from hydration but still routes', async () => {
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_HYDRATE = 'on';
            try {
                await db.unsafe(
                    `UPDATE projection_state SET field_state = $1 WHERE archetype = $2`,
                    [JSON.stringify({ qsp_mixed_scalar_tier: 'FILLING' }), archetypeName]
                );
                PlannerCache.instance.invalidate(archetypeName);
                await PlannerCache.instance.refresh();
                resetHydrationPlanCache();

                // field_state must reach the planner as a parsed OBJECT. If it arrives as a JSON
                // string every key lookup returns undefined and the gate silently passes.
                const fs = PlannerCache.instance.getState(archetypeName)?.fieldState;
                expect(typeof fs).toBe('object');
                expect(fs!['qsp_mixed_scalar_tier']).toBe('FILLING');

                const q = new Query()
                    .with(QspMixedScalar, Query.filters(Query.filter('score', '>', 5)))
                    .with(QspMixedNote)
                    .populate()
                    .take(10);
                let routed: Entity[] = [];
                const reads = await captureComponentReads(async () => { routed = await q.exec(); });

                // Still routed — a FILLING hydration column degrades hydration, not routing.
                expect(q.getLastRouteInfo().routed).toBe(true);
                // And the component came from `components` instead of the mid-backfill column.
                expect(fetches(reads.join('\n'), 'QspMixedScalar', scalarTypeId())).toBe(true);
                for (const e of routed) {
                    expect((e as any).getInMemory(QspMixedScalar as any).tier).toBeDefined();
                }
            } finally {
                await db.unsafe(
                    `UPDATE projection_state SET field_state = '{}'::jsonb WHERE archetype = $1`,
                    [archetypeName]
                );
                PlannerCache.instance.invalidate(archetypeName);
                await PlannerCache.instance.refresh();
                resetHydrationPlanCache();
                delete process.env.BUNSANE_QSP_HYDRATE;
            }
        });
    });
}

if (isPGlite) {
    describe.skip('QSP partial row hydration (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
