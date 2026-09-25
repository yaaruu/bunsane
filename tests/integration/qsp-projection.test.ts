// Guard module-top env writes so BUNSANE_QSP does not leak into the shared
// bun-test process under PGlite (this describe is skipIf(isPGlite); on real PG the env
// is set normally). Without the guard, a real App boot in another test file runs
// InitializeProjections() under PGlite's single connection and wedges the whole run.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP = 'route';
    process.env.BUNSANE_QSP_ARCHETYPES = 'QspTestArchetype';
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
}

import 'reflect-metadata';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../database';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { ProjectionManager, projectEntity, runBackfill, rmTableName, assertRmTableName } from '../../database/projection';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
    }

    @ArcheType({ name: 'QspTestArchetype' })
    class QspTestArchetype extends BaseArcheType {
        @ArcheTypeField(QspOrder) order!: QspOrder;
    }

    // rm_ covering indexes, advisory-lock backfill, and EXPLAIN assertions are real-PG-only.
    describe('QSP projection dual-write', () => {
        const ctx = createTestContext();
        const archetypeName = 'QspTestArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));

        beforeAll(async () => {
            await ensureComponentsRegistered(QspOrder);
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_ARCHETYPES = archetypeName;
            process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db`CREATE TABLE IF NOT EXISTS projection_state (
                archetype text PRIMARY KEY,
                shape_hash text NOT NULL,
                status text NOT NULL DEFAULT 'DISABLED',
                shape_version int NOT NULL DEFAULT 1,
                watermark uuid,
                field_state jsonb NOT NULL DEFAULT '{}',
                updated_at timestamptz NOT NULL DEFAULT now()
            );`;
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);
            // Operator-disabled start: an existing DISABLED row is kept by initialize(), so
            // seeding below skips dual-write and the explicit runBackfill rebuilds rm_.
            await db.unsafe(`INSERT INTO projection_state (archetype, shape_hash, status) VALUES ($1, '', 'DISABLED')`, [archetypeName]);
            ProjectionManager.reset();
            await ProjectionManager.instance.initialize();
            await runBackfill(archetypeName);
        });

        afterAll(async () => {
            ProjectionManager.reset();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        });

        test('writes projection row on entity save', async () => {
            const entity = ctx.tracker.create();
            entity.add(QspOrder, { status: 'open', total: 123 });
            await entity.save();

            const rows = await db.unsafe(`SELECT * FROM ${tableName} WHERE entity_id = $1`, [entity.id]);
            expect(rows.length).toBe(1);
            const row = rows[0];
            const descriptor = ProjectionManager.instance.getDescriptor(archetypeName)!;
            const projected = projectEntity(entity, descriptor);

            expect(row.qsp_order_status).toBe(projected.qsp_order_status);
            expect(Number(row.qsp_order_total)).toBe(projected.qsp_order_total);
            expect(row.qsp_order_status).toBe('open');
            expect(Number(row.qsp_order_total)).toBe(123);
            expect(row.deleted_at).toBeNull();
        });

        test('soft delete marks projection row deleted', async () => {
            const entity = ctx.tracker.create();
            entity.add(QspOrder, { status: 'soft', total: 45 });
            await entity.save();
            await entity.delete();

            const rows = await db.unsafe(`SELECT deleted_at FROM ${tableName} WHERE entity_id = $1`, [entity.id]);
            expect(rows.length).toBe(1);
            expect(rows[0].deleted_at).not.toBeNull();
        });

        test('force delete removes projection row', async () => {
            const entity = ctx.tracker.create();
            entity.add(QspOrder, { status: 'force', total: 67 });
            await entity.save();
            await entity.delete(true);

            const rows = await db.unsafe(`SELECT * FROM ${tableName} WHERE entity_id = $1`, [entity.id]);
            expect(rows.length).toBe(0);
        });

        test('backfill reconstructs rm_ rows from components for pre-existing entities', async () => {
            // Turn dual-write OFF so these saves land only in `components`, not rm_.
            await ProjectionManager.instance.setStatus(archetypeName, 'DISABLED');

            const ids: string[] = [];
            for (let i = 0; i < 5; i++) {
                const e = ctx.tracker.create();
                e.add(QspOrder, { status: `bf${i}`, total: 200 + i });
                await e.save();
                ids.push(e.id);
            }

            const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
            const before = await db.unsafe(
                `SELECT entity_id FROM ${tableName} WHERE entity_id IN (${placeholders})`,
                ids
            );
            expect(before.length).toBe(0); // dual-write was off → no projection rows yet

            // Backfill reconstructs the projection from the JSONB component rows.
            await runBackfill(archetypeName);
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');

            const after = await db.unsafe(
                `SELECT entity_id, qsp_order_status, qsp_order_total, deleted_at
                 FROM ${tableName} WHERE entity_id IN (${placeholders}) ORDER BY qsp_order_status`,
                ids
            );
            expect(after.length).toBe(5);
            for (let i = 0; i < 5; i++) {
                expect(after[i].qsp_order_status).toBe(`bf${i}`);
                expect(Number(after[i].qsp_order_total)).toBe(200 + i);
                expect(after[i].deleted_at).toBeNull();
            }
        });
    });
}

if (isPGlite) {
    describe.skip('QSP projection dual-write (real-PG only)', () => {
        test('skipped under PGlite', () => {});
    });
}
