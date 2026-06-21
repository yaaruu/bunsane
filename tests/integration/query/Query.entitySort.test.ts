/**
 * Native entity-column sort (created_at / updated_at).
 *
 * Regression for the bug where `.sortBy(SomeComponent)` threw unless the
 * component was also `.with()`-ed — services sorted by creation time had to
 * introduce a redundant CreatedAt component duplicating `entities.created_at`.
 *
 * `sortByCreatedAt()` / `sortByUpdatedAt()` sort the native `entities` column
 * directly: no component, no `.with()`, no throw. These tests pin deterministic
 * created_at values via direct SQL so ordering is unambiguous across engines.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

@Component
class ESTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class ESData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() idx: number = 0;
}

let runCounter = 0;

describe('Query native entity-column sort', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(ESTag, ESData);
    });

    const N = 8;
    let prefix: string;
    let idsByIndex: string[]; // idsByIndex[i] has the i-th oldest created_at

    beforeEach(async () => {
        runCounter++;
        prefix = `es-${Date.now().toString(36)}-${runCounter}`;
        idsByIndex = [];

        for (let i = 0; i < N; i++) {
            const e = ctx.tracker.create();
            e.add(ESTag, {});
            e.add(ESData, { label: prefix, idx: i });
            await e.save();
            idsByIndex.push(e.id);
        }

        // Pin deterministic, strictly-increasing timestamps so created_at order
        // == insertion order regardless of how close the real saves landed.
        // updated_at is set to the REVERSE order to prove the two columns sort
        // independently.
        for (let i = 0; i < N; i++) {
            const created = new Date(Date.UTC(2021, 0, 1, 0, 0, i)).toISOString();
            const updated = new Date(Date.UTC(2021, 0, 1, 0, 0, N - i)).toISOString();
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3`,
                [created, updated, idsByIndex[i]]
            );
        }
    });

    const base = () =>
        new Query().with(ESData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] });

    async function ids(q: Query<any>): Promise<string[]> {
        const rows = await q.take(1000).exec();
        return rows.map(e => e.id);
    }
    // Preserves the query's own .take()/.offset() (no clobbering take).
    async function idsRaw(q: Query<any>): Promise<string[]> {
        const rows = await q.exec();
        return rows.map(e => e.id);
    }

    test('sortByCreatedAt does not throw and returns the full membership set', async () => {
        const sorted = new Set(await ids(base().sortByCreatedAt('ASC')));
        const unsorted = new Set(await ids(base()));
        expect(sorted).toEqual(unsorted);
        expect(sorted.size).toBe(N);
    });

    test('created_at ASC == insertion order, DESC == reverse', async () => {
        const asc = await ids(base().sortByCreatedAt('ASC'));
        const desc = await ids(base().sortByCreatedAt('DESC'));
        expect(asc).toEqual(idsByIndex);
        expect(desc).toEqual([...idsByIndex].reverse());
    });

    test('updated_at sorts independently of created_at', async () => {
        // updated_at was assigned in reverse, so ASC(updated_at) == reverse(insertion)
        const asc = await ids(base().sortByUpdatedAt('ASC'));
        expect(asc).toEqual([...idsByIndex].reverse());
    });

    test('LIMIT/OFFSET apply AFTER the entity sort (not before)', async () => {
        const page1 = await idsRaw(base().sortByCreatedAt('ASC').take(3));
        const page2 = await idsRaw(base().sortByCreatedAt('ASC').take(3).offset(3));
        expect(page1).toEqual(idsByIndex.slice(0, 3));
        expect(page2).toEqual(idsByIndex.slice(3, 6));
        // No overlap, contiguous coverage.
        expect(new Set([...page1, ...page2]).size).toBe(6);
    });

    test('works with a multi-component (INTERSECT) base set', async () => {
        const q = new Query()
            .with(ESTag)
            .with(ESData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .sortByCreatedAt('DESC');
        const got = await ids(q);
        expect(got).toEqual([...idsByIndex].reverse());
    });

    test('no CreatedAt component required — sort works without .with()-ing one', async () => {
        // The whole point: sorting by creation time needs zero extra components.
        // base() only requires ESData (for scoping); no timestamp component exists.
        const got = await ids(base().sortByCreatedAt('ASC'));
        expect(got).toEqual(idsByIndex);
    });
});
