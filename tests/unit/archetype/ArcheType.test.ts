/**
 * Unit tests for ArcheType system
 * Tests archetype definition and basic functionality
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../../core/ArcheType';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { TestUserArchetype, TestUserWithOrdersArchetype } from '../../fixtures/archetypes/TestUserArchetype';
import { ensureComponentsRegistered } from '../../utils';

describe('ArcheType', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('ArcheType definition', () => {
        test('archetype class extends BaseArcheType', () => {
            const archetype = new TestUserArchetype();
            expect(archetype).toBeInstanceOf(BaseArcheType);
        });

        test('archetype has componentMap', () => {
            const archetype = new TestUserArchetype();
            expect(archetype.componentMap).toBeDefined();
            expect(typeof archetype.componentMap).toBe('object');
        });

        test('componentMap contains declared fields', () => {
            const archetype = new TestUserArchetype();
            expect(archetype.componentMap.user).toBeDefined();
        });

        test('archetype with multiple components', () => {
            const archetype = new TestUserWithOrdersArchetype();
            expect(archetype.componentMap.user).toBeDefined();
            expect(archetype.componentMap.order).toBeDefined();
        });
    });

    describe('createEntity()', () => {
        test('creates entity with id', () => {
            const archetype = new TestUserArchetype();
            const entity = archetype.createEntity();

            expect(entity).toBeDefined();
            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
        });

        test('entity is dirty after creation', () => {
            const archetype = new TestUserArchetype();
            const entity = archetype.createEntity();

            expect((entity as any)._dirty).toBe(true);
        });

        test('entity is not persisted after creation', () => {
            const archetype = new TestUserArchetype();
            const entity = archetype.createEntity();

            expect(entity._persisted).toBe(false);
        });
    });

    describe('getZodObjectSchema()', () => {
        test('returns zod schema for archetype', () => {
            const archetype = new TestUserArchetype();
            const schema = archetype.getZodObjectSchema();

            expect(schema).toBeDefined();
        });
    });

    describe('getInputSchema()', () => {
        test('returns input schema for archetype', () => {
            const archetype = new TestUserArchetype();
            const schema = archetype.getInputSchema();

            expect(schema).toBeDefined();
        });
    });

    describe('getComponentsToLoad()', () => {
        test('returns non-empty components array', () => {
            const archetype = new TestUserArchetype();
            const components = (archetype as any).getComponentsToLoad();

            expect(Array.isArray(components)).toBe(true);
            expect(components.length).toBeGreaterThan(0);
            expect(components).toContain(TestUser);
        });
    });

    describe('withValidation()', () => {
        test('returns a Zod schema with validations applied', () => {
            const archetype = new TestUserArchetype();
            const schema = archetype.withValidation({
                user: { name: 'Valid', email: 'valid@test.com', age: 25 }
            });

            expect(schema).toBeDefined();
            // Should return a Zod schema with a shape property
            expect(schema.shape).toBeDefined();
            expect(typeof schema.safeParse).toBe('function');
        });
    });
});
