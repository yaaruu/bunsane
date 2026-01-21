/**
 * Tests for TypeDefBuilder
 * Tests GraphQL type definition building
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { TypeDefBuilder } from '../../../gql/builders/TypeDefBuilder';

describe('TypeDefBuilder', () => {
    let builder: TypeDefBuilder;

    beforeEach(() => {
        builder = new TypeDefBuilder();
    });

    describe('addQueryField()', () => {
        test('adds query field', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser(id: ID!): User' });
            const stats = builder.getStats();
            expect(stats.queries).toBe(1);
        });

        test('adds multiple query fields', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser(id: ID!): User' });
            builder.addQueryField({ name: 'getUsers', fieldDef: 'getUsers: [User!]!' });
            const stats = builder.getStats();
            expect(stats.queries).toBe(2);
        });
    });

    describe('addMutationField()', () => {
        test('adds mutation field', () => {
            builder.addMutationField({ name: 'createUser', fieldDef: 'createUser(input: CreateUserInput!): User!' });
            const stats = builder.getStats();
            expect(stats.mutations).toBe(1);
        });
    });

    describe('addSubscriptionField()', () => {
        test('adds subscription field', () => {
            builder.addSubscriptionField({ name: 'userCreated', fieldDef: 'userCreated: User!' });
            const stats = builder.getStats();
            expect(stats.subscriptions).toBe(1);
        });
    });

    describe('buildQueryType()', () => {
        test('returns empty string when no queries', () => {
            const result = builder.buildQueryType();
            expect(result).toBe('');
        });

        test('builds Query type with fields', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser(id: ID!): User' });
            const result = builder.buildQueryType();

            expect(result).toContain('type Query');
            expect(result).toContain('getUser(id: ID!): User');
        });

        test('sorts fields alphabetically', () => {
            builder.addQueryField({ name: 'zebra', fieldDef: 'zebra: String' });
            builder.addQueryField({ name: 'alpha', fieldDef: 'alpha: String' });
            const result = builder.buildQueryType();

            const alphaIndex = result.indexOf('alpha');
            const zebraIndex = result.indexOf('zebra');
            expect(alphaIndex).toBeLessThan(zebraIndex);
        });
    });

    describe('buildMutationType()', () => {
        test('returns empty string when no mutations', () => {
            const result = builder.buildMutationType();
            expect(result).toBe('');
        });

        test('builds Mutation type with fields', () => {
            builder.addMutationField({ name: 'createUser', fieldDef: 'createUser(input: CreateUserInput!): User!' });
            const result = builder.buildMutationType();

            expect(result).toContain('type Mutation');
            expect(result).toContain('createUser');
        });
    });

    describe('buildSubscriptionType()', () => {
        test('returns empty string when no subscriptions', () => {
            const result = builder.buildSubscriptionType();
            expect(result).toBe('');
        });

        test('builds Subscription type with fields', () => {
            builder.addSubscriptionField({ name: 'userCreated', fieldDef: 'userCreated: User!' });
            const result = builder.buildSubscriptionType();

            expect(result).toContain('type Subscription');
            expect(result).toContain('userCreated');
        });
    });

    describe('buildAllOperationTypes()', () => {
        test('builds all operation types', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser(id: ID!): User' });
            builder.addMutationField({ name: 'createUser', fieldDef: 'createUser(input: CreateUserInput!): User!' });
            builder.addSubscriptionField({ name: 'userCreated', fieldDef: 'userCreated: User!' });

            const result = builder.buildAllOperationTypes();

            expect(result).toContain('type Query');
            expect(result).toContain('type Mutation');
            expect(result).toContain('type Subscription');
        });

        test('returns only defined types', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser(id: ID!): User' });

            const result = builder.buildAllOperationTypes();

            expect(result).toContain('type Query');
            expect(result).not.toContain('type Mutation');
            expect(result).not.toContain('type Subscription');
        });
    });

    describe('clear()', () => {
        test('clears all fields', () => {
            builder.addQueryField({ name: 'getUser', fieldDef: 'getUser: User' });
            builder.addMutationField({ name: 'createUser', fieldDef: 'createUser: User' });
            builder.addSubscriptionField({ name: 'userCreated', fieldDef: 'userCreated: User' });

            builder.clear();

            const stats = builder.getStats();
            expect(stats.queries).toBe(0);
            expect(stats.mutations).toBe(0);
            expect(stats.subscriptions).toBe(0);
        });
    });

    describe('getStats()', () => {
        test('returns correct counts', () => {
            builder.addQueryField({ name: 'q1', fieldDef: 'q1: String' });
            builder.addQueryField({ name: 'q2', fieldDef: 'q2: String' });
            builder.addMutationField({ name: 'm1', fieldDef: 'm1: String' });

            const stats = builder.getStats();

            expect(stats.queries).toBe(2);
            expect(stats.mutations).toBe(1);
            expect(stats.subscriptions).toBe(0);
        });
    });
});
