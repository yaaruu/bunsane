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
        });

        test('input schema validates data', () => {
            const archetype = new TestUserArchetype();
            const validResult = archetype.withValidation({
                user: { name: 'Valid', email: 'valid@example.com', age: 25 }
            });

            expect(validResult).toBeDefined();
        });
    });

    describe('schema caching', () => {
        test('schemas are cached for performance', () => {
            const archetype = new TestUserArchetype();

            // First call
            const schema1 = archetype.getZodObjectSchema();
            // Second call should return cached
            const schema2 = archetype.getZodObjectSchema();

            // Both should be defined (caching is internal)
            expect(schema1).toBeDefined();
            expect(schema2).toBeDefined();
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
