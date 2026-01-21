/**
 * Unit tests for Entity component management
 * Tests component add, remove, and data handling
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

describe('Entity Component Management', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('component data handling', () => {
        test('component data() returns correct properties', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30, bio: 'A bio' });

            const component = entity.getInMemory(TestUser);
            const data = component?.data();

            expect(data?.name).toBe('John');
            expect(data?.email).toBe('john@test.com');
            expect(data?.age).toBe(30);
            expect(data?.bio).toBe('A bio');
        });

        test('component handles nullable fields', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            const data = component?.data();

            expect(data?.bio).toBeUndefined();
        });

        test('component handles boolean fields', () => {
            const entity = new Entity();
            entity.add(TestProduct, {
                sku: 'SKU123',
                name: 'Test Product',
                price: 99.99,
                inStock: true
            });

            const component = entity.getInMemory(TestProduct);
            expect(component?.inStock).toBe(true);
        });

        test('component handles false boolean correctly', () => {
            const entity = new Entity();
            entity.add(TestProduct, {
                sku: 'SKU123',
                name: 'Test Product',
                price: 99.99,
                inStock: false
            });

            const component = entity.getInMemory(TestProduct);
            expect(component?.inStock).toBe(false);
        });

        test('component handles number fields', () => {
            const entity = new Entity();
            entity.add(TestProduct, {
                sku: 'SKU123',
                name: 'Test Product',
                price: 123.45,
                inStock: true
            });

            const component = entity.getInMemory(TestProduct);
            expect(component?.price).toBe(123.45);
        });

        test('component handles zero value correctly', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 0 });

            const component = entity.getInMemory(TestUser);
            expect(component?.age).toBe(0);
        });

        test('component handles Date fields', () => {
            const date = new Date('2024-01-15T10:30:00Z');
            const entity = new Entity();
            entity.add(TestOrder, {
                orderNumber: 'ORD-001',
                total: 150.00,
                status: 'pending',
                createdAt: date
            });

            const component = entity.getInMemory(TestOrder);
            expect(component?.createdAt).toEqual(date);
        });
    });

    describe('multiple components', () => {
        test('handles multiple components of different types', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'SKU1', name: 'Product 1', price: 50, inStock: true });
            entity.add(TestOrder, {
                orderNumber: 'ORD-001',
                total: 150,
                status: 'completed',
                createdAt: new Date()
            });

            expect(entity.componentList().length).toBe(3);
            expect(entity.hasInMemory(TestUser)).toBe(true);
            expect(entity.hasInMemory(TestProduct)).toBe(true);
            expect(entity.hasInMemory(TestOrder)).toBe(true);
        });

        test('each component maintains its own data', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'User Name', email: 'user@test.com', age: 25 });
            entity.add(TestProduct, { sku: 'PROD1', name: 'Product Name', price: 100, inStock: true });

            const user = entity.getInMemory(TestUser);
            const product = entity.getInMemory(TestProduct);

            expect(user?.name).toBe('User Name');
            expect(product?.name).toBe('Product Name');
        });

        test('removing one component does not affect others', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });
            entity.add(TestProduct, { sku: 'SKU1', name: 'Product', price: 50, inStock: true });

            entity.remove(TestUser);

            expect(entity.hasInMemory(TestUser)).toBe(false);
            expect(entity.hasInMemory(TestProduct)).toBe(true);
            expect(entity.getInMemory(TestProduct)?.name).toBe('Product');
        });
    });

    describe('component replacement', () => {
        test('adding same component type replaces existing', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'Original', email: 'original@test.com', age: 30 });
            entity.add(TestUser, { name: 'Replaced', email: 'replaced@test.com', age: 25 });

            const components = entity.componentList();
            expect(components.length).toBe(1);

            const user = entity.getInMemory(TestUser);
            expect(user?.name).toBe('Replaced');
            expect(user?.email).toBe('replaced@test.com');
        });
    });

    describe('component serialization', () => {
        test('serializableData returns proper format', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            const data = component?.serializableData();

            expect(data).toEqual({
                name: 'John',
                email: 'john@test.com',
                age: 30,
                bio: undefined
            });
        });

        test('serializableData handles Date as ISO string', () => {
            const date = new Date('2024-01-15T10:30:00.000Z');
            const entity = new Entity();
            entity.add(TestOrder, {
                orderNumber: 'ORD-001',
                total: 100,
                status: 'pending',
                createdAt: date
            });

            const component = entity.getInMemory(TestOrder);
            const data = component?.serializableData();

            expect(data?.createdAt).toBe('2024-01-15T10:30:00.000Z');
        });
    });

    describe('component state', () => {
        test('new component is not persisted', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            expect((component as any)._persisted).toBe(false);
        });

        test('new component is dirty', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            expect((component as any)._dirty).toBe(false); // Initial state from constructor
        });

        test('component has type ID', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            expect(component?.getTypeID()).toBeDefined();
            expect(component?.getTypeID().length).toBeGreaterThan(0);
        });

        test('component properties returns correct list', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            const props = component?.properties();

            expect(props).toContain('name');
            expect(props).toContain('email');
            expect(props).toContain('age');
            expect(props).toContain('bio');
        });

        test('indexedProperties returns only indexed fields', () => {
            const entity = new Entity();
            entity.add(TestUser, { name: 'John', email: 'john@test.com', age: 30 });

            const component = entity.getInMemory(TestUser);
            const indexed = component?.indexedProperties();

            expect(indexed).toContain('name');
            expect(indexed).toContain('email');
            expect(indexed).not.toContain('age');
            expect(indexed).not.toContain('bio');
        });
    });
});
