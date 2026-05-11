/**
 * Integration tests for `createRequestLoaders` AbortSignal threading.
 *
 * The GraphQL request plugin (core/RequestContext.ts) wires the request's
 * AbortSignal into each DataLoader's `db.unsafe()` call via timedUnsafe.
 * On abort the in-flight query is cancelled, releasing the backend
 * connection back to pgbouncer.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import db from '../../../database';
import { Entity } from '../../../core/Entity';
import { createRequestLoaders } from '../../../core/RequestLoaders';
import { ComponentRegistry } from '../../../core/components';
import { TestUser } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('RequestLoaders AbortSignal', () => {
    const ctx = createTestContext();
    let seededEntity: Entity;
    let testUserTypeId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
        testUserTypeId = ComponentRegistry.getComponentId('TestUser')!;
        expect(testUserTypeId).toBeTruthy();
    });

    beforeEach(async () => {
        // Fresh seed per test — createTestContext's afterEach cleans tracked
        // entities, so seeds set up once would disappear after the first
        // test in the suite runs.
        seededEntity = ctx.tracker.create();
        seededEntity.add(TestUser, { name: 'loader-seed', email: 'l@e.com', age: 1 });
        await seededEntity.save();
        await Entity.drainPendingSideEffects();
    });

    test('entityById loader rejects when pre-aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted'));

        const loaders = createRequestLoaders(db, undefined, controller.signal);
        await expect(loaders.entityById.load(seededEntity.id)).rejects.toBeDefined();
    });

    test('componentsByEntityType loader rejects when pre-aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted'));

        const loaders = createRequestLoaders(db, undefined, controller.signal);
        await expect(
            loaders.componentsByEntityType.load({
                entityId: seededEntity.id,
                typeId: testUserTypeId,
            }),
        ).rejects.toBeDefined();
    });

    test('loaders without signal still work (backwards compatible)', async () => {
        const loaders = createRequestLoaders(db);
        const ent = await loaders.entityById.load(seededEntity.id);
        expect(ent?.id).toBe(seededEntity.id);
    });

    test('perRequest counters track DataLoader invocations', async () => {
        const perRequest = {
            dbQueryCount: 0,
            dataLoaderCalls: { entity: 0, component: 0, relation: 0 },
        };
        const loaders = createRequestLoaders(db, undefined, undefined, perRequest);

        await loaders.entityById.load(seededEntity.id);
        await loaders.componentsByEntityType.load({
            entityId: seededEntity.id,
            typeId: testUserTypeId,
        });

        expect(perRequest.dataLoaderCalls.entity).toBeGreaterThanOrEqual(1);
        expect(perRequest.dataLoaderCalls.component).toBeGreaterThanOrEqual(1);
        expect(perRequest.dbQueryCount).toBeGreaterThan(0);
    });
});
