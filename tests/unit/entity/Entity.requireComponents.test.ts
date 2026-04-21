/**
 * Unit tests for Entity.requireComponents (BUNSANE-003).
 * Ensures ComponentTargetHook includeComponents matching sees tag
 * components that weren't eagerly loaded.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { TestUser } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

@Component
class ReqTag extends BaseComponent {}

@Component
class ReqData extends BaseComponent {
    @CompData()
    value: string = '';
}

describe('Entity.requireComponents', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, ReqTag, ReqData);
    });

    test('no-op for empty list', async () => {
        const entity = Entity.Create();
        await expect(entity.requireComponents([])).resolves.toBeUndefined();
        expect(entity.componentList().length).toBe(0);
    });

    test('does nothing when components already in memory', async () => {
        const entity = Entity.Create();
        entity.add(ReqTag);
        const before = entity.componentList().length;
        await entity.requireComponents([ReqTag]);
        expect(entity.componentList().length).toBe(before);
    });

    test('hydrates missing components from DB after save', async () => {
        const saved = Entity.Create();
        saved.add(ReqTag);
        saved.add(ReqData, { value: 'hello' });
        await saved.save();

        const loaded = new Entity(saved.id);
        expect(loaded.componentList().length).toBe(0);

        await loaded.requireComponents([ReqTag, ReqData]);

        expect(loaded.hasInMemory(ReqTag)).toBe(true);
        expect(loaded.hasInMemory(ReqData)).toBe(true);
        expect(loaded.getInMemory(ReqData)?.value).toBe('hello');
    });

    test('only fetches missing components, not already-loaded ones', async () => {
        const saved = Entity.Create();
        saved.add(ReqTag);
        saved.add(ReqData, { value: 'mix' });
        await saved.save();

        const loaded = new Entity(saved.id);
        await loaded.requireComponents([ReqData]);
        expect(loaded.hasInMemory(ReqData)).toBe(true);
        expect(loaded.hasInMemory(ReqTag)).toBe(false);

        await loaded.requireComponents([ReqTag, ReqData]);
        expect(loaded.hasInMemory(ReqTag)).toBe(true);
        expect(loaded.getInMemory(ReqData)?.value).toBe('mix');
    });
});
