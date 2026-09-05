/**
 * RP-03 integration: multi-filter / multi-component correctness after
 * INTERSECT pushdown + same-component EXISTS coalesce.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

@Component
class FpTagA extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class FpTagB extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class FpData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
    @CompData({ indexed: true }) status: string = '';
    @CompData() active: boolean = false;
}

let run = 0;

describe('Query filter pushdown / coalesce (RP-03)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(FpTagA, FpTagB, FpData);
    });

    let prefix: string;
    let expectedOpenActiveWithB: string[];
    let expectedScoreRange: string[];

    beforeEach(async () => {
        run++;
        prefix = `fp-${Date.now().toString(36)}-${run}`;
        expectedOpenActiveWithB = [];
        expectedScoreRange = [];

        for (let i = 0; i < 20; i++) {
            const status = i % 2 === 0 ? 'open' : 'closed';
            const active = i % 3 === 0;
            const hasB = i % 2 === 0;
            const e = ctx.tracker.create();
            e.add(FpTagA, {});
            if (hasB) e.add(FpTagB, {});
            e.add(FpData, { label: prefix, score: i, status, active });
            await e.save();

            if (status === 'open' && active && hasB) {
                expectedOpenActiveWithB.push(e.id);
            }
            if (i >= 5 && i < 15 && hasB) {
                expectedScoreRange.push(e.id);
            }
        }
        expectedOpenActiveWithB.sort();
        expectedScoreRange.sort();
    });

    test('two filters on same component + membership of another → correct id set', async () => {
        const rows = await new Query()
            .with(FpTagB)
            .with(FpData, {
                filters: [
                    Query.filter('label', FilterOp.EQ, prefix),
                    Query.filter('status', FilterOp.EQ, 'open'),
                    Query.filter('active', FilterOp.EQ, true),
                ],
            })
            .take(100)
            .exec();

        const ids = rows.map((e) => e.id).sort();
        expect(ids).toEqual(expectedOpenActiveWithB);
    });

    test('numeric range + membership INTERSECT matches expected', async () => {
        const rows = await new Query()
            .with(FpTagB)
            .with(FpData, {
                filters: [
                    Query.filter('label', FilterOp.EQ, prefix),
                    Query.filter('score', FilterOp.GTE, 5),
                    Query.filter('score', FilterOp.LT, 15),
                ],
            })
            .take(100)
            .exec();

        const ids = rows.map((e) => e.id).sort();
        expect(ids).toEqual(expectedScoreRange);
    });

    test('sort-driven multi-comp with multi-filter preserves membership + order', async () => {
        const rows = await new Query()
            .with(FpTagB)
            .with(FpData, {
                filters: [
                    Query.filter('label', FilterOp.EQ, prefix),
                    Query.filter('status', FilterOp.EQ, 'open'),
                ],
            })
            .sortBy(FpData, 'score', 'DESC')
            .take(50)
            .exec();

        const ids = rows.map((e) => e.id);
        // Membership: every result has open status and TagB (even indices open)
        const openWithB = expectedOpenActiveWithB.length
            ? // active subset is smaller; build full open+B set
              null
            : null;
        void openWithB;

        // All even scores that are open (i%2===0) and have TagB (same)
        const expected = Array.from({ length: 20 }, (_, i) => i)
            .filter((i) => i % 2 === 0)
            .sort((a, b) => b - a);

        // Recover scores from ordered results by matching seeded pattern via second query
        const allOpenB = await new Query()
            .with(FpTagB)
            .with(FpData, {
                filters: [
                    Query.filter('label', FilterOp.EQ, prefix),
                    Query.filter('status', FilterOp.EQ, 'open'),
                ],
            })
            .take(100)
            .exec();
        expect(ids.length).toBe(allOpenB.length);
        expect(new Set(ids)).toEqual(new Set(allOpenB.map((e) => e.id)));

        // Monotonic non-increasing scores via component data
        const scores: number[] = [];
        for (const e of rows) {
            const d = await e.get(FpData);
            scores.push(d!.score);
        }
        for (let i = 1; i < scores.length; i++) {
            expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
        }
        expect(scores[0]!).toBe(expected[0]!);
    });

    test('count/exec parity with multi-filter multi-component', async () => {
        const q = () =>
            new Query()
                .with(FpTagB)
                .with(FpData, {
                    filters: [
                        Query.filter('label', FilterOp.EQ, prefix),
                        Query.filter('status', FilterOp.EQ, 'open'),
                        Query.filter('active', FilterOp.EQ, true),
                    ],
                });

        const count = await q().count();
        const rows = await q().take(1000).exec();
        expect(count).toBe(rows.length);
        expect(count).toBe(expectedOpenActiveWithB.length);
    });
});
