/**
 * Composite keyset cursor pagination for SORTED queries (Fix #2).
 *
 * Invariant: walking pages via a composite cursor recovers EXACTLY the same
 * ordered set as one unbounded sorted exec — no duplicates, no skips.
 *
 * Covers:
 *   - sortByCreatedAt (entity-column sort, ASC and DESC)
 *   - single-component sortBy (component-field sort, ASC and DESC)
 *   - TIE cases: multiple rows sharing the same sort value
 *
 * Pin deterministic timestamps via ctx.db.unsafe (same pattern as
 * Query.entitySort.test.ts) so ordering is unambiguous across DB engines.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { Query, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

// ── Fixtures ──────────────────────────────────────────────────────────────────

@Component
class KCData extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
    @CompData() score: number = 0;
}

@Component
class KCTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let runCounter = 0;

/**
 * Walk all pages of a sorted query using composite keyset cursors.
 * Returns `[ids, scoresBySortValue]` in page order.
 *
 * `getSortValue(entity)` extracts the sort column's raw value from each row
 * so we can build the cursor token.
 */
async function walkSortedPages(
    makeQuery: () => Query<any>,
    pageSize: number,
    getSortValue: (entity: any, ctx: { db: any; id: string }) => Promise<string | number | Date | null>
): Promise<string[]> {
    const allIds: string[] = [];
    let cursorToken: string | undefined;
    let guard = 0;
    const MAX = 500;

    while (guard++ < MAX) {
        let q = makeQuery().take(pageSize);
        if (cursorToken) q = q.sortedCursor(cursorToken);
        const page = await q.exec();
        if (page.length === 0) break;
        allIds.push(...page.map((e: any) => e.id));
        if (page.length < pageSize) break;
        const last = page[page.length - 1]!;
        const sv = await getSortValue(last, { db: null, id: last.id });
        cursorToken = Query.encodeSortedCursor(sv, last.id);
    }

    return allIds;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Composite keyset cursor pagination for sorted queries', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(KCData, KCTag);
    });

    const N = 20;
    const PAGE = 4;
    let prefix: string;
    let idsByIndex: string[];     // idsByIndex[i] = entity at insertion index i
    let scoreByIndex: number[];   // score assigned to each entity

    beforeEach(async () => {
        runCounter++;
        prefix = `kc-${Date.now().toString(36)}-${runCounter}`;
        idsByIndex = [];
        scoreByIndex = [];

        for (let i = 0; i < N; i++) {
            const e = ctx.tracker.create();
            e.add(KCTag, {});
            // First half: unique scores; second half: scores tied at 100 to
            // exercise the tiebreak path.
            const score = i < N / 2 ? i : 100;
            e.add(KCData, { label: prefix, score });
            await e.save();
            idsByIndex.push(e.id);
            scoreByIndex.push(score);
        }

        // Pin strictly-increasing, unique created_at timestamps.
        for (let i = 0; i < N; i++) {
            const ts = new Date(Date.UTC(2025, 0, 1, 0, 0, i + 1)).toISOString();
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [ts, idsByIndex[i]]
            );
        }
    });

    // Helper: read entities.created_at for the keyset value from the DB.
    async function getCreatedAt(id: string): Promise<Date> {
        const rows = await ctx.db.unsafe<{ created_at: Date }[]>(
            `SELECT created_at FROM entities WHERE id = $1`, [id]
        );
        return rows[0]!.created_at;
    }

    // Base query scoped to this test run.
    const base = () =>
        new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, prefix)] });

    // ── 1. sortByCreatedAt ASC ────────────────────────────────────────────────

    test('sortByCreatedAt ASC: keyset pages recover the same ordered set', async () => {
        const unbounded = await base().sortByCreatedAt('ASC').take(N * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => base().sortByCreatedAt('ASC'),
            PAGE,
            async (entity) => getCreatedAt(entity.id)
        );

        expect(paged.length).toBe(N);
        expect(new Set(paged).size).toBe(N);   // no duplicates
        expect(paged).toEqual(expectedIds);     // same order as unbounded
    });

    // ── 2. sortByCreatedAt DESC ───────────────────────────────────────────────

    test('sortByCreatedAt DESC: keyset pages recover the same ordered set', async () => {
        const unbounded = await base().sortByCreatedAt('DESC').take(N * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => base().sortByCreatedAt('DESC'),
            PAGE,
            async (entity) => getCreatedAt(entity.id)
        );

        expect(paged.length).toBe(N);
        expect(new Set(paged).size).toBe(N);
        expect(paged).toEqual(expectedIds);
    });

    // ── 3. single-component sortBy ASC (unique sort values) ──────────────────

    test('sortBy(score) ASC unique values: keyset pages recover the same ordered set', async () => {
        // Scope to the first half only where scores are unique.
        const halfPrefix = `${prefix}-half`;
        const halfIds: string[] = [];
        const M = 12;
        for (let i = 0; i < M; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: halfPrefix, score: i });
            await e.save();
            halfIds.push(e.id);
        }

        const q = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, halfPrefix)] });

        const unbounded = await q().sortBy(KCData, 'score', 'ASC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => q().sortBy(KCData, 'score', 'ASC'),
            3,
            async (entity) => {
                // score is stored in componentData (populated via populate() — use raw DB instead).
                const rows = await ctx.db.unsafe<{ data: any }[]>(
                    `SELECT data FROM components WHERE entity_id = $1 AND deleted_at IS NULL LIMIT 1`,
                    [entity.id]
                );
                return rows[0]?.data?.score ?? null;
            }
        );

        expect(paged.length).toBe(M);
        expect(new Set(paged).size).toBe(M);
        expect(paged).toEqual(expectedIds);
    });

    // ── 4. single-component sortBy DESC (unique sort values) ─────────────────

    test('sortBy(score) DESC unique values: keyset pages recover the same ordered set', async () => {
        const uniqPrefix = `${prefix}-desc`;
        const M = 10;
        for (let i = 0; i < M; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: uniqPrefix, score: i * 3 });
            await e.save();
        }

        const q = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, uniqPrefix)] });

        const unbounded = await q().sortBy(KCData, 'score', 'DESC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => q().sortBy(KCData, 'score', 'DESC'),
            3,
            async (entity) => {
                const rows = await ctx.db.unsafe<{ data: any }[]>(
                    `SELECT data FROM components WHERE entity_id = $1 AND deleted_at IS NULL LIMIT 1`,
                    [entity.id]
                );
                return rows[0]?.data?.score ?? null;
            }
        );

        expect(paged.length).toBe(M);
        expect(new Set(paged).size).toBe(M);
        expect(paged).toEqual(expectedIds);
    });

    // ── 5. TIE case on created_at: many rows share the same timestamp ─────────

    test('sortByCreatedAt TIE: all rows share one created_at, keyset still paginates correctly', async () => {
        const tiePrefix = `${prefix}-tie-ts`;
        const M = 16;
        const tieIds: string[] = [];

        for (let i = 0; i < M; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: tiePrefix, score: i });
            await e.save();
            tieIds.push(e.id);
        }

        // Force ALL to the same created_at — every row ties on the sort key.
        const sharedTs = new Date(Date.UTC(2035, 0, 1)).toISOString();
        for (const id of tieIds) {
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [sharedTs, id]
            );
        }

        const q = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, tiePrefix)] });

        const unbounded = await q().sortByCreatedAt('ASC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => q().sortByCreatedAt('ASC'),
            PAGE,
            async (entity) => getCreatedAt(entity.id)
        );

        expect(paged.length).toBe(M);
        expect(new Set(paged).size).toBe(M);   // no duplicates across pages
        expect(paged).toEqual(expectedIds);     // same order as single-shot
    });

    // ── 6. TIE case on component score ────────────────────────────────────────

    test('sortBy(score) TIE: many rows share score=100, keyset still paginates correctly', async () => {
        // Use the second half of seeded entities (all score=100).
        const tiePrefix = `${prefix}-tie-score`;
        const M = 14;
        const tieIds: string[] = [];

        for (let i = 0; i < M; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: tiePrefix, score: 100 }); // all tied
            await e.save();
            tieIds.push(e.id);
        }

        const q = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, tiePrefix)] });

        const unbounded = await q().sortBy(KCData, 'score', 'ASC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => q().sortBy(KCData, 'score', 'ASC'),
            3,
            async (entity) => {
                const rows = await ctx.db.unsafe<{ data: any }[]>(
                    `SELECT data FROM components WHERE entity_id = $1 AND deleted_at IS NULL LIMIT 1`,
                    [entity.id]
                );
                return rows[0]?.data?.score ?? null;
            }
        );

        expect(paged.length).toBe(M);
        expect(new Set(paged).size).toBe(M);
        expect(paged).toEqual(expectedIds);
    });

    // ── 7. encode/decode round-trip ───────────────────────────────────────────

    test('encodeSortedCursor / decodeSortedCursor round-trip', () => {
        const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

        // Numeric sort value
        const tok1 = Query.encodeSortedCursor(42, id);
        const dec1 = Query.decodeSortedCursor(tok1);
        expect(dec1.id).toBe(id);
        expect(dec1.v).toBe('42');

        // String sort value
        const tok2 = Query.encodeSortedCursor('hello', id);
        const dec2 = Query.decodeSortedCursor(tok2);
        expect(dec2.v).toBe('hello');

        // Date sort value → ISO string
        const dt = new Date('2025-01-15T12:00:00.000Z');
        const tok3 = Query.encodeSortedCursor(dt, id);
        const dec3 = Query.decodeSortedCursor(tok3);
        expect(dec3.v).toBe(dt.toISOString());

        // Null sort value
        const tok4 = Query.encodeSortedCursor(null, id);
        const dec4 = Query.decodeSortedCursor(tok4);
        expect(dec4.v).toBeNull();
    });

    // ── 8. Error cases ────────────────────────────────────────────────────────

    test('decodeSortedCursor throws on invalid token', () => {
        expect(() => Query.decodeSortedCursor('not-valid-base64!!!')).toThrow('Invalid sorted cursor token');
        // Valid base64 but not the right JSON shape
        const bad = Buffer.from(JSON.stringify({ wrong: 'shape' })).toString('base64');
        expect(() => Query.decodeSortedCursor(bad)).toThrow('Invalid sorted cursor token');
    });

    test('sortedCursor() + OR query throws a clear error', async () => {
        const { or } = await import('../../../query/Query');
        const token = Query.encodeSortedCursor(42, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        const q = base()
            .with(or([{ component: KCData, filters: [Query.filter('score', FilterOp.LT, 5)] }]))
            .sortBy(KCData, 'score', 'ASC')
            .sortedCursor(token)
            .take(5);
        await expect(q.exec()).rejects.toThrow('sortedCursor() cannot be combined with OR queries');
    });

    test("sortedCursor(token, 'before') throws a clear error for component sortBy", async () => {
        const token = Query.encodeSortedCursor(5, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        const q = base().sortBy(KCData, 'score', 'ASC').sortedCursor(token, 'before').take(5);
        await expect(q.exec()).rejects.toThrow("sortedCursor(token, 'before') is not supported");
    });

    test("sortedCursor(token, 'before') throws a clear error for sortByCreatedAt", async () => {
        const token = Query.encodeSortedCursor(new Date(), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        const q = base().sortByCreatedAt('ASC').sortedCursor(token, 'before').take(5);
        await expect(q.exec()).rejects.toThrow("sortedCursor(token, 'before') is not supported");
    });

    test('mixing sortByCreatedAt and sortBy throws a clear error', async () => {
        const q = base().sortByCreatedAt('ASC').sortBy(KCData, 'score', 'ASC').take(5);
        await expect(q.exec()).rejects.toThrow('cannot be combined with sortBy()');
    });

    // ── 9. Microsecond precision — pinned sub-ms timestamps ───────────────────
    // Entities.created_at is timestamptz with microsecond precision. The cursor
    // value comes back as a JS Date (millisecond precision). Without date_trunc,
    // the stored 00:00:01.000123 > cursor 00:00:01.000, so already-seen rows
    // re-qualify on every subsequent page (infinite pagination loop).

    test('sortByCreatedAt keyset survives sub-millisecond timestamp differences', async () => {
        const submsPrefix = `kc-subms-${Date.now().toString(36)}-${runCounter}`;
        const M = 8;
        const submsIds: string[] = [];

        for (let i = 0; i < M; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: submsPrefix, score: i });
            await e.save();
            submsIds.push(e.id);
        }

        // Assign timestamps that differ ONLY in the microsecond field (e.g.
        // 2030-01-01T00:00:01.000100, ...200, ...300, ...). JS Date.toISOString()
        // will produce 2030-01-01T00:00:01.000Z for all of them (ms truncation).
        for (let i = 0; i < M; i++) {
            const microOffset = (i + 1) * 100; // 100µs, 200µs, …
            const ts = `2030-01-01T00:00:01.${String(microOffset).padStart(6, '0')}+00:00`;
            await ctx.db.unsafe(
                `UPDATE entities SET created_at = $1::timestamptz WHERE id = $2`,
                [ts, submsIds[i]]
            );
        }

        const q = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, submsPrefix)] });

        const unbounded = await q().sortByCreatedAt('ASC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);

        const paged = await walkSortedPages(
            () => q().sortByCreatedAt('ASC'),
            3,
            async (entity) => getCreatedAt(entity.id)
        );

        expect(new Set(paged).size).toBe(M);   // no duplicates
        expect(paged.length).toBe(M);           // no rows lost
        expect(paged).toEqual(expectedIds);     // same order as unbounded
    });

    // ── 10. NULL sort values — nullable component field ───────────────────────
    // When sorting on a nullable field with NULLS LAST, NULL-valued rows appear
    // at the end of the full set. A keyset cursor from the last non-null row
    // must still yield the NULL region on subsequent pages.

    test('sortBy on nullable field: keyset pages reach NULL-valued rows', async () => {
        const nullPrefix = `kc-null-${Date.now().toString(36)}-${runCounter}`;
        const nonNullCount = 4;
        const nullCount = 4;
        const M = nonNullCount + nullCount;
        const nullIds: string[] = [];

        // 4 entities with score 1,2,3,4 then 4 entities with score = 0 (default)
        // We use KCTag.note as nullable field for sorting via raw DB because
        // CompData({ nullable: true }) allows null storage.
        // Instead use score field: for the null group we cannot store NULL into a
        // numeric field directly. Use a second component with a nullable field.
        // KCTag has note?: string (nullable). Store null-note entities to sort by note.
        const allIds: string[] = [];

        for (let i = 0; i < nonNullCount; i++) {
            const e = ctx.tracker.create();
            e.add(KCTag, { note: `note-${i + 1}` });
            await e.save();
            allIds.push(e.id);
        }
        for (let i = 0; i < nullCount; i++) {
            const e = ctx.tracker.create();
            e.add(KCTag, {}); // note is undefined/null
            await e.save();
            allIds.push(e.id);
            nullIds.push(e.id);
        }

        const q = () => new Query().with(KCTag, { filters: [
            Query.filter('id', FilterOp.IN, allIds)
        ] });

        // note: cannot use KCTag.note for sortBy easily without indexing.
        // Instead assert with score (sortBy on score, where non-null have distinct
        // scores and null group has score=0 which is not null in DB terms).
        // Actually KCTag has no score. Let us use the simpler invariant:
        // All M ids appear in unbounded query, and keyset walk also recovers M ids.
        // Use KCData with explicit null stored via raw SQL.
        const scorePrefix = `kc-nullsort-${Date.now().toString(36)}-${runCounter}`;
        const scoreIds: string[] = [];

        for (let i = 0; i < nonNullCount; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: scorePrefix, score: i + 1 });
            await e.save();
            scoreIds.push(e.id);
        }
        for (let i = 0; i < nullCount; i++) {
            const e = ctx.tracker.create();
            e.add(KCData, { label: scorePrefix, score: 0 });
            await e.save();
            scoreIds.push(e.id);
        }
        // Force score to NULL for the last nullCount entities via raw SQL.
        for (let i = nonNullCount; i < M; i++) {
            await ctx.db.unsafe(
                `UPDATE components SET data = data - 'score' WHERE entity_id = $1 AND deleted_at IS NULL`,
                [scoreIds[i]]
            );
        }

        const sq = () =>
            new Query().with(KCData, { filters: [Query.filter('label', FilterOp.EQ, scorePrefix)] });

        const unbounded = await sq().sortBy(KCData, 'score', 'ASC').take(M * 2).exec();
        const expectedIds = unbounded.map((e: any) => e.id);
        expect(expectedIds.length).toBe(M);

        const paged = await walkSortedPages(
            () => sq().sortBy(KCData, 'score', 'ASC'),
            2,
            async (entity) => {
                const rows = await ctx.db.unsafe<{ data: any }[]>(
                    `SELECT data FROM components WHERE entity_id = $1 AND deleted_at IS NULL LIMIT 1`,
                    [entity.id]
                );
                return rows[0]?.data?.score ?? null;
            }
        );

        expect(new Set(paged).size).toBe(M);   // no duplicates
        expect(paged.length).toBe(M);           // NULL rows not lost
    });
});
