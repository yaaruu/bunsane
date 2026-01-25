/**
 * Unit tests for Entity class
 * Tests core entity functionality without database interaction
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { TestUser, TestProduct } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

describe('Entity', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
    });

    describe('constructor', () => {
        test('generates a UUID when no id is provided', () => {
            const entity = new Entity();
            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
            // UUIDv7 format check
            expect(entity.id).toMatch(/^[0-9a-f-]{36}$/i);
        });

        test('uses provided id when given', () => {
            const customId = '12345678-1234-1234-1234-123456789abc';
            const entity = new Entity(customId);
            expect(entity.id).toBe(customId);
        });

        test('generates UUID when empty string is provided', () => {
            const entity = new Entity('');
            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
            expect(entity.id).not.toBe('');
        });

        test('generates UUID when whitespace string is provided', () => {
            const entity = new Entity('   ');
            expect(entity.id).toBeDefined();
            expect(entity.id.trim().length).toBeGreaterThan(0);
        });

        test('sets dirty flag to true initially', () => {
            const entity = new Entity();
            expect((entity as any)._dirty).toBe(true);
        });

        test('sets persisted flag to false initially', () => {
            const entity = new Entity();
            expect(entity._persisted).toBe(false);
        });
    });

    describe('add()', () => {
        test('adds a component to the entity', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@example.com', age: 30 });

            const components = entity.componentList();
            expect(components.length).toBe(1);
            expect(components[0]).toBeInstanceOf(TestUser);
        });

        test('adds component with provided data', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Jane', email: 'jane@example.com', age: 25 });

            const component = entity.getInMemory(TestUser);
            expect(component).toBeDefined();
            expect(component?.name).toBe('Jane');
            expect(component?.email).toBe('jane@example.com');
            expect(component?.age).toBe(25);
        });

        test('adds component without data (defaults)', () => {
            const entity = new Entity();
            entity.add(TestUser);

            const components = entity.componentList();
            expect(components.length).toBe(1);
        });

        test('marks entity as dirty after adding component', () => {
            const entity = new Entity();
            entity.setDirty(false);
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 20 });
            expect((entity as any)._dirty).toBe(true);
        });

        test('allows adding multiple different components', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'User', email: 'user@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'SKU123', name: 'Product', price: 99.99, inStock: true });

            const components = entity.componentList();
            expect(components.length).toBe(2);
            expect(entity.getInMemory(TestUser)).toBeDefined();
            expect(entity.getInMemory(TestProduct)).toBeDefined();
        });

        test('returns this for method chaining', () => {
            const entity = new Entity();
            const result = entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 20 });
            expect(result).toBe(entity);
        });
    });

    describe('getInMemory()', () => {
        test('returns component if already loaded', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });

            const component = entity.getInMemory(TestUser);
            expect(component).toBeDefined();
            expect(component?.name).toBe('Test');
        });

        test('returns undefined if component not loaded', () => {
            const entity = new Entity();
            const component = entity.getInMemory(TestUser);
            expect(component).toBeUndefined();
        });

        test('returns correct component type', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            entity.add(TestProduct, { sku: 'SKU123', name: 'Product', price: 50, inStock: true });

            const user = entity.getInMemory(TestUser);
            const product = entity.getInMemory(TestProduct);

            expect(user).toBeInstanceOf(TestUser);
            expect(product).toBeInstanceOf(TestProduct);
        });
    });

    describe('hasInMemory()', () => {
        test('returns true if component is loaded', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            expect(entity.hasInMemory(TestUser)).toBe(true);
        });

        test('returns false if component is not loaded', () => {
            const entity = new Entity();
            expect(entity.hasInMemory(TestUser)).toBe(false);
        });
    });

    describe('remove()', () => {
        test('removes a component from the entity', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });

            expect(entity.hasInMemory(TestUser)).toBe(true);
            const removed = entity.remove(TestUser);
            expect(removed).toBe(true);
            expect(entity.hasInMemory(TestUser)).toBe(false);
        });

        test('returns false if component was not present', () => {
            const entity = new Entity();
            const removed = entity.remove(TestUser);
            expect(removed).toBe(false);
        });

        test('marks entity as dirty after removing component', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            entity.setDirty(false);

            entity.remove(TestUser);
            expect((entity as any)._dirty).toBe(true);
        });

        test('tracks removed component for wasRemoved check', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            entity.remove(TestUser);

            expect(entity.wasRemoved(TestUser)).toBe(true);
        });
    });

    describe('wasRemoved()', () => {
        test('returns false for component that was never added', () => {
            const entity = new Entity();
            expect(entity.wasRemoved(TestUser)).toBe(false);
        });

        test('returns false for component that is still present', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            expect(entity.wasRemoved(TestUser)).toBe(false);
        });

        test('returns true for removed component', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Test', email: 'test@test.com', age: 25 });
            entity.remove(TestUser);
            expect(entity.wasRemoved(TestUser)).toBe(true);
        });
    });

    describe('componentList()', () => {
        test('returns empty array for entity without components', () => {
            const entity = new Entity();
            expect(entity.componentList()).toEqual([]);
        });

        test('returns all added components', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'User', email: 'user@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'SKU', name: 'Product', price: 10, inStock: true });

            const components = entity.componentList();
            expect(components.length).toBe(2);
        });
    });

    describe('setPersisted() / setDirty()', () => {
        test('setPersisted updates _persisted flag', () => {
            const entity = new Entity();
            expect(entity._persisted).toBe(false);
            entity.setPersisted(true);
            expect(entity._persisted).toBe(true);
        });

        test('setDirty updates _dirty flag', () => {
            const entity = new Entity();
            expect((entity as any)._dirty).toBe(true);
            entity.setDirty(false);
            expect((entity as any)._dirty).toBe(false);
        });
    });

    describe('serialize()', () => {
        test('serializes entity with id and components', () => {
            const entity = new Entity('test-id-123');
            entity.add(TestUser, { name: 'John', email: 'john@example.com', age: 30 });

            const serialized = entity.serialize();

            expect(serialized.id).toBe('test-id-123');
            expect(serialized.components).toBeDefined();
            expect(serialized.components.TestUser).toBeDefined();
            expect(serialized.components.TestUser.name).toBe('John');
            expect(serialized.components.TestUser.email).toBe('john@example.com');
        });

        test('serializes multiple components', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'User', email: 'user@test.com', age: 25 });
            entity.add(TestProduct, { sku: 'SKU123', name: 'Product', price: 99.99, inStock: true });

            const serialized = entity.serialize();

            expect(Object.keys(serialized.components).length).toBe(2);
            expect(serialized.components.TestUser).toBeDefined();
            expect(serialized.components.TestProduct).toBeDefined();
        });

        test('serializes empty entity', () => {
            const entity = new Entity('empty-entity');
            const serialized = entity.serialize();

            expect(serialized.id).toBe('empty-entity');
            expect(serialized.components).toEqual({});
        });
    });

    describe('deserialize()', () => {
        test('deserializes entity from serialized data', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@example.com', age: 30 });
            const serialized = entity.serialize();

            const deserialized = Entity.deserialize(serialized);

            expect(deserialized.id).toBe(entity.id);
            expect(deserialized._persisted).toBe(true);
            expect((deserialized as any)._dirty).toBe(false);
        });

        test('returns same entity if already an Entity instance', () => {
            const entity = new Entity();
            const result = Entity.deserialize(entity);
            expect(result).toBe(entity);
        });

        test('deserializes with multiple components', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'User', email: 'user@test.com', age: 25 });
            entity.add(TestProduct, { sku: 'SKU123', name: 'Product', price: 50, inStock: true });
            const serialized = entity.serialize();

            const deserialized = Entity.deserialize(serialized);

            expect(deserialized.componentList().length).toBe(2);
        });
    });

    describe('Clone()', () => {
        test('creates a new entity with new id', () => {
            const entity = new Entity('original-id');
            entity.add(TestUser, { name: 'Original', email: 'original@test.com', age: 30 });

            const clone = Entity.Clone(entity);

            expect(clone.id).not.toBe(entity.id);
            expect(clone._persisted).toBe(false);
            expect((clone as any)._dirty).toBe(true);
        });

        test('clones component data', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Original', email: 'original@test.com', age: 30 });

            const clone = Entity.Clone(entity);
            const clonedUser = clone.getInMemory(TestUser);

            expect(clonedUser?.name).toBe('Original');
            expect(clonedUser?.email).toBe('original@test.com');
        });

        test('cloned components have new ids', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Original', email: 'original@test.com', age: 30 });
            const originalUser = entity.getInMemory(TestUser);

            const clone = Entity.Clone(entity);
            const clonedUser = clone.getInMemory(TestUser);

            expect(clonedUser?.id).not.toBe(originalUser?.id);
        });
    });

    describe('Create()', () => {
        test('creates a new entity instance', () => {
            const entity = Entity.Create();
            expect(entity).toBeInstanceOf(Entity);
            expect(entity.id).toBeDefined();
        });
    });
});
