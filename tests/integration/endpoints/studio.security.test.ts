/**
 * SEC-01 integration: studio table allow-list + archetype-scoped delete.
 *
 * Runs against the test DB (PGlite wrapper or real PG scratch DB).
 * Calls the endpoint handlers directly — auth gating is covered by
 * tests/e2e/studio.auth.test.ts.
 *
 * NOTE: entities here are NOT registered with an EntityTracker — these tests
 * assert cross-test survival of specific ids, so cleanup is explicit.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import db from '../../../database';
import { TestUser } from '../../fixtures/components/TestUser';
import { TestUserArchetype } from '../../fixtures/archetypes/TestUserArchetype';
import { ensureComponentsRegistered } from '../../utils';
import { getSerializedMetadataStorage } from '../../../core/metadata';
import {
    handleStudioTableRequest,
    handleStudioTableDeleteRequest,
    handleGetTables,
} from '../../../endpoints/tables';
import { handleStudioArcheTypeDeleteRequest } from '../../../endpoints/archetypes';

describe('Studio security (SEC-01)', () => {
    let ownedEntityId: string;
    let foreignEntityId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);

        // The archetype decorator only runs if this module's side effects are
        // kept — referencing the class here keeps the import alive AND fails
        // loudly if registration ever breaks, instead of a confusing 404
        // deep inside a handler.
        expect(TestUserArchetype).toBeDefined();
        expect(
            Object.keys(getSerializedMetadataStorage().archeTypes)
        ).toContain('TestUserArchetype');

        // Entity that BELONGS to TestUserArchetype (has the indicator component).
        const e1 = Entity.Create();
        await e1.add(TestUser, { name: 'SecOwned', email: 'sec01-owned@test', age: 40 });
        await e1.save();
        ownedEntityId = e1.id;

        // Entity WITHOUT the indicator component → foreign to the archetype.
        const e2 = Entity.Create();
        await e2.save();
        foreignEntityId = e2.id;

        // A plain app table the allow-list should admit. created_at is needed
        // because the studio table reader orders by it unconditionally.
        await db`DROP TABLE IF EXISTS studio_sec01_t`;
        await db`CREATE TABLE studio_sec01_t (
            id serial primary key,
            label text,
            created_at timestamptz not null default now()
        )`;
        await db`INSERT INTO studio_sec01_t (label) VALUES ('row-a'), ('row-b')`;
    });

    afterAll(async () => {
        await db`DROP TABLE IF EXISTS studio_sec01_t`;
        // Hard-delete the test entities regardless of test outcomes.
        if (ownedEntityId && foreignEntityId) {
            await db`DELETE FROM components WHERE entity_id IN (${ownedEntityId}, ${foreignEntityId})`;
            await db`DELETE FROM entities WHERE id IN (${ownedEntityId}, ${foreignEntityId})`;
        }
    });

    describe('table allow-list', () => {
        test('hidden framework table is unreachable by direct path', async () => {
            const res = await handleStudioTableRequest('entities');
            expect(res.status).toBe(404);
        });

        test('components_% pattern is unreachable by direct path', async () => {
            const res = await handleStudioTableRequest('components_testuser');
            expect(res.status).toBe(404);
        });

        test('listing does not advertise framework tables', async () => {
            const res = await handleGetTables();
            expect(res.status).toBe(200);
            const body: { tables: string[] } = await res.json();
            expect(body.tables).not.toContain('entities');
            expect(body.tables).not.toContain('components');
        });

        test('plain app table is readable', async () => {
            const res = await handleStudioTableRequest('studio_sec01_t');
            expect(res.status).toBe(200);
            const body = await res.json() as { total: number; rows: unknown[] };
            expect(body.total).toBe(2);
            expect(body.rows.length).toBe(2);
        });

        test('nonexistent table still 404s', async () => {
            const res = await handleStudioTableRequest('does_not_exist_xyz');
            expect(res.status).toBe(404);
        });

        test('DELETE on hidden framework table is refused', async () => {
            const res = await handleStudioTableDeleteRequest('entities', {
                ids: [ownedEntityId],
            });
            expect(res.status).toBe(404);

            const survivor = await Entity.FindById(ownedEntityId);
            expect(survivor).not.toBeNull();
        });
    });

    describe('archetype-scoped delete', () => {
        test('unknown archetype 404s', async () => {
            const res = await handleStudioArcheTypeDeleteRequest('NoSuchArchetypeXy', {
                entityIds: [ownedEntityId],
            });
            expect(res.status).toBe(404);
        });

        test('refuses batch containing a foreign-only id set', async () => {
            const res = await handleStudioArcheTypeDeleteRequest('TestUserArchetype', {
                entityIds: [foreignEntityId],
            });
            expect(res.status).toBe(400);

            const body = await res.json() as { foreignEntityIds: string[] };
            expect(body.foreignEntityIds).toContain(foreignEntityId);

            // Nothing may be deleted on refusal — the owned entity survives.
            const survivor = await Entity.FindById(ownedEntityId);
            expect(survivor).not.toBeNull();
        });

        test('refuses mixed batch containing a foreign entity', async () => {
            const res = await handleStudioArcheTypeDeleteRequest('TestUserArchetype', {
                entityIds: [ownedEntityId, foreignEntityId],
            });
            expect(res.status).toBe(400);

            const body = await res.json() as { foreignEntityIds: string[] };
            expect(body.foreignEntityIds).toContain(foreignEntityId);

            // The owned entity in the rejected batch must survive.
            const survivor = await Entity.FindById(ownedEntityId);
            expect(survivor).not.toBeNull();
        });

        test('deletes an entity that belongs to the archetype', async () => {
            const res = await handleStudioArcheTypeDeleteRequest('TestUserArchetype', {
                entityIds: [ownedEntityId],
            });
            expect(res.status).toBe(200);

            const body = await res.json() as { success: boolean; deletedCount: number };
            expect(body.success).toBe(true);
            expect(body.deletedCount).toBe(1);

            const gone = await Entity.FindById(ownedEntityId);
            expect(gone).toBeNull();
        });
    });
});
