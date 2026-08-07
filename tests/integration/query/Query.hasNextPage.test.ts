/**
 * RP-01: explicit .take(N) fetches N+1 and exposes hasNextPage without count().
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

@Component
class HnpData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() n: number = 0;
}

let run = 0;

describe('Query hasNextPage (RP-01)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(HnpData);
    });

    let prefix: string;

    beforeEach(async () => {
        run++;
        prefix = `hnp-${Date.now().toString(36)}-${run}`;
        for (let i = 0; i < 7; i++) {
            const e = ctx.tracker.create();
            e.add(HnpData, { label: prefix, n: i });
            await e.save();
        }
    });

    test('take smaller than set → hasNextPage true and length === take', async () => {
        const q = new Query()
            .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .take(3);
        const rows = await q.exec();
        expect(rows.length).toBe(3);
        expect(q.getLastRouteInfo().hasNextPage).toBe(true);
        expect(q.getLastRouteInfo().surface).toBe('legacy');
    });

    test('take larger than set → hasNextPage false', async () => {
        const q = new Query()
            .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .take(20);
        const rows = await q.exec();
        expect(rows.length).toBe(7);
        expect(q.getLastRouteInfo().hasNextPage).toBe(false);
    });

    test('take exact size → hasNextPage false', async () => {
        const q = new Query()
            .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .take(7);
        const rows = await q.exec();
        expect(rows.length).toBe(7);
        expect(q.getLastRouteInfo().hasNextPage).toBe(false);
    });

    test('count() still returns exact total (independent of hasNextPage)', async () => {
        const count = await new Query()
            .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .count();
        expect(count).toBe(7);
    });

    test('cursor + sortBy throws (RP-06b)', async () => {
        const first = await new Query()
            .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
            .sortBy(HnpData, 'n', 'ASC')
            .take(2)
            .exec();
        expect(first.length).toBe(2);

        await expect(
            new Query()
                .with(HnpData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
                .sortBy(HnpData, 'n', 'ASC')
                .take(2)
                .cursor(first[1]!.id)
                .exec()
        ).rejects.toThrow(/sortedCursor/);
    });
});
