/**
 * Sort-stability / pagination-stability tests.
 *
 * When many entities share the same sort-key value (ties), the query engine
 * must produce a deterministic ORDER so that OFFSET pagination is stable:
 * concatenating pages must yield the same id list as one unbounded query —
 * no duplicates, no skips.
 *
 * The fix: every sorted ORDER BY now appends ", <entity_id> ASC" as a
 * secondary tiebreak key. These tests prove that invariant holds for every
 * sorted path in the query engine:
 *
 *   - applySortDrivenScan          (single-component scan driven by sort column)
 *   - applySinglePassFilterSort    (single-component, filters + sort combined)
 *   - applySortingOptimized        (single-component, multi-component INTERSECT base)
 *   - applySortingWithComponentJoins (multi-component base + scalar-subquery ORDER BY)
 *   - doExec entity-column sort    (sortByCreatedAt / sortByUpdatedAt wrapper)
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

// ── Fixtures ──────────────────────────────────────────────────────────────────

@Component
class SSTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}

@Component
class SSData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
}

// A second "required" component so multi-component INTERSECT path is exercised.
@Component
class SSExtra extends BaseComponent {
    @CompData({ nullable: true }) tag?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect ids from a query without forcing a specific take() */
async function idsRaw(q: Query<any>): Promise<string[]> {
    const rows = await q.exec();
    return rows.map(e => e.id);
}

/**
 * Paginate through all results using .take(pageSize).offset(...) and return the
 * concatenated id list. Stops when a page comes back smaller than pageSize.
 */
async function paginateAll(makeQuery: () => Query<any>, pageSize: number): Promise<string[]> {
    const result: string[] = [];
    let offset = 0;
    while (true) {
        const page = await idsRaw(makeQuery().take(pageSize).offset(offset));
        result.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
    }
    return result;
}

let runCounter = 0;

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('Query sort stability (tie-break pagination)', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(SSTag, SSData, SSExtra);
    });

    const N = 24;      // total entities seeded per test
    const PAGE = 5;    // page size — intentionally doesn't divide N evenly
    let prefix: string;
    let allIds: string[];   // insertion order

    beforeEach(async () => {
        runCounter++;
        prefix = `ss-${Date.now().toString(36)}-${runCounter}`;
        allIds = [];

        // All entities get score=99 — every single entity ties on the sort key.
        // SSExtra is added to half so we can test the multi-component path.
        for (let i = 0; i < N; i++) {
            const e = ctx.tracker.create();
            e.add(SSTag, {});
            e.add(SSData, { label: prefix, score: 99 });
            e.add(SSExtra, { tag: prefix });
            await e.save();
            allIds.push(e.id);
        }

        // Pin strictly-increasing created_at values so the entity-sort path is
        // unambiguous, but keep them ALL equal on the component score field.
        // (created_at epoch seconds 1..N are fine — far future, guaranteed unique)
        for (let i = 0; i < N; i++) {
            const ts = new Date(Date.UTC(2030, 0, 1, 0, 0, i + 1)).toISOString();
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [ts, allIds[i]]
            );
        }
    });

    // ── 1. sortBy component field (score), all ties ──────────────────────────

    test('sortBy component field: offset pages == unbounded query (all ties)', async () => {
        const makeQ = () =>
            new Query().with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] }).sortBy(SSData, 'score', 'ASC');

        const unbounded = await idsRaw(makeQ().take(N * 2));
        const paged = await paginateAll(makeQ, PAGE);

        expect(paged).toEqual(unbounded);
        expect(new Set(paged).size).toBe(N);          // no duplicates
        expect(paged.length).toBe(N);                 // no skips
    });

    test('sortBy component field DESC: offset pages == unbounded query (all ties)', async () => {
        const makeQ = () =>
            new Query().with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] }).sortBy(SSData, 'score', 'DESC');

        const unbounded = await idsRaw(makeQ().take(N * 2));
        const paged = await paginateAll(makeQ, PAGE);

        expect(paged).toEqual(unbounded);
        expect(new Set(paged).size).toBe(N);
        expect(paged.length).toBe(N);
    });

    // ── 2. sortByCreatedAt (entity column sort), ties on created_at ──────────

    test('sortByCreatedAt: offset pages == unbounded query when many share same created_at', async () => {
        // Force ALL entities to the same created_at to create maximum tie scenario.
        const sharedTs = new Date(Date.UTC(2030, 6, 1)).toISOString();
        for (const id of allIds) {
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [sharedTs, id]
            );
        }

        const makeQ = () =>
            new Query()
                .with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
                .sortByCreatedAt('ASC');

        const unbounded = await idsRaw(makeQ().take(N * 2));
        const paged = await paginateAll(makeQ, PAGE);

        expect(paged).toEqual(unbounded);
        expect(new Set(paged).size).toBe(N);
        expect(paged.length).toBe(N);
    });

    // ── 3. Multi-component INTERSECT path (sortBy component) ─────────────────

    test('multi-component sortBy: offset pages == unbounded query (all ties)', async () => {
        // SSExtra is on all N entities, so the INTERSECT of SSData+SSExtra == all N.
        const makeQ = () =>
            new Query()
                .with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
                .with(SSExtra, { filters: [Query.filter('tag', FilterOp.EQ, prefix)] })
                .sortBy(SSData, 'score', 'ASC');

        const unbounded = await idsRaw(makeQ().take(N * 2));
        const paged = await paginateAll(makeQ, PAGE);

        expect(paged).toEqual(unbounded);
        expect(new Set(paged).size).toBe(N);
        expect(paged.length).toBe(N);
    });

    test('multi-component sortByCreatedAt: offset pages == unbounded (tied created_at)', async () => {
        const sharedTs = new Date(Date.UTC(2030, 8, 1)).toISOString();
        for (const id of allIds) {
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [sharedTs, id]
            );
        }

        const makeQ = () =>
            new Query()
                .with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] })
                .with(SSExtra, { filters: [Query.filter('tag', FilterOp.EQ, prefix)] })
                .sortByCreatedAt('ASC');

        const unbounded = await idsRaw(makeQ().take(N * 2));
        const paged = await paginateAll(makeQ, PAGE);

        expect(paged).toEqual(unbounded);
        expect(new Set(paged).size).toBe(N);
        expect(paged.length).toBe(N);
    });

    // ── 4. Membership coverage: paged union == unbounded set ─────────────────

    test('set membership is preserved across all sorted pages', async () => {
        const makeQ = () =>
            new Query().with(SSData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] }).sortBy(SSData, 'score', 'ASC');

        const unbounded = new Set(await idsRaw(makeQ().take(N * 2)));
        const paged = new Set(await paginateAll(makeQ, PAGE));

        expect(paged).toEqual(unbounded);
    });
});
