/**
 * Integration tests for Query execution
 * Tests query execution against the database
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { Query, FilterOp } from '../../../query/Query';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

describe('Query Execution', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    describe('basic query execution', () => {
        test('exec() returns entities with specified component', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'QueryTest', email: 'query@example.com', age: 30 });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });

        test('populate() loads all component data', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'PopulateTest', email: 'populate@example.com', age: 25 });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .populate()
                .exec();

            const found = results.find(e => e.id === entity.id);
            expect(found).toBeDefined();
            expect(found?.getInMemory(TestUser)).toBeDefined();
        });

        test('returns empty array when no matches', async () => {
            // Query for entities with a unique component
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.EQ, 'definitely-does-not-exist@nowhere.com')]
                })
                .exec();

            expect(results.length).toBe(0);
        });
    });

    describe('findById()', () => {
        test('finds entity by ID', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'FindById', email: 'findby@example.com', age: 35 });
            await entity.save();

            const results = await new Query()
                .findById(entity.id)
                .exec();

            expect(results.length).toBe(1);
            expect(results[0]!.id).toBe(entity.id);
        });

        test('findOneById returns single entity', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'FindOne', email: 'findone@example.com', age: 40 });
            await entity.save();

            const result = await new Query().findOneById(entity.id);

            expect(result).not.toBeNull();
            expect(result?.id).toBe(entity.id);
        });

        test('findOneById returns null for non-existent ID', async () => {
            const result = await new Query().findOneById('00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });
    });

    describe('filtering', () => {
        beforeEach(async () => {
            // Create test data
            const entity1 = ctx.tracker.create();
            entity1.add(TestUser, { name: 'Alice', email: 'alice@example.com', age: 25 });
            await entity1.save();

            const entity2 = ctx.tracker.create();
            entity2.add(TestUser, { name: 'Bob', email: 'bob@example.com', age: 35 });
            await entity2.save();

            const entity3 = ctx.tracker.create();
            entity3.add(TestUser, { name: 'Charlie', email: 'charlie@example.com', age: 45 });
            await entity3.save();
        });

        test('EQ filter finds exact match', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'Alice')]
                })
                .populate()
                .exec();

            const alice = results.find(e => e.getInMemory(TestUser)?.name === 'Alice');
            expect(alice).toBeDefined();
        });

        test('GT filter finds greater values', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.GT, 30)]
                })
                .populate()
                .exec();

            for (const entity of results) {
                const user = entity.getInMemory(TestUser);
                if (user) {
                    expect(user.age).toBeGreaterThan(30);
                }
            }
        });

        test('LT filter finds lesser values', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('age', FilterOp.LT, 40)]
                })
                .populate()
                .exec();

            for (const entity of results) {
                const user = entity.getInMemory(TestUser);
                if (user) {
                    expect(user.age).toBeLessThan(40);
                }
            }
        });

        test('LIKE filter finds partial matches', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, '%example.com')]
                })
                .populate()
                .exec();

            expect(results.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('pagination', () => {
        beforeEach(async () => {
            // Create multiple entities for pagination
            for (let i = 0; i < 5; i++) {
                const entity = ctx.tracker.create();
                entity.add(TestUser, {
                    name: `PaginationUser${i}`,
                    email: `page${i}@example.com`,
                    age: 20 + i
                });
                await entity.save();
            }
        });

        test('take() limits results', async () => {
            const results = await new Query()
                .with(TestUser)
                .take(2)
                .exec();

            expect(results.length).toBeLessThanOrEqual(2);
        });

        test('offset() skips results', async () => {
            const allResults = await new Query()
                .with(TestUser)
                .exec();

            const offsetResults = await new Query()
                .with(TestUser)
                .offset(2)
                .take(100)
                .exec();

            expect(offsetResults.length).toBe(Math.max(0, allResults.length - 2));
        });

        test('take() and offset() work together', async () => {
            const results = await new Query()
                .with(TestUser)
                .take(2)
                .offset(1)
                .exec();

            expect(results.length).toBeLessThanOrEqual(2);
        });
    });

    describe('sorting', () => {
        beforeEach(async () => {
            const ages = [30, 20, 40, 25, 35];
            for (let i = 0; i < ages.length; i++) {
                const entity = ctx.tracker.create();
                entity.add(TestUser, {
                    name: `SortUser${i}`,
                    email: `sort${i}@example.com`,
                    age: ages[i]!
                });
                await entity.save();
            }
        });

        test('sortBy ASC orders correctly', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, 'sort%@example.com')]
                })
                .sortBy(TestUser, 'age', 'ASC')
                .populate()
                .exec();

            for (let i = 1; i < results.length; i++) {
                const prevAge = results[i - 1]!.getInMemory(TestUser)?.age ?? 0;
                const currAge = results[i]!.getInMemory(TestUser)?.age ?? 0;
                expect(currAge).toBeGreaterThanOrEqual(prevAge);
            }
        });

        test('sortBy DESC orders correctly', async () => {
            const results = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('email', FilterOp.LIKE, 'sort%@example.com')]
                })
                .sortBy(TestUser, 'age', 'DESC')
                .populate()
                .exec();

            for (let i = 1; i < results.length; i++) {
                const prevAge = results[i - 1]!.getInMemory(TestUser)?.age ?? 0;
                const currAge = results[i]!.getInMemory(TestUser)?.age ?? 0;
                expect(currAge).toBeLessThanOrEqual(prevAge);
            }
        });
    });

    describe('count()', () => {
        test('returns count of matching entities', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'CountTest', email: 'count@example.com', age: 30 });
            await entity.save();

            const count = await new Query()
                .with(TestUser)
                .count();

            expect(count).toBeGreaterThanOrEqual(1);
        });

        test('count respects filters', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'UniqueCountName', email: 'uniquecount@example.com', age: 99 });
            await entity.save();

            const count = await new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', FilterOp.EQ, 'UniqueCountName')]
                })
                .count();

            expect(count).toBe(1);
        });
    });

    describe('multiple components', () => {
        test('with() multiple components finds entities with all', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'MultiComp', email: 'multi@example.com', age: 30 });
            entity.add(TestProduct, { sku: 'MULTI', name: 'Multi Product', price: 50, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .with(TestProduct)
                .populate()
                .exec();

            const found = results.find(e => e.id === entity.id);
            expect(found).toBeDefined();
            expect(found?.getInMemory(TestUser)).toBeDefined();
            expect(found?.getInMemory(TestProduct)).toBeDefined();
        });

        test('without() excludes entities with component', async () => {
            const withProduct = ctx.tracker.create();
            withProduct.add(TestUser, { name: 'WithProduct', email: 'withprod@example.com', age: 25 });
            withProduct.add(TestProduct, { sku: 'WITH', name: 'With', price: 10, inStock: true });
            await withProduct.save();

            const withoutProduct = ctx.tracker.create();
            withoutProduct.add(TestUser, { name: 'WithoutProduct', email: 'withoutprod@example.com', age: 30 });
            await withoutProduct.save();

            const results = await new Query()
                .with(TestUser)
                .without(TestProduct)
                .exec();

            const hasWithProduct = results.some(e => e.id === withProduct.id);
            expect(hasWithProduct).toBe(false);
        });
    });

    describe('excludeEntityId()', () => {
        test('excludes specific entity from results', async () => {
            const entity1 = ctx.tracker.create();
            entity1.add(TestUser, { name: 'Include', email: 'include@example.com', age: 30 });
            await entity1.save();

            const entity2 = ctx.tracker.create();
            entity2.add(TestUser, { name: 'Exclude', email: 'exclude@example.com', age: 30 });
            await entity2.save();

            const results = await new Query()
                .with(TestUser)
                .excludeEntityId(entity2.id)
                .exec();

            const hasExcluded = results.some(e => e.id === entity2.id);
            expect(hasExcluded).toBe(false);
        });
    });

    describe('eagerLoadComponents()', () => {
        test('preloads specified components', async () => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: 'Eager', email: 'eager@example.com', age: 30 });
            entity.add(TestProduct, { sku: 'EAGER', name: 'Eager Product', price: 20, inStock: true });
            await entity.save();

            const results = await new Query()
                .with(TestUser)
                .eagerLoadComponents([TestProduct])
                .exec();

            const found = results.find(e => e.id === entity.id);
            expect(found?.hasInMemory(TestProduct)).toBe(true);
        });
    });
});
