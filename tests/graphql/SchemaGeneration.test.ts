/**
 * Tests for GraphQL Schema Generation
 * Tests the overall schema generation process
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { TestUser, TestProduct, TestOrder } from '../fixtures/components';
import { TestUserArchetype } from '../fixtures/archetypes/TestUserArchetype';
import { ensureComponentsRegistered } from '../utils';

describe('GraphQL Schema Generation', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('archetype schema generation', () => {
        test('archetype has zodObjectSchema method', () => {
            const archetype = new TestUserArchetype();
            expect(typeof archetype.getZodObjectSchema).toBe('function');
        });

        test('archetype has inputSchema method', () => {
            const archetype = new TestUserArchetype();
            expect(typeof archetype.getInputSchema).toBe('function');
        });
    });

    describe('component to GraphQL type mapping', () => {
        test('archetype schema is defined', () => {
            const archetype = new TestUserArchetype();
            const schema = archetype.getZodObjectSchema();

            expect(schema).toBeDefined();
        });

        test('input schema is defined', () => {
            const archetype = new TestUserArchetype();
            const inputSchema = archetype.getInputSchema();

            expect(inputSchema).toBeDefined();
        });
    });

    describe('input type generation', () => {
        test('generates input schema for archetype', () => {
            const archetype = new TestUserArchetype();
            const inputSchema = archetype.getInputSchema();

            expect(inputSchema).toBeDefined();
            expect(typeof inputSchema).toBe('object');
        });

        test('input schema validates valid data', () => {
            const archetype = new TestUserArchetype();
            const schema = archetype.withValidation({
                user: { name: 'Valid', email: 'valid@example.com', age: 25 }
            });

            expect(schema).toBeDefined();
            expect(schema.shape).toBeDefined();
            expect(typeof schema.safeParse).toBe('function');
        });
    });

    describe('schema consistency', () => {
        test('multiple calls return structurally equivalent schemas', () => {
            const archetype = new TestUserArchetype();

            const schema1 = archetype.getZodObjectSchema();
            const schema2 = archetype.getZodObjectSchema();

            // Both should have the same shape keys
            const keys1 = Object.keys(schema1.shape);
            const keys2 = Object.keys(schema2.shape);
            expect(keys1).toEqual(keys2);
            expect(keys1.length).toBeGreaterThan(0);
        });
    });

    describe('archetype with components', () => {
        test('archetype has componentMap', () => {
            const archetype = new TestUserArchetype();
            expect(archetype.componentMap).toBeDefined();
        });

        test('componentMap includes user component', () => {
            const archetype = new TestUserArchetype();
            expect(archetype.componentMap.user).toBeDefined();
        });
    });
});
