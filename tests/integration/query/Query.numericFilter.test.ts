/**
 * RP-04 integration: numeric filters remain correct when validity predicate
 * is restated (including rows with dirty non-numeric JSON text — excluded,
 * not crash).
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';
import db from '../../../database';

@Component
class NumMetric extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData({ indexed: true }) value: number = 0;
}

let run = 0;

describe('Query numeric filter (RP-04)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(NumMetric);
    });

    let prefix: string;
    let highIds: string[];

    beforeEach(async () => {
        run++;
        prefix = `num-${Date.now().toString(36)}-${run}`;
        highIds = [];

        for (let i = 0; i < 10; i++) {
            const e = ctx.tracker.create();
            e.add(NumMetric, { label: prefix, value: i });
            await e.save();
            if (i >= 5) highIds.push(e.id);
        }
        highIds.sort();

        // Dirty non-numeric JSON for the same field on one extra entity —
        // must not crash range queries (partial index + restated predicate exclude it).
        const dirty = ctx.tracker.create();
        dirty.add(NumMetric, { label: prefix, value: 0 });
        await dirty.save();
        await db.unsafe(
            `UPDATE components SET data = jsonb_set(data, '{value}', '"not-a-number"')
             WHERE entity_id = $1::uuid AND type_id = (
               SELECT type_id FROM components WHERE entity_id = $1::uuid LIMIT 1
             )`,
            [dirty.id]
        );
    });

    test('numeric range returns expected ids and ignores dirty text values', async () => {
        const rows = await new Query()
            .with(NumMetric, {
                filters: [
                    Query.filter('label', FilterOp.EQ, prefix),
                    Query.filter('value', FilterOp.GTE, 5),
                ],
            })
            .take(100)
            .exec();

        const ids = rows.map((e) => e.id).sort();
        expect(ids).toEqual(highIds);
    });

    test('entity.save with numeric field still works after index path', async () => {
        const e = ctx.tracker.create();
        e.add(NumMetric, { label: prefix, value: 42 });
        await e.save();
        const got = await e.get(NumMetric);
        expect(got?.value).toBe(42);
    });
});
