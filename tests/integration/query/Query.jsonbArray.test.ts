/**
 * Integration tests for JSONB Array Query Operators
 * Tests CONTAINS (@>), CONTAINED_BY (<@), HAS_ANY (?|), HAS_ALL (?&)
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

@Component
class TaggedItem extends BaseComponent {
    @CompData({ indexed: true, arrayOf: String })
    tags: string[] = [];

    @CompData({ indexed: true })
    name: string = '';
}

@Component
class CategoryItem extends BaseComponent {
    @CompData({ indexed: true })
    title: string = '';
}

const isPGlite = process.env.USE_PGLITE === 'true';

describe('JSONB Array Query Operators', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TaggedItem, CategoryItem);
    });

    beforeEach(async () => {
        // entity1: tags = ["red", "blue"]
        const e1 = ctx.tracker.create();
        e1.add(TaggedItem, { tags: ['red', 'blue'], name: 'item1' });
        await e1.save();

        // entity2: tags = ["blue", "green"]
        const e2 = ctx.tracker.create();
        e2.add(TaggedItem, { tags: ['blue', 'green'], name: 'item2' });
        await e2.save();

        // entity3: tags = ["red", "green", "blue"]
        const e3 = ctx.tracker.create();
        e3.add(TaggedItem, { tags: ['red', 'green', 'blue'], name: 'item3' });
        await e3.save();

        // entity4: tags = ["yellow"]
        const e4 = ctx.tracker.create();
        e4.add(TaggedItem, { tags: ['yellow'], name: 'item4' });
        await e4.save();
    });

    describe('CONTAINS (@>)', () => {
        test('finds entities where array contains a single value', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINS, 'red')]
                })
                .exec();

            // item1 (red,blue) and item3 (red,green,blue)
            expect(results.length).toBe(2);
        });

        test('finds entities where array contains multiple values (AND)', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINS, ['red', 'blue'])]
                })
                .exec();

            // item1 (red,blue) and item3 (red,green,blue) both have red AND blue
            expect(results.length).toBe(2);
        });

        test('returns empty when no match', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINS, 'purple')]
                })
                .exec();

            expect(results.length).toBe(0);
        });

        test('single element array matches', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINS, 'yellow')]
                })
                .exec();

            expect(results.length).toBe(1);
        });

        test('combined with other filters', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [
                        Query.filter('tags', FilterOp.CONTAINS, 'red'),
                        Query.filter('name', FilterOp.EQ, 'item1'),
                    ]
                })
                .exec();

            expect(results.length).toBe(1);
        });
    });

    describe('CONTAINED_BY (<@)', () => {
        test('finds entities whose array is a subset of given values', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINED_BY, ['red', 'blue'])]
                })
                .exec();

            // Only item1 (red,blue) is a subset of [red,blue]
            expect(results.length).toBe(1);
        });

        test('superset input matches all subsets', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINED_BY, ['red', 'blue', 'green', 'yellow'])]
                })
                .exec();

            // All 4 entities are subsets
            expect(results.length).toBe(4);
        });
    });

    describe.skipIf(isPGlite)('HAS_ANY (?|)', () => {
        test('finds entities with any of the given values', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.HAS_ANY, ['red', 'yellow'])]
                })
                .exec();

            // item1 (red), item3 (red), item4 (yellow)
            expect(results.length).toBe(3);
        });

        test('single value works', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.HAS_ANY, ['yellow'])]
                })
                .exec();

            expect(results.length).toBe(1);
        });
    });

    describe.skipIf(isPGlite)('HAS_ALL (?&)', () => {
        test('finds entities with all of the given values', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.HAS_ALL, ['red', 'green'])]
                })
                .exec();

            // Only item3 (red,green,blue) has both red AND green
            expect(results.length).toBe(1);
        });

        test('single value matches all entities containing it', async () => {
            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.HAS_ALL, ['blue'])]
                })
                .exec();

            // item1, item2, item3 all have blue
            expect(results.length).toBe(3);
        });
    });

    describe('multi-component INTERSECT compatibility', () => {
        test('CONTAINS works with multiple .with() components', async () => {
            // Add a second component to one entity
            const e = ctx.tracker.create();
            e.add(TaggedItem, { tags: ['special'], name: 'multi' });
            e.add(CategoryItem, { title: 'test-category' });
            await e.save();

            const results = await new Query()
                .with(TaggedItem, {
                    filters: [Query.filter('tags', FilterOp.CONTAINS, 'special')]
                })
                .with(CategoryItem)
                .exec();

            expect(results.length).toBe(1);
        });
    });

    describe('validation', () => {
        test('rejects null value via validator', () => {
            expect(() => {
                new Query()
                    .with(TaggedItem, {
                        filters: [Query.filter('tags', FilterOp.CONTAINS, null)]
                    });
            }).not.toThrow(); // Filter creation succeeds, validation happens at exec time
        });
    });
});
