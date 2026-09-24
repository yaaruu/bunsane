/**
 * Multi-key keyset pagination.
 *
 * Walking pages with a composite cursor must recover the same ordered set as
 * one unbounded sorted exec — no duplicates, no gaps — including mixed
 * ASC/DESC, NULLS FIRST/LAST, ties, and 'before'.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, or, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

@Component
class MkPrimary extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
    @CompData() rank: number = 0;
    @CompData() name: string = '';
}

@Component
class MkExtra extends BaseComponent {
    @CompData({ indexed: true }) bucket: string = '';
    @CompData() tier: string = '';
}

type Row = {
    score: number | null;
    rank: number | null;
    name: string | null;
    tier: string | null;
};

const SPEC: Row[] = [
    { score: 1, rank: 1, name: 'b', tier: 'gold' },
    { score: 1, rank: 1, name: 'a', tier: 'gold' },
    { score: 1, rank: 1, name: 'a', tier: 'silver' },
    { score: 1, rank: 2, name: 'c', tier: 'gold' },
    { score: 1, rank: 2, name: null, tier: 'bronze' },
    { score: 1, rank: null, name: 'b', tier: 'gold' },
    { score: 1, rank: null, name: 'a', tier: null },
    { score: 1, rank: 0, name: 'm', tier: 'gold' },
    { score: 2, rank: 1, name: 'a', tier: 'silver' },
    { score: 2, rank: 1, name: 'z', tier: 'gold' },
    { score: 2, rank: 5, name: 'a', tier: 'bronze' },
    { score: 2, rank: null, name: null, tier: 'gold' },
    { score: null, rank: 1, name: 'a', tier: 'gold' },
    { score: null, rank: 1, name: 'b', tier: 'silver' },
    { score: null, rank: 2, name: null, tier: null },
    { score: null, rank: null, name: 'a', tier: 'bronze' },
    { score: null, rank: 0, name: 'm', tier: 'gold' },
    { score: 0, rank: 9, name: 'q', tier: 'gold' },
    { score: 5, rank: 1, name: 'a', tier: 'silver' },
    { score: 5, rank: 1, name: 'a', tier: 'gold' },
    { score: 3, rank: 3, name: 'd', tier: 'bronze' },
    { score: 3, rank: 4, name: 'd', tier: 'gold' },
    { score: 4, rank: 1, name: null, tier: 'silver' },
    { score: 9, rank: 8, name: 'z', tier: 'gold' },
];

type SortValue = string | number | Date | null;

async function assertKeyset(
    make: () => Query<any>,
    valuesOf: (id: string) => SortValue[],
): Promise<void> {
    const all = await make().take(1000).exec();
    const expected = all.map((e) => e.id);
    expect(expected.length).toBe(SPEC.length);
    expect(new Set(expected).size).toBe(expected.length);

    const walk = async (pageSize: number): Promise<string[]> => {
        const got: string[] = [];
        let token: string | undefined;
        for (let guard = 0; guard < expected.length + 2; guard++) {
            let q = make().take(pageSize);
            if (token) q = q.sortedCursor(token);
            const page = await q.exec();
            if (page.length === 0) break;
            got.push(...page.map((e) => e.id));
            const last = page[page.length - 1]!;
            token = Query.encodeSortedCursor(valuesOf(last.id), last.id);
        }
        return got;
    };

    expect(await walk(1)).toEqual(expected);
    expect(await walk(3)).toEqual(expected);

    for (let i = 1; i < expected.length; i++) {
        const back = await make()
            .sortedCursor(Query.encodeSortedCursor(valuesOf(expected[i]!), expected[i]!), 'before')
            .take(1)
            .exec();
        expect(back.map((e) => e.id)).toEqual([expected[i - 1]!]);
    }
    const beforeFirst = await make()
        .sortedCursor(Query.encodeSortedCursor(valuesOf(expected[0]!), expected[0]!), 'before')
        .take(2)
        .exec();
    expect(beforeFirst).toEqual([]);

    const page1 = await make().take(4).exec();
    const page2 = await make()
        .sortedCursor(Query.encodeSortedCursor(valuesOf(page1[3]!.id), page1[3]!.id))
        .take(4)
        .exec();
    expect(page2.length).toBe(4);
    const backPage = await make()
        .sortedCursor(Query.encodeSortedCursor(valuesOf(page2[0]!.id), page2[0]!.id), 'before')
        .take(4)
        .exec();
    expect(backPage.map((e) => e.id)).toEqual(page1.map((e) => e.id));
}

describe('sorted cursor token compatibility', () => {
    test('legacy single-key tokens decode; multi-key tokens round-trip every value', () => {
        const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        const legacy = Buffer.from(JSON.stringify({ v: '42', id })).toString('base64');
        const decoded = Query.decodeSortedCursor(legacy);
        expect(decoded.id).toBe(id);
        expect(decoded.v).toBe('42');
        expect(decoded.vs).toEqual(['42']);

        const issued = Query.decodeSortedCursor(Query.encodeSortedCursor(42, id));
        expect(issued.v).toBe('42');
        expect(issued.vs).toEqual(['42']);
        expect(Query.encodeSortedCursor(42, id)).toBe(legacy);

        const multi = Query.decodeSortedCursor(Query.encodeSortedCursor([1, null, 'b'], id));
        expect(multi.v).toBe('1');
        expect(multi.vs).toEqual(['1', null, 'b']);
        expect(multi.id).toBe(id);
        expect(Query.decodeSortedCursor(Query.encodeSortedCursor([null], id)).vs).toEqual([null]);
        expect(() => Query.encodeSortedCursor([], id)).toThrow(/at least one sort value/);
    });
});

describe('multi-key keyset pagination', () => {
    const ctx = createTestContext();
    let prefix = '';
    let byId = new Map<string, Row>();
    let stamps = new Map<string, { created: Date; updated: Date }>();

    beforeAll(async () => {
        await ensureComponentsRegistered(MkPrimary, MkExtra);
    });

    beforeEach(async () => {
        prefix = `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        byId = new Map();
        stamps = new Map();
        const ids: string[] = [];

        for (const row of SPEC) {
            const entity = ctx.tracker.create();
            entity.add(MkPrimary, {
                label: prefix,
                score: row.score ?? 0,
                rank: row.rank ?? 0,
                name: row.name ?? '',
            });
            entity.add(MkExtra, {
                bucket: prefix,
                tier: row.tier ?? '',
            });
            await entity.save();
            ids.push(entity.id);
            byId.set(entity.id, row);
            if (row.score === null) {
                await ctx.db.unsafe(
                    `UPDATE components SET data = jsonb_set(data, '{score}', 'null') WHERE entity_id = $1::uuid AND data ? 'label' AND deleted_at IS NULL`,
                    [entity.id],
                );
            }
            if (row.rank === null) {
                await ctx.db.unsafe(
                    `UPDATE components SET data = jsonb_set(data, '{rank}', 'null') WHERE entity_id = $1::uuid AND data ? 'label' AND deleted_at IS NULL`,
                    [entity.id],
                );
            }
            if (row.name === null) {
                await ctx.db.unsafe(
                    `UPDATE components SET data = jsonb_set(data, '{name}', 'null') WHERE entity_id = $1::uuid AND data ? 'label' AND deleted_at IS NULL`,
                    [entity.id],
                );
            }
            if (row.tier === null) {
                await ctx.db.unsafe(
                    `UPDATE components SET data = jsonb_set(data, '{tier}', 'null') WHERE entity_id = $1::uuid AND data ? 'bucket' AND deleted_at IS NULL`,
                    [entity.id],
                );
            }
        }

        for (let i = 0; i < ids.length; i++) {
            const created = new Date(Date.UTC(2024, 0, 1, 0, 0, Math.floor(i / 4)));
            const updated = new Date(Date.UTC(2024, 6, 1, 0, i, 0));
            stamps.set(ids[i]!, { created, updated });
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3::uuid`,
                [created.toISOString(), updated.toISOString(), ids[i]],
            );
        }
    });

    const scoped = () =>
        new Query().with(MkPrimary, { filters: [Query.filter('label', FilterOp.EQ, prefix)] });

    const values = (id: string, keys: Array<keyof Row>): SortValue[] => {
        const row = byId.get(id);
        if (!row) throw new Error(`missing seed row ${id}`);
        return keys.map((key) => row[key]);
    };

    test('2-key mixed ASC/DESC with heavy ties on the first key', async () => {
        await assertKeyset(
            () => scoped().with(MkExtra).sortBy(MkPrimary, 'score', 'ASC').sortBy(MkPrimary, 'name', 'DESC'),
            (id) => values(id, ['score', 'name']),
        );
    });

    test('2-key NULLS FIRST on both keys', async () => {
        await assertKeyset(
            () => scoped().sortBy(MkPrimary, 'score', 'DESC', true).sortBy(MkPrimary, 'name', 'ASC', true),
            (id) => values(id, ['score', 'name']),
        );
    });

    test('3-key mixed directions with NULLS FIRST and LAST and ties', async () => {
        await assertKeyset(
            () => scoped()
                .sortBy(MkPrimary, 'score', 'ASC', false)
                .sortBy(MkPrimary, 'rank', 'DESC', true)
                .sortBy(MkPrimary, 'name', 'ASC', false),
            (id) => values(id, ['score', 'rank', 'name']),
        );
    });

    test('cross-component 2-key sort keeps leaf order', async () => {
        await assertKeyset(
            () => new Query()
                .with(MkPrimary, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
                .with(MkExtra, { filters: [Query.filter('bucket', FilterOp.EQ, prefix)] })
                .sortBy(MkPrimary, 'score', 'ASC')
                .sortBy(MkExtra, 'tier', 'DESC', true),
            (id) => values(id, ['score', 'tier']),
        );
    });

    test('OR + two sort keys pages forward and back', async () => {
        await assertKeyset(
            () => new Query()
                .with(MkPrimary)
                .with(or([{ component: MkPrimary, filters: [Query.filter('label', FilterOp.EQ, prefix)] }]))
                .sortBy(MkPrimary, 'score', 'DESC')
                .sortBy(MkPrimary, 'rank', 'ASC', true),
            (id) => values(id, ['score', 'rank']),
        );
    });

    test('sortByCreatedAt + sortByUpdatedAt keyset matches unbounded order', async () => {
        await assertKeyset(
            () => scoped().sortByCreatedAt('ASC').sortByUpdatedAt('ASC'),
            (id) => {
                const stamp = stamps.get(id);
                if (!stamp) throw new Error(`missing stamp ${id}`);
                return [stamp.created, stamp.updated];
            },
        );
        await assertKeyset(
            () => scoped().sortByCreatedAt('ASC').sortByUpdatedAt('DESC'),
            (id) => {
                const stamp = stamps.get(id);
                if (!stamp) throw new Error(`missing stamp ${id}`);
                return [stamp.created, stamp.updated];
            },
        );
        await assertKeyset(
            () => scoped().sortByCreatedAt('DESC', true).sortByUpdatedAt('ASC'),
            (id) => {
                const stamp = stamps.get(id);
                if (!stamp) throw new Error(`missing stamp ${id}`);
                return [stamp.created, stamp.updated];
            },
        );
    });

    test('token width must match the sort key count', async () => {
        const id = byId.keys().next().value as string;
        await expect(
            scoped().sortBy(MkPrimary, 'score', 'ASC').sortBy(MkPrimary, 'name', 'DESC')
                .sortedCursor(Query.encodeSortedCursor(1, id)).take(2).exec(),
        ).rejects.toThrow(/sort value/);
        await expect(
            scoped().sortBy(MkPrimary, 'score', 'ASC')
                .sortedCursor(Query.encodeSortedCursor([1, 'a'], id)).take(2).exec(),
        ).rejects.toThrow(/sort value/);
        await expect(
            scoped().sortedCursor(Query.encodeSortedCursor(1, id)).take(2).exec(),
        ).rejects.toThrow(/requires sortBy/);
    });

});
