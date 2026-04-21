/**
 * Unit tests for Entity.reload (BUNSANE-006).
 * Ensures in-memory component state is discarded and re-hydrated from DB.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { ensureComponentsRegistered } from '../../utils';
import db from '../../../database';

@Component
class ReloadStatus extends BaseComponent {
    @CompData()
    value: string = '';
}

describe('Entity.reload', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(ReloadStatus);
    });

    test('no-op on entity without a valid id', async () => {
        const entity = new Entity('');
        await expect(entity.reload()).resolves.toBe(entity);
    });

    test('refreshes in-memory data after raw-SQL write', async () => {
        const saved = Entity.Create();
        saved.add(ReloadStatus, { value: 'before' });
        await saved.save();

        const typeId = new ReloadStatus().getTypeID();

        // Write new value via raw SQL — bypasses entity cache invalidation.
        await db.unsafe(
            `UPDATE components SET data = data || '{"value":"after"}'::jsonb
             WHERE entity_id = $1 AND type_id = $2`,
            [saved.id, typeId]
        );

        // In-memory copy still holds stale value.
        expect(saved.getInMemory(ReloadStatus)?.value).toBe('before');

        const returned = await saved.reload();
        expect(returned).toBe(saved);
        expect(saved.getInMemory(ReloadStatus)?.value).toBe('after');
    });

    test('hydrates a bare Entity instance from DB', async () => {
        const saved = Entity.Create();
        saved.add(ReloadStatus, { value: 'hydrated' });
        await saved.save();

        const bare = new Entity(saved.id);
        expect(bare.componentList().length).toBe(0);

        await bare.reload();

        expect(bare.hasInMemory(ReloadStatus)).toBe(true);
        expect(bare.getInMemory(ReloadStatus)?.value).toBe('hydrated');
    });
});
