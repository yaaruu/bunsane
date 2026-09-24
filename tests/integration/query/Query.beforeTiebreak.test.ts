/**
 * 'before' keyset must use the same id tie-break as the flipped ORDER BY.
 * Equal sort keys (and NULL sort keys) used to return the next row instead
 * of the previous one because the predicate hard-coded `id > $id`.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Query, or, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';
import db from '../../../database';

@Component
class TieScore extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
}

async function pageBack(
    make: () => Query<any>,
    sort: (q: Query<any>) => Query<any>,
    valueOf: (id: string) => Promise<string | number | Date | null>,
): Promise<void> {
    const all = await sort(make()).take(20).exec();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const page1 = all.slice(0, 1);
    const page2 = all.slice(1, 2);
    const cursor = Query.encodeSortedCursor(await valueOf(page2[0]!.id), page2[0]!.id);
    const back = await sort(make()).sortedCursor(cursor, 'before').take(1).exec();
    expect(back.map((e) => e.id)).toEqual(page1.map((e) => e.id));
}

describe("sortedCursor before respects id tie-break", () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(TieScore);
    });

    test('component sortBy with equal scores pages back to the previous id', async () => {
        const label = `tie-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const e = ctx.tracker.create();
            e.add(TieScore, { label, score: 10 });
            await e.save();
            ids.push(e.id);
        }
        await pageBack(
            () => new Query().with(TieScore, { filters: [Query.filter('label', FilterOp.EQ, label)] }),
            (q) => q.sortBy(TieScore, 'score', 'ASC'),
            async () => 10,
        );
        expect(ids.length).toBe(3);
    });

    test('sortByCreatedAt with equal timestamps pages back to the previous id', async () => {
        const label = `tie-ca-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const e = ctx.tracker.create();
            e.add(TieScore, { label, score: i });
            await e.save();
            ids.push(e.id);
        }
        const ts = '2024-01-01T00:00:01.000Z';
        for (const id of ids) {
            await db.unsafe(`UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`, [ts, id]);
        }
        await pageBack(
            () => new Query().with(TieScore, { filters: [Query.filter('label', FilterOp.EQ, label)] }),
            (q) => q.sortByCreatedAt('ASC'),
            async () => new Date(ts),
        );
    });

    test('OR + sortBy with equal scores pages back to the previous id', async () => {
        const label = `tie-or-${Date.now().toString(36)}`;
        for (let i = 0; i < 3; i++) {
            const e = ctx.tracker.create();
            e.add(TieScore, { label, score: 10 });
            await e.save();
        }
        await pageBack(
            () => new Query()
                .with(TieScore)
                .with(or([{ component: TieScore, filters: [Query.filter('label', FilterOp.EQ, label)] }])),
            (q) => q.sortBy(TieScore, 'score', 'ASC'),
            async () => 10,
        );
    });

    test('NULL sort keys page back within the null region', async () => {
        const label = `tie-null-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const e = ctx.tracker.create();
            e.add(TieScore, { label, score: 0 });
            await e.save();
            ids.push(e.id);
            await db.unsafe(
                `UPDATE components SET data = jsonb_set(data, '{score}', 'null') WHERE entity_id = $1::uuid`,
                [e.id],
            );
        }
        await pageBack(
            () => new Query().with(TieScore, { filters: [Query.filter('label', FilterOp.EQ, label)] }),
            (q) => q.sortBy(TieScore, 'score', 'ASC'),
            async () => null,
        );
        expect(new Set(ids).size).toBe(3);
    });
});
