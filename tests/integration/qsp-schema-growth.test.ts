// Ticket B7: an existing rm_ table never gained columns (CREATE TABLE IF NOT
// EXISTS is a no-op), so adding a projected field broke every dual-write on
// that archetype until someone ALTERed the table by hand in production.
// information_schema + ALTER TABLE are real-PG territory; skipped on PGlite.
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
}

import 'reflect-metadata';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../database';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import {
    deriveProjectionDescriptor,
    createRmTable,
    rmTableName,
    assertRmTableName,
    syncRmSchema,
    existingRmColumns,
} from '../../database/projection';
import { ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspGrowOrder extends BaseComponent {
        @CompData({ indexed: true }) status!: string;
        @CompData() total!: number;
        // The "new field" — deployed after the rm_ table already existed.
        @CompData() clientRequestId!: string;
    }

    @ArcheType({ name: 'QspGrowArchetype' })
    class QspGrowArchetype extends BaseArcheType {
        @ArcheTypeField(QspGrowOrder) order!: QspGrowOrder;
    }

    describe('QSP schema growth (B7)', () => {
        const archetypeName = 'QspGrowArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const newColumn = 'qsp_grow_order_client_request_id';

        beforeAll(async () => {
            await ensureComponentsRegistered(QspGrowOrder);
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

            const descriptor = deriveProjectionDescriptor(archetypeName);
            // Simulate the pre-growth table: same archetype minus the new field.
            const oldColumns = descriptor.columns.filter(col => col.columnName !== newColumn);
            expect(oldColumns.length).toBe(descriptor.columns.length - 1);
            await createRmTable(archetypeName, oldColumns);
            await db.unsafe(
                `INSERT INTO projection_state (archetype, shape_hash, status, shape_version)
                 VALUES ($1, $2, 'READY', $3)`,
                [archetypeName, 'stale-hash', descriptor.shapeVersion]
            );
        });

        afterAll(async () => {
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);
        });

        test('createRmTable alone does NOT add the new column (the original bug)', async () => {
            const descriptor = deriveProjectionDescriptor(archetypeName);
            await createRmTable(archetypeName, descriptor.columns); // IF NOT EXISTS → no-op
            const columns = await existingRmColumns(archetypeName);
            expect(columns.has(newColumn)).toBe(false);
        });

        test('syncRmSchema adds the column, marks it FILLING, then fills to READY', async () => {
            const descriptor = deriveProjectionDescriptor(archetypeName);

            // A pre-existing row: it must survive the ALTER and get filled.
            const entityId = crypto.randomUUID();
            await db.unsafe(
                `INSERT INTO ${tableName} (entity_id, qsp_grow_order_status, qsp_grow_order_total,
                                           created_at, updated_at, shape_version)
                 VALUES ($1, 'open', 10, now(), now(), 1)`,
                [entityId]
            );

            // fill:false so the FILLING window is observable before the fill runs.
            const added = await syncRmSchema(archetypeName, descriptor, { fill: false });
            expect(added.map(col => col.columnName)).toEqual([newColumn]);

            const columns = await existingRmColumns(archetypeName);
            expect(columns.has(newColumn)).toBe(true);

            const state = await db.unsafe(
                `SELECT field_state, shape_hash FROM projection_state WHERE archetype = $1`,
                [archetypeName]
            );
            const fieldState = typeof state[0].field_state === 'string'
                ? JSON.parse(state[0].field_state)
                : state[0].field_state;
            // FILLING keeps the planner off the NULL column instead of serving it as data.
            expect(fieldState[newColumn]).toBe('FILLING');
            expect(state[0].shape_hash).toBe(descriptor.shapeHash);

            const { fillColumns } = await import('../../database/projection/SchemaSync');
            await fillColumns(archetypeName, added);

            const after = await db.unsafe(
                `SELECT field_state FROM projection_state WHERE archetype = $1`,
                [archetypeName]
            );
            const afterState = typeof after[0].field_state === 'string'
                ? JSON.parse(after[0].field_state)
                : after[0].field_state;
            expect(afterState[newColumn]).toBe('READY');

            const rows = await db.unsafe(`SELECT * FROM ${tableName} WHERE entity_id = $1`, [entityId]);
            expect(rows.length).toBe(1);
            expect(rows[0].qsp_grow_order_status).toBe('open');
        });

        test('syncRmSchema is a no-op once the shape matches', async () => {
            const descriptor = deriveProjectionDescriptor(archetypeName);
            const added = await syncRmSchema(archetypeName, descriptor);
            expect(added).toEqual([]);
        });
    });
}
