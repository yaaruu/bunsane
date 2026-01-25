/**
 * Tests for ResolverBuilder
 * Tests GraphQL resolver building
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { ResolverBuilder } from '../../../gql/builders/ResolverBuilder';

describe('ResolverBuilder', () => {
    let builder: ResolverBuilder;

    beforeEach(() => {
        builder = new ResolverBuilder();
    });

    describe('addResolver()', () => {
        test('adds resolver to collection', () => {
            const mockService = { myMethod: () => 'result' };
            builder.addResolver({
                name: 'myMethod',
                propertyKey: 'myMethod',
                type: 'Query',
                service: mockService,
                hasInput: false
            });

            const stats = builder.getStats();
            expect(stats.queries).toBe(1);
        });

        test('categorizes Query resolvers', () => {
            const mockService = { getUser: () => {} };
            builder.addResolver({
                name: 'getUser',
                propertyKey: 'getUser',
                type: 'Query',
                service: mockService,
                hasInput: false
            });

            const stats = builder.getStats();
            expect(stats.queries).toBe(1);
        });

        test('categorizes Mutation resolvers', () => {
            const mockService = { createUser: () => {} };
            builder.addResolver({
                name: 'createUser',
                propertyKey: 'createUser',
                type: 'Mutation',
                service: mockService,
                hasInput: true
            });

            const stats = builder.getStats();
            expect(stats.mutations).toBe(1);
        });

        test('categorizes Subscription resolvers', () => {
            const mockService = { userCreated: () => {} };
            builder.addResolver({
                name: 'userCreated',
                propertyKey: 'userCreated',
                type: 'Subscription',
                service: mockService,
                hasInput: false
            });

            const stats = builder.getStats();
            expect(stats.subscriptions).toBe(1);
        });
    });

    describe('getResolvers()', () => {
        test('returns empty object when no resolvers', () => {
            const resolvers = builder.getResolvers();
            expect(resolvers.Query).toEqual({});
            expect(resolvers.Mutation).toEqual({});
        });

        test('returns Query resolvers', () => {
            const mockService = { getUser: () => 'user' };
            builder.addResolver({
                name: 'getUser',
                propertyKey: 'getUser',
                type: 'Query',
                service: mockService,
                hasInput: false
            });

            const resolvers = builder.getResolvers();
            expect(resolvers.Query!.getUser).toBeDefined();
        });

        test('returns Mutation resolvers', () => {
            const mockService = { createUser: () => 'user' };
            builder.addResolver({
                name: 'createUser',
                propertyKey: 'createUser',
                type: 'Mutation',
                service: mockService,
                hasInput: true
            });

            const resolvers = builder.getResolvers();
            expect(resolvers.Mutation!.createUser).toBeDefined();
        });
    });

    describe('getResolversForType()', () => {
        test('returns resolvers for specific type', () => {
            const mockService = { getUser: () => {}, getUsers: () => {} };
            builder.addResolver({
                name: 'getUser',
                propertyKey: 'getUser',
                type: 'Query',
                service: mockService,
                hasInput: false
            });
            builder.addResolver({
                name: 'getUsers',
                propertyKey: 'getUsers',
                type: 'Query',
                service: mockService,
                hasInput: false
            });

            const queryResolvers = builder.getResolversForType('Query');
            expect(Object.keys(queryResolvers).length).toBe(2);
        });

        test('returns empty object for type with no resolvers', () => {
            const resolvers = builder.getResolversForType('Subscription');
            expect(resolvers).toEqual({});
        });
    });

    describe('createResolverWithoutInput()', () => {
        test('creates resolver function', () => {
            const mockService = {
                getUser: async () => ({ id: '1', name: 'Test' })
            };

            const resolver = (builder as any).createResolverWithoutInput(mockService, 'getUser');
            expect(typeof resolver).toBe('function');
        });

        test('resolver calls service method', async () => {
            let called = false;
            const mockService = {
                getUser: async () => {
                    called = true;
                    return { id: '1' };
                }
            };

            const resolver = (builder as any).createResolverWithoutInput(mockService, 'getUser');
            await resolver({}, {}, {}, {} as any);
            expect(called).toBe(true);
        });
    });

    describe('createResolverWithInput()', () => {
        test('creates resolver function with input handling', () => {
            const mockService = {
                createUser: async (input: any) => ({ id: '1', ...input })
            };

            const resolver = (builder as any).createResolverWithInput(mockService, 'createUser');
            expect(typeof resolver).toBe('function');
        });

        test('resolver passes input to service', async () => {
            let receivedInput: any = null;
            const mockService = {
                createUser: async (input: any) => {
                    receivedInput = input;
                    return { id: '1', ...input };
                }
            };

            const resolver = (builder as any).createResolverWithInput(mockService, 'createUser');
            await resolver({}, { input: { name: 'Test' } }, {}, {} as any);
            expect(receivedInput).toEqual({ name: 'Test' });
        });
    });

    describe('clear()', () => {
        test('clears all resolvers', () => {
            const mockService = { getUser: () => {} };
            builder.addResolver({
                name: 'getUser',
                propertyKey: 'getUser',
                type: 'Query',
                service: mockService,
                hasInput: false
            });

            builder.clear();

            const stats = builder.getStats();
            expect(stats.queries).toBe(0);
            expect(stats.mutations).toBe(0);
            expect(stats.subscriptions).toBe(0);
        });
    });

    describe('getStats()', () => {
        test('returns accurate statistics', () => {
            const mockService = { m1: () => {}, m2: () => {}, m3: () => {} };

            builder.addResolver({ name: 'q1', propertyKey: 'q1', type: 'Query', service: mockService, hasInput: false });
            builder.addResolver({ name: 'q2', propertyKey: 'q2', type: 'Query', service: mockService, hasInput: false });
            builder.addResolver({ name: 'm1', propertyKey: 'm1', type: 'Mutation', service: mockService, hasInput: true });
            builder.addResolver({ name: 's1', propertyKey: 's1', type: 'Subscription', service: mockService, hasInput: false });

            const stats = builder.getStats();

            expect(stats.queries).toBe(2);
            expect(stats.mutations).toBe(1);
            expect(stats.subscriptions).toBe(1);
        });
    });
});
