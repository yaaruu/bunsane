// Module-top env guard: see qsp-projection.test.ts (PGlite must not see BUNSANE_QSP).
if (process.env.USE_PGLITE !== 'true') {
    process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
}

import 'reflect-metadata';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db from '../../database';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { ProjectionManager, rmTableName, assertRmTableName } from '../../database/projection';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

if (!isPGlite) {
    @Component
    class QspScopedItem extends BaseComponent {
        @CompData({ indexed: true }) label!: string;
    }

    @ArcheType({ name: 'QspScopedArchetype' })
    class QspScopedArchetype extends BaseArcheType {
        @ArcheTypeField(QspScopedItem) item!: QspScopedItem;
    }

    // Scoped rollout (BUNSANE_QSP_ARCHETYPES) used to register the row as
    // DISABLED and never backfill it. Real-PG only, like every rm_ test.
    describe('QSP scoped archetype backfill', () => {
        createTestContext();
        const archetypeName = 'QspScopedArchetype';
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const SEEDED = 30;
        const saved = { qsp: process.env.BUNSANE_QSP, archetypes: process.env.BUNSANE_QSP_ARCHETYPES };

        const status = async (): Promise<string | undefined> => {
            const rows = await db.unsafe(`SELECT status FROM projection_state WHERE archetype = $1`, [archetypeName]);
            return rows[0]?.status;
        };
        const projectedCount = async (): Promise<number> => {
            const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${tableName}`);
            return rows[0].n;
        };
        const boot = async (): Promise<void> => {
            ProjectionManager.reset();
            await ProjectionManager.instance.initialize();
        };

        beforeAll(async () => {
            await ensureComponentsRegistered(QspScopedItem);
            process.env.BUNSANE_QSP = 'route';
            process.env.BUNSANE_QSP_ARCHETYPES = archetypeName;
            await db`CREATE TABLE IF NOT EXISTS projection_state (
                archetype text PRIMARY KEY, shape_hash text NOT NULL,
                status text NOT NULL DEFAULT 'DISABLED', shape_version int NOT NULL DEFAULT 1,
                watermark uuid, field_state jsonb NOT NULL DEFAULT '{}',
                updated_at timestamptz NOT NULL DEFAULT now()
            );`;
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);

            // Seeded before the projection exists, so only a backfill can put them in rm_.
            ProjectionManager.reset();
            for (let i = 0; i < SEEDED; i++) {
                const e = Entity.Create();
                e.add(QspScopedItem, { label: `item-${i}` });
                await e.save();
            }
        });

        beforeEach(async () => {
            await ProjectionManager.instance.awaitBackfills();
        });

        afterAll(async () => {
            await ProjectionManager.instance.awaitBackfills();
            ProjectionManager.reset();
            await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
            await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [archetypeName]);
            if (saved.qsp === undefined) delete process.env.BUNSANE_QSP;
            else process.env.BUNSANE_QSP = saved.qsp;
            if (saved.archetypes === undefined) delete process.env.BUNSANE_QSP_ARCHETYPES;
            else process.env.BUNSANE_QSP_ARCHETYPES = saved.archetypes;
        });

        test('first boot backfills a scoped archetype to SHADOW', async () => {
            await boot();
            await ProjectionManager.instance.awaitBackfills();

            expect(await status()).toBe('SHADOW');
            expect(ProjectionManager.instance.getStatus(archetypeName)).toBe('SHADOW');
            expect(await projectedCount()).toBe(SEEDED);
        });

        test('an operator DISABLED row survives a restart and is not backfilled', async () => {
            await db.unsafe(`UPDATE projection_state SET status = 'DISABLED' WHERE archetype = $1`, [archetypeName]);
            await db.unsafe(`DELETE FROM ${tableName}`);

            await boot();
            await ProjectionManager.instance.awaitBackfills();

            expect(await status()).toBe('DISABLED');
            expect(await projectedCount()).toBe(0);
        });

        test('a BACKFILLING row left by an interrupted run resumes on boot', async () => {
            await db.unsafe(`UPDATE projection_state SET status = 'BACKFILLING', watermark = NULL WHERE archetype = $1`, [archetypeName]);
            await db.unsafe(`DELETE FROM ${tableName}`);

            await boot();
            await ProjectionManager.instance.awaitBackfills();

            expect(await status()).toBe('SHADOW');
            expect(await projectedCount()).toBe(SEEDED);
        });
    });
}
