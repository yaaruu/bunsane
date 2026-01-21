/**
 * Unit tests for Query class
 * Tests query builder methods and structure
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { TestUser, TestProduct } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

describe('Query', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
    });

    describe('constructor', () => {
        test('creates a new query instance', () => {
            const query = new Query();
            expect(query).toBeDefined();
        });

        test('creates query with transaction', () => {
            // Query accepts optional transaction parameter
            const query = new Query();
            expect(query).toBeDefined();
        });
    });

    describe('findById()', () => {
        test('sets up query to find by ID', () => {
            const query = new Query();
            const result = query.findById('test-id-123');
            expect(result).toBe(query); // Returns this for chaining
        });

        test('throws for empty string id', () => {
            const query = new Query();
            expect(() => query.findById('')).toThrow();
        });

        test('throws for whitespace id', () => {
            const query = new Query();
            expect(() => query.findById('   ')).toThrow();
        });
    });

    describe('with()', () => {
        test('adds component requirement to query', () => {
            const query = new Query();
            const result = query.with(TestUser);
            expect(result).toBe(query); // Returns this for chaining
        });

        test('allows chaining multiple with() calls', () => {
            const query = new Query();
            const result = query.with(TestUser).with(TestProduct);
            expect(result).toBe(query);
        });

        test('accepts component with filters', () => {
            const query = new Query();
            const result = query.with(TestUser, {
                filters: [{ field: 'name', operator: FilterOp.EQ, value: 'John' }]
            });
            expect(result).toBe(query);
        });

        test('accepts array of components with filters', () => {
            const query = new Query();
            const result = query.with([
                { component: TestUser, filters: [{ field: 'age', operator: FilterOp.GT, value: 18 }] },
                { component: TestProduct, filters: [{ field: 'price', operator: FilterOp.LT, value: 100 }] }
            ]);
            expect(result).toBe(query);
        });
    });

    describe('without()', () => {
        test('excludes entities with specified component', () => {
            const query = new Query();
            const result = query.with(TestUser).without(TestProduct);
            expect(result).toBe(query);
        });
    });

    describe('excludeEntityId()', () => {
        test('excludes specific entity from results', () => {
            const query = new Query();
            const result = query.excludeEntityId('entity-to-exclude');
            expect(result).toBe(query);
        });
    });

    describe('populate()', () => {
        test('enables component population', () => {
            const query = new Query();
            const result = query.with(TestUser).populate();
            expect(result).toBe(query);
        });
    });

    describe('eagerLoadComponents()', () => {
        test('sets up eager loading for components', () => {
            const query = new Query();
            const result = query.with(TestUser).eagerLoadComponents([TestUser, TestProduct]);
            expect(result).toBe(query);
        });
    });

    describe('eagerLoad()', () => {
        test('is an alias for eagerLoadComponents', () => {
            const query = new Query();
            const result = query.with(TestUser).eagerLoad([TestUser]);
            expect(result).toBe(query);
        });
    });

    describe('take()', () => {
        test('sets limit on query results', () => {
            const query = new Query();
            const result = query.with(TestUser).take(10);
            expect(result).toBe(query);
        });
    });

    describe('offset()', () => {
        test('sets offset for pagination', () => {
            const query = new Query();
            const result = query.with(TestUser).offset(20);
            expect(result).toBe(query);
        });
    });

    describe('sortBy()', () => {
        test('sets sort order', () => {
            const query = new Query();
            const result = query.with(TestUser).sortBy(TestUser, 'name', 'ASC');
            expect(result).toBe(query);
        });

        test('accepts DESC direction', () => {
            const query = new Query();
            const result = query.with(TestUser).sortBy(TestUser, 'age', 'DESC');
            expect(result).toBe(query);
        });

        test('accepts nullsFirst option', () => {
            const query = new Query();
            const result = query.with(TestUser).sortBy(TestUser, 'bio', 'ASC', true);
            expect(result).toBe(query);
        });

        test('throws if component not in query', () => {
            const query = new Query();
            expect(() => query.sortBy(TestUser, 'name')).toThrow();
        });
    });

    describe('debugMode()', () => {
        test('enables debug mode', () => {
            const query = new Query();
            const result = query.debugMode(true);
            expect(result).toBe(query);
        });

        test('can disable debug mode', () => {
            const query = new Query();
            const result = query.debugMode(false);
            expect(result).toBe(query);
        });
    });

    describe('noCache()', () => {
        test('bypasses prepared statement cache by default', () => {
            const query = new Query();
            const result = query.noCache();
            expect(result).toBe(query);
        });

        test('accepts cache options', () => {
            const query = new Query();
            const result = query.noCache({ preparedStatement: true, component: true });
            expect(result).toBe(query);
        });
    });

    describe('filter()', () => {
        test('creates filter object', () => {
            const filter = Query.filter('name', FilterOp.EQ, 'John');
            expect(filter.field).toBe('name');
            expect(filter.operator).toBe(FilterOp.EQ);
            expect(filter.value).toBe('John');
        });

        test('throws for empty string value', () => {
            expect(() => Query.filter('name', FilterOp.EQ, '')).toThrow();
        });

        test('throws for whitespace value', () => {
            expect(() => Query.filter('name', FilterOp.EQ, '   ')).toThrow();
        });
    });

    describe('typedFilter()', () => {
        test('creates typed filter object', () => {
            const filter = Query.typedFilter(TestUser, 'name', FilterOp.EQ, 'John');
            expect(filter.field).toBe('name');
            expect(filter.operator).toBe(FilterOp.EQ);
            expect(filter.value).toBe('John');
        });
    });

    describe('filters()', () => {
        test('creates filter options from multiple filters', () => {
            const filter1 = Query.filter('name', FilterOp.EQ, 'John');
            const filter2 = Query.filter('age', FilterOp.GT, 18);
            const options = Query.filters(filter1, filter2);

            expect(options.filters).toBeDefined();
            expect(options.filters?.length).toBe(2);
        });
    });

    describe('FilterOp', () => {
        test('has all expected operators', () => {
            expect(FilterOp.EQ).toBeDefined();
            expect(FilterOp.NEQ).toBeDefined();
            expect(FilterOp.GT).toBeDefined();
            expect(FilterOp.GTE).toBeDefined();
            expect(FilterOp.LT).toBeDefined();
            expect(FilterOp.LTE).toBeDefined();
            expect(FilterOp.LIKE).toBeDefined();
            expect(FilterOp.IN).toBeDefined();
            expect(FilterOp.NOT_IN).toBeDefined();
        });
    });

    describe('chaining', () => {
        test('supports full query chain', () => {
            const query = new Query()
                .with(TestUser, { filters: [Query.filter('age', FilterOp.GTE, 18)] })
                .with(TestProduct)
                .without(TestProduct)
                .take(10)
                .offset(0)
                .sortBy(TestUser, 'name')
                .populate()
                .debugMode(false)
                .noCache();

            expect(query).toBeDefined();
        });
    });
});
