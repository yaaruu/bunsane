// QSP autopilot lifecycle (real PostgreSQL). Single knob BUNSANE_QSP=route drives the full
// NONE -> BACKFILLING -> SHADOW -> READY auto-projection with no explicit archetype list.
// Guard module-top env writes so nothing leaks into the shared PGlite process (skipIf isPGlite).
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP = 'route';
    process.env.BUNSANE_QSP_PROMOTE_MIN = '5';
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
    // Autopilot relies on "all archetypes in scope" (empty = all). Clear any scope limiter a
    // sibling QSP test file left in the shared bun process, else our archetypes fall out of scope.
    delete process.env.BUNSANE_QSP_ARCHETYPES;
}

import 'reflect-metadata';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../database';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { Query } from '../../query/Query';
import { ProjectionManager, rmTableName, assertRmTableName } from '../../database/projection';
import { PlannerCache, drainShadows } from '../../query/planner';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

if (!isPGlite) {
    @Component
    class AutoOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
    }
    @ArcheType({ name: 'QspAutoArchetype' })
    class QspAutoArchetype extends BaseArcheType {
        @ArcheTypeField(AutoOrder) order!: AutoOrder;
    }
    @Component
    class RuntimeItem extends BaseComponent {
        @CompData({ indexed: true }) kind!: string;
        @CompData() qty!: number;
    }
    @ArcheType({ name: 'QspRuntimeArchetype' })
    class QspRuntimeArchetype extends BaseArcheType {
        @ArcheTypeField(RuntimeItem) item!: RuntimeItem;
    }

    async function waitForStatus(archetype: string, target: string, timeoutMs = 30000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (ProjectionManager.instance.getStatus(archetype) === target) return true;
            await sleep(50);
        }
        return false;
    }

    describe('QSP autopilot lifecycle (real PG)', () => {
        // Seed entities are UNTRACKED (Entity.Create) so createTestContext afterEach never touches them.
        createTestContext();
        const archetypeName = 'QspAutoArchetype';
        const rtName = 'QspRuntimeArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const rtTable = assertRmTableName(rmTableName(rtName));

        beforeAll(async () => {
            await ensureComponentsRegistered(AutoOrder, RuntimeItem);
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_PROMOTE_MIN = '5';
            delete process.env.BUNSANE_QSP_ARCHETYPES;

            await db`CREATE TABLE IF NOT EXISTS projection_state (
                archetype text PRIMARY KEY, shape_hash text NOT NULL,
                status text NOT NULL DEFAULT 'DISABLED', shape_version int NOT NULL DEFAULT 1,
                watermark uuid, field_state jsonb NOT NULL DEFAULT '{}',
                updated_at timestamptz NOT NULL DEFAULT now()
            );`;
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db.unsafe(`DROP TABLE IF EXISTS ${rtTable}`);
            await db.unsafe(`DELETE FROM projection_state WHERE archetype IN ($1, $2)`, [archetypeName, rtName]);

            ProjectionManager.reset();
            PlannerCache.reset();

            // Seed with NO projection (status NONE) - rows land only in `components`.
            for (let i = 0; i < 120; i++) {
                const e = Entity.Create();
                e.add(AutoOrder, { status: (['open', 'closed', 'shipped'] as const)[i % 3]!, total: (i * 7) % 500 });
                await e.save();
            }
        }, 120000);

        afterAll(async () => {
            await drainShadows();
            ProjectionManager.reset();
            PlannerCache.reset();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db.unsafe(`DROP TABLE IF EXISTS ${rtTable}`);
        });

        const makeCovered = () => new Query()
            .with(AutoOrder, Query.filters(Query.filter('status', '=', 'open')))
            .sortBy(AutoOrder, 'total', 'ASC')
            .take(50);

        test('NONE -> BACKFILLING -> SHADOW -> READY auto-promote; served from rm_ == legacy', async () => {
            process.env.BUNSANE_QSP = 'route';
            // NONE: no projection_state row yet.
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('DISABLED');

            // First covered query serves legacy AND fires the lazy trigger.
            const q0 = makeCovered();
            const legacyIds = (await q0.exec()).map(e => e.id);
            expect(q0.getLastRouteInfo().routed).toBe(false);

            // Trigger drove NONE -> BACKFILLING -> (backfill drains) -> SHADOW.
            expect(await waitForStatus(archetypeName, 'SHADOW', 30000)).toBe(true);
            await PlannerCache.instance.refresh();

            // Drive >= PROMOTE_MIN clean covered queries (route mode + SHADOW => serve legacy + shadow-compare).
            for (let i = 0; i < 8; i++) {
                await makeCovered().exec();
            }
            await drainShadows(); // shadow compares + auto-promotion complete

            expect(await waitForStatus(archetypeName, 'READY', 30000)).toBe(true);
            await PlannerCache.instance.refresh();

            // Now the covered query is served from rm_ and matches legacy exactly.
            const qR = makeCovered();
            const routedIds = (await qR.exec()).map(e => e.id);
            expect(qR.getLastRouteInfo().routed).toBe(true);
            expect(qR.getLastRouteInfo().surface).toBe('rm');
            expect(qR.getLastRouteInfo().archetype).toBe(archetypeName);
            expect(routedIds).toEqual(legacyIds);
        }, 120000);

        test('runtime-defined archetype auto-projects on first covered query', async () => {
            process.env.BUNSANE_QSP = 'route';
            for (let i = 0; i < 90; i++) {
                const e = Entity.Create();
                e.add(RuntimeItem, { kind: (['a', 'b', 'c'] as const)[i % 3]!, qty: i });
                await e.save();
            }
            const makeRt = () => new Query()
                .with(RuntimeItem, Query.filters(Query.filter('kind', '=', 'a')))
                .sortBy(RuntimeItem, 'qty', 'ASC')
                .take(50);

            const q0 = makeRt();
            const legacyIds = (await q0.exec()).map(e => e.id);
            expect(q0.getLastRouteInfo().routed).toBe(false);

            expect(await waitForStatus(rtName, 'SHADOW', 30000)).toBe(true);
            await PlannerCache.instance.refresh();
            for (let i = 0; i < 8; i++) { await makeRt().exec(); }
            await drainShadows();
            expect(await waitForStatus(rtName, 'READY', 30000)).toBe(true);
            await PlannerCache.instance.refresh();

            const qR = makeRt();
            const routedIds = (await qR.exec()).map(e => e.id);
            expect(qR.getLastRouteInfo().routed).toBe(true);
            expect(routedIds).toEqual(legacyIds);
        }, 120000);

        test('BUNSANE_QSP=shadow never promotes (stays SHADOW)', async () => {
            process.env.BUNSANE_QSP = 'shadow';
            await ProjectionManager.instance.setStatus(archetypeName, 'SHADOW');
            await PlannerCache.instance.refresh();
            for (let i = 0; i < 10; i++) { await makeCovered().exec(); }
            await drainShadows();
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');
            const q = makeCovered();
            await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(false);
            process.env.BUNSANE_QSP = 'route';
        }, 60000);

        test('rollback: BUNSANE_QSP=off serves legacy (routed=false)', async () => {
            process.env.BUNSANE_QSP = 'route';
            await ProjectionManager.instance.setStatus(archetypeName, 'READY');
            await PlannerCache.instance.refresh();
            const qOn = makeCovered();
            await qOn.exec();
            expect(qOn.getLastRouteInfo().routed).toBe(true);

            process.env.BUNSANE_QSP = 'off';
            const q = makeCovered();
            await q.exec();
            expect(q.getLastRouteInfo().routed).toBe(false);

            process.env.BUNSANE_QSP = 'route'; // restore for afterAll
        }, 60000);
    });
}

if (isPGlite) {
    describe.skip('QSP autopilot (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
