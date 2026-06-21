/**
 * Query invariant ("property") tests.
 *
 * Entities are dynamic: any mix of tags + data components, any combination of
 * filters / sort / pagination / exclusion / OR. Enumerating expected ids for
 * every combination is hopeless and brittle. Instead these tests assert
 * structural INVARIANTS that must hold for ANY correct query engine, over a
 * controlled dataset:
 *
 *   1. count() == exec(unbounded).length                  (count/exec parity)
 *   2. paginating every page == one unbounded exec        (no gaps/dupes/extras)
 *   3. sortBy changes ORDER, never MEMBERSHIP              (+ result is monotonic)
 *   4. cursor pagination recovers the same set as offset
 *   5. with(X) and without(X) partition the base set       (disjoint + covering)
 *   6. OR queries obey 1+2; AND-filters compose with OR
 *
 * These hold regardless of which internal path (CTE / INTERSECT / sort-driven
 * scan / single-pass / OrNode fallback / direct-partition) the planner picks,
 * so they are a durable regression net for future query-engine changes.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp, or } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

// Two pure membership markers ("tags") + one rich data component.
@Component
class InvTagA extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class InvTagB extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class InvData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
    @CompData({ indexed: true }) status: string = '';
    @CompData() active: boolean = false;
}

let runCounter = 0;

describe('Query invariants (dynamic component combinations)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(InvTagA, InvTagB, InvData);
    });

    const N = 24;
    let prefix: string;
    let seeded: Array<{ id: string; score: number; status: string; active: boolean; hasB: boolean }>;

    beforeEach(async () => {
        runCounter++;
        prefix = `inv-${Date.now().toString(36)}-${runCounter}`;
        seeded = [];
        // Deterministic spread so concrete-count assertions are computable, yet
        // varied enough to exercise every filter/sort path.
        for (let i = 0; i < N; i++) {
            const status = i % 2 === 0 ? 'open' : 'closed';
            const active = i % 3 === 0;
            const hasB = i % 2 === 0;
            const e = ctx.tracker.create();
            e.add(InvTagA, {});
            if (hasB) e.add(InvTagB, {});
            e.add(InvData, { label: prefix, score: i, status, active });
            await e.save();
            seeded.push({ id: e.id, score: i, status, active, hasB });
        }
    });

    // Every query is scoped to this run via the label filter on InvData, so
    // leftover rows from other tests/files can never affect the invariants.
    type QF = () => Query<any>;
    const base = (extra: ReturnType<typeof Query.filter>[] = []): Query<any> =>
        new Query().with(InvData, { filters: [Query.filter('label', FilterOp.EQ, prefix), ...extra] });

    // ---- invariant helpers -------------------------------------------------
    async function execIds(qf: QF): Promise<string[]> {
        const rows = await qf().take(100000).exec();
        return rows.map(e => e.id);
    }
    async function fullSet(qf: QF): Promise<Set<string>> {
        return new Set(await execIds(qf));
    }
    async function paginateOffset(qf: QF, pageSize: number): Promise<string[]> {
        const all: string[] = [];
        for (let off = 0; off <= N + pageSize; off += pageSize) {
            const page = await qf().offset(off).take(pageSize).exec();
            all.push(...page.map(e => e.id));
            if (page.length < pageSize) break;
        }
        return all;
    }

    /** Assert count(), unbounded exec(), and paged exec() all agree. */
    async function assertParity(label: string, qf: QF) {
        const full = await execIds(qf);
        const fullSetIds = new Set(full);
        const counted = await qf().count();
        const paged = await paginateOffset(qf, 4);

        expect(full.length, `${label}: exec has duplicates`).toBe(fullSetIds.size);
        expect(counted, `${label}: count() != exec().length`).toBe(full.length);
        expect(paged.length, `${label}: pagination produced duplicates`).toBe(new Set(paged).size);
        expect(new Set(paged), `${label}: paginate-all != unbounded exec`).toEqual(fullSetIds);
    }

    // -----------------------------------------------------------------------
    // 1 + 2: count/exec/pagination parity across many shapes.
    // -----------------------------------------------------------------------
    describe('count + pagination parity', () => {
        test('membership, filter, tag, and exclusion shapes all stay consistent', async () => {
            const shapes: Record<string, QF> = {
                'all (label only)': () => base(),
                'numeric >=': () => base([Query.filter('score', FilterOp.GTE, 12)]),
                'numeric range (2 filters)': () => base([Query.filter('score', FilterOp.GTE, 5), Query.filter('score', FilterOp.LT, 20)]),
                'string status': () => base([Query.filter('status', FilterOp.EQ, 'open')]),
                'boolean active': () => base([Query.filter('active', FilterOp.EQ, true)]),
                'IN set': () => base([Query.filter('score', FilterOp.IN, [1, 5, 9, 13, 17, 21])]),
                '3 filters (CTE path)': () => base([
                    Query.filter('score', FilterOp.GTE, 4),
                    Query.filter('status', FilterOp.EQ, 'open'),
                    Query.filter('active', FilterOp.EQ, false),
                ]),
                'tagA required': () => base().with(InvTagA),
                'tagA + tagB intersection': () => base().with(InvTagA).with(InvTagB),
                'without tagB': () => base().with(InvTagA).without(InvTagB),
                'tagB + filter': () => base([Query.filter('score', FilterOp.GTE, 8)]).with(InvTagB),
            };

            for (const [label, qf] of Object.entries(shapes)) {
                await assertParity(label, qf);
            }
        });

        test('empty result shapes are consistent (count 0, no rows)', async () => {
            const shapes: Record<string, QF> = {
                'impossible numeric': () => base([Query.filter('score', FilterOp.GT, 9999)]),
                'empty IN': () => base([Query.filter('score', FilterOp.IN, [])]),
                'nonexistent status': () => base([Query.filter('status', FilterOp.EQ, 'nope')]),
            };
            for (const [label, qf] of Object.entries(shapes)) {
                expect(await qf().count(), `${label}: count`).toBe(0);
                expect((await qf().take(10).exec()).length, `${label}: exec`).toBe(0);
            }
        });
    });

    // -----------------------------------------------------------------------
    // 5: with(X)/without(X) partition the base set.
    // -----------------------------------------------------------------------
    describe('with / without partition the base', () => {
        test('with(TagB) and without(TagB) are disjoint and cover with(TagA)', async () => {
            const all = await fullSet(() => base().with(InvTagA));
            const withB = await fullSet(() => base().with(InvTagA).with(InvTagB));
            const withoutB = await fullSet(() => base().with(InvTagA).without(InvTagB));

            // Disjoint
            for (const id of withB) expect(withoutB.has(id)).toBe(false);
            // Covering: union == base
            expect(new Set([...withB, ...withoutB])).toEqual(all);
            // Sizes match the seed (12 even-indexed have TagB)
            expect(withB.size).toBe(12);
            expect(withoutB.size).toBe(12);
        });
    });

    // -----------------------------------------------------------------------
    // 3: sortBy changes order, never membership; result is monotonic; and
    //    paginating a sorted query yields a globally-sorted sequence.
    // -----------------------------------------------------------------------
    describe('sort invariants', () => {
        async function scores(rows: Array<{ id: string }>): Promise<number[]> {
            const byId = new Map(seeded.map(s => [s.id, s.score]));
            return rows.map(r => byId.get(r.id)!);
        }

        test('single-component sort: same membership, monotonic, paginates in order', async () => {
            const unsorted = await fullSet(() => base());
            const asc = await base().sortBy(InvData, 'score', 'ASC').take(100000).exec();
            const desc = await base().sortBy(InvData, 'score', 'DESC').take(100000).exec();

            expect(new Set(asc.map(e => e.id))).toEqual(unsorted);  // membership preserved
            expect(new Set(desc.map(e => e.id))).toEqual(unsorted);

            const ascScores = await scores(asc);
            const descScores = await scores(desc);
            expect(ascScores).toEqual([...ascScores].sort((a, b) => a - b));
            expect(descScores).toEqual([...descScores].sort((a, b) => b - a));

            // Paginated sorted reads, concatenated, must be globally sorted.
            const paged: string[] = [];
            for (let off = 0; off < N; off += 5) {
                const page = await base().sortBy(InvData, 'score', 'ASC').offset(off).take(5).exec();
                paged.push(...page.map(e => e.id));
            }
            const pagedScores = await scores(paged.map(id => ({ id })));
            expect(pagedScores).toEqual([...pagedScores].sort((a, b) => a - b));
            expect(new Set(paged)).toEqual(unsorted);
        });

        test('multi-component sort (sort-driven scan): same membership, monotonic, paged parity', async () => {
            const qf: QF = () => base().with(InvTagB);
            const membership = await fullSet(qf);

            const asc = await base().with(InvTagB).sortBy(InvData, 'score', 'ASC').take(100000).exec();
            expect(new Set(asc.map(e => e.id))).toEqual(membership);
            const ascScores = await scores(asc);
            expect(ascScores).toEqual([...ascScores].sort((a, b) => a - b));

            // Paginate the sorted multi-component query — full recovery, in order.
            const paged: string[] = [];
            for (let off = 0; off < N; off += 3) {
                const page = await base().with(InvTagB).sortBy(InvData, 'score', 'ASC').offset(off).take(3).exec();
                paged.push(...page.map(e => e.id));
                if (page.length < 3) break;
            }
            expect(new Set(paged)).toEqual(membership);
            const pagedScores = await scores(paged.map(id => ({ id })));
            expect(pagedScores).toEqual([...pagedScores].sort((a, b) => a - b));
        });

        test('sort + filter (single-pass path): membership matches the same filter unsorted', async () => {
            const filt = [Query.filter('status', FilterOp.EQ, 'open')];
            const unsorted = await fullSet(() => base(filt));
            const sorted = await base(filt).sortBy(InvData, 'score', 'DESC').take(100000).exec();
            expect(new Set(sorted.map(e => e.id))).toEqual(unsorted);
            const s = sorted.map(e => seeded.find(x => x.id === e.id)!.score);
            expect(s).toEqual([...s].sort((a, b) => b - a));
        });
    });

    // -----------------------------------------------------------------------
    // 4: cursor pagination recovers the same set as offset pagination.
    // -----------------------------------------------------------------------
    describe('cursor pagination', () => {
        test('forward cursor recovers the full set with no gaps or dupes', async () => {
            const full = await fullSet(() => base());

            const got: string[] = [];
            let cursorId: string | undefined;
            for (let guard = 0; guard < 100; guard++) {
                let q = base().take(5);
                if (cursorId) q = q.cursor(cursorId);
                const page = await q.exec();
                if (page.length === 0) break;
                got.push(...page.map(e => e.id));
                if (page.length < 5) break;
                cursorId = page[page.length - 1]!.id;
            }

            expect(got.length).toBe(new Set(got).size); // no dupes
            expect(new Set(got)).toEqual(full);          // same set as offset/unbounded
        });
    });

    // -----------------------------------------------------------------------
    // 6: OR invariants + AND/OR composition + the OR+sort limitation.
    // -----------------------------------------------------------------------
    describe('OR query invariants', () => {
        const orLowOrHigh = () =>
            or([
                { component: InvData, filters: [Query.filter('score', FilterOp.LT, 5)] },
                { component: InvData, filters: [Query.filter('score', FilterOp.GTE, 20)] },
            ]);

        test('OR over a base component obeys count + pagination parity', async () => {
            await assertParity('base + OR(score<5 || score>=20)', () => base().with(orLowOrHigh()));
        });

        test('AND-filter composes with OR (intersection semantics)', async () => {
            // label=prefix AND active=true AND (score<5 OR score>=20)
            // active → i%3==0 → {0,3,6,9,12,15,18,21}; AND (i<5 → {0,3}) ∪ (i>=20 → {21}) = {0,3,21}
            const expected = new Set(
                seeded.filter(s => s.active && (s.score < 5 || s.score >= 20)).map(s => s.id)
            );
            const got = await fullSet(() => base([Query.filter('active', FilterOp.EQ, true)]).with(orLowOrHigh()));
            expect(got).toEqual(expected);
            expect(got.size).toBe(3);
        });

        test('excludeEntityId composes with OR', async () => {
            const allMatches = [...(await fullSet(() => base().with(orLowOrHigh())))];
            const drop = allMatches[0]!;
            const got = await fullSet(() => base().with(orLowOrHigh()).excludeEntityId(drop));
            expect(got.has(drop)).toBe(false);
            expect(got.size).toBe(allMatches.length - 1);
        });

        test('OR branch with numeric IN filter casts correctly (no text=integer error)', async () => {
            // Regression: JSONB `data->>'score'` is text; a numeric IN list must
            // cast both sides or PostgreSQL throws "operator does not exist:
            // text = integer". Exercises the OrNode IN path specifically.
            const expected = new Set(seeded.filter(s => [2, 7, 11, 23].includes(s.score)).map(s => s.id));
            const got = await fullSet(() =>
                base().with(or([
                    { component: InvData, filters: [Query.filter('score', FilterOp.IN, [2, 7, 11, 23])] },
                    { component: InvData, filters: [Query.filter('score', FilterOp.IN, [99])] }, // matches nothing
                ]))
            );
            expect(got).toEqual(expected);
        });

        test('OR + sortBy honors order (membership preserved, monotonic both directions)', async () => {
            // OR queries now resolve component sortBy() via the outer sort
            // wrapper in Query.doExec — the id-set is JOIN-ed to the sort
            // component and ORDER BY'd. Sort must change ORDER, never MEMBERSHIP.
            const scoreOf = new Map(seeded.map(s => [s.id, s.score]));
            const unsorted = await fullSet(() => base().with(orLowOrHigh()));

            const desc = await base().with(orLowOrHigh()).sortBy(InvData, 'score', 'DESC').take(100000).exec();
            const asc = await base().with(orLowOrHigh()).sortBy(InvData, 'score', 'ASC').take(100000).exec();

            expect(new Set(desc.map(e => e.id))).toEqual(unsorted);
            expect(new Set(asc.map(e => e.id))).toEqual(unsorted);

            const descScores = desc.map(e => scoreOf.get(e.id)!);
            const ascScores = asc.map(e => scoreOf.get(e.id)!);
            expect(descScores).toEqual([...descScores].sort((a, b) => b - a));
            expect(ascScores).toEqual([...ascScores].sort((a, b) => a - b));
        });

        test('OR + sortBy + OFFSET pagination yields a globally-sorted sequence', async () => {
            const scoreOf = new Map(seeded.map(s => [s.id, s.score]));
            const membership = await fullSet(() => base().with(orLowOrHigh()));

            const paged: string[] = [];
            for (let off = 0; off < N; off += 3) {
                const page = await base().with(orLowOrHigh())
                    .sortBy(InvData, 'score', 'ASC').offset(off).take(3).exec();
                paged.push(...page.map(e => e.id));
                if (page.length < 3) break;
            }
            expect(new Set(paged)).toEqual(membership);          // full recovery, no gaps/dupes
            expect(paged.length).toBe(new Set(paged).size);
            const pagedScores = paged.map(id => scoreOf.get(id)!);
            expect(pagedScores).toEqual([...pagedScores].sort((a, b) => a - b));
        });

        test('OR + sortBy + keyset cursor (sortedCursor) recovers the full set in order', async () => {
            const scoreOf = new Map(seeded.map(s => [s.id, s.score]));
            const membership = await fullSet(() => base().with(orLowOrHigh()));

            const got: string[] = [];
            let token: string | undefined;
            for (let guard = 0; guard < 100; guard++) {
                let q = base().with(orLowOrHigh()).sortBy(InvData, 'score', 'ASC').take(3);
                if (token) q = q.sortedCursor(token);
                const page = await q.exec();
                if (page.length === 0) break;
                got.push(...page.map(e => e.id));
                if (page.length < 3) break;
                const last = page[page.length - 1]!;
                token = Query.encodeSortedCursor(scoreOf.get(last.id)!, last.id);
            }
            expect(got.length).toBe(new Set(got).size);          // no dupes
            expect(new Set(got)).toEqual(membership);            // same set as unbounded
            const gotScores = got.map(id => scoreOf.get(id)!);
            expect(gotScores).toEqual([...gotScores].sort((a, b) => a - b));
        });
    });
});
