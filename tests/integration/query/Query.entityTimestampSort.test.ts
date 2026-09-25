/**
 * Entity timestamp sorts (RFC D6): UTC-millisecond order on every page, id
 * tiebreak follows direction, soft-deleted entities excluded, adaptive
 * membership probe, and the no-membership bk_ index plan.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { ComponentRegistry } from '../../../core/components';
import { shouldUseDirectPartition } from '../../../core/Config';
import { entitySortProbeWindow, resetEntitySortTupleCache } from '../../../query/entitySort';
import { Query, or, FilterOp } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';
import { dbExec, dbTransaction } from '../../../database/gateway';
import { entityKeyIndexSpecs } from '../../../database/keyIndexSpec';

@Component
class EsClock extends BaseComponent {
    @CompData({ indexed: true }) label: string = '';
}

@Component
class EsExtra extends BaseComponent {
    @CompData({ indexed: true }) tag: string = '';
}

const isPglite = process.env.USE_PGLITE === 'true';

type Col = 'created_at' | 'updated_at';
type Dir = 'ASC' | 'DESC';
type SortValue = string | number | Date | null;

interface TimestampSorted<T> {
    sortByCreatedAt(direction?: Dir, nullsFirst?: boolean): T;
    sortByUpdatedAt(direction?: Dir, nullsFirst?: boolean): T;
}

function sortBy<T extends TimestampSorted<T>>(q: T, col: Col, dir: Dir, nullsFirst = false): T {
    return col === 'created_at' ? q.sortByCreatedAt(dir, nullsFirst) : q.sortByUpdatedAt(dir, nullsFirst);
}

interface KeysetPage<T> {
    take(n: number): T;
    offset(n: number): T;
    sortedCursor(token: string, direction?: 'after' | 'before'): T;
    exec(): Promise<Array<{ id: string }>>;
}

let probeGate: Promise<void> = Promise.resolve();

async function withProbe<T>(probe: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = probeGate;
    const gate = Promise.withResolvers<void>();
    probeGate = gate.promise;
    await previous;
    const prev = process.env.BUNSANE_ENTITY_SORT_PROBE;
    if (probe === undefined) delete process.env.BUNSANE_ENTITY_SORT_PROBE;
    else process.env.BUNSANE_ENTITY_SORT_PROBE = probe;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.BUNSANE_ENTITY_SORT_PROBE;
        else process.env.BUNSANE_ENTITY_SORT_PROBE = prev;
        gate.resolve();
    }
}

describe('entity timestamp sorts', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(EsClock, EsExtra);
    });

    async function makeEntity(label: string | null): Promise<string> {
        const entity = ctx.tracker.create();
        if (label !== null) entity.add(EsClock, { label });
        await entity.save();
        return entity.id;
    }

    async function stamp(id: string, created: string | null, updated: string | null): Promise<void> {
        await ctx.db.unsafe(
            `UPDATE entities SET created_at = $1::timestamptz, updated_at = $2::timestamptz WHERE id = $3`,
            [created, updated, id],
        );
    }

    async function readStamp(id: string): Promise<{ created_at: Date | null; updated_at: Date | null }> {
        const rows = await ctx.db.unsafe(
            `SELECT created_at, updated_at FROM entities WHERE id = $1`,
            [id],
        ) as Array<{ created_at: Date | null; updated_at: Date | null }>;
        const row = rows[0];
        if (!row) throw new Error(`missing entity ${id}`);
        return row;
    }

    async function idOrder(ids: string[], dir: Dir): Promise<string[]> {
        const placeholders = ids.map((_, i) => `$${i + 1}::uuid`).join(', ');
        const rows = await ctx.db.unsafe(
            `SELECT id FROM entities WHERE id IN (${placeholders}) ORDER BY id ${dir}`,
            ids,
        ) as Array<{ id: string }>;
        return rows.map((row) => row.id);
    }

    async function walk<T extends KeysetPage<T>>(
        make: () => T,
        valueOf: (id: string) => Promise<SortValue | SortValue[]>,
        pageSize: number,
    ): Promise<string[]> {
        const got: string[] = [];
        let token: string | undefined;
        for (let guard = 0; guard < 40; guard++) {
            let q = make().take(pageSize);
            if (token) q = q.sortedCursor(token);
            const page = await q.exec();
            if (page.length === 0) break;
            got.push(...page.map((row) => row.id));
            const last = page[page.length - 1]!;
            token = Query.encodeSortedCursor(await valueOf(last.id), last.id);
        }
        return got;
    }

    async function assertPages<T extends KeysetPage<T>>(
        make: () => T,
        valueOf: (id: string) => Promise<SortValue | SortValue[]>,
        expected: string[],
    ): Promise<void> {
        const unbounded = (await make().take(expected.length + 5).exec()).map((row) => row.id);
        expect(unbounded).toEqual(expected);
        expect(await walk(make, valueOf, 1)).toEqual(expected);
        expect(await walk(make, valueOf, 3)).toEqual(expected);

        for (let offset = 0; offset < expected.length; offset += 2) {
            const page = await make().take(2).offset(offset).exec();
            expect(page.map((row) => row.id)).toEqual(expected.slice(offset, offset + 2));
        }
        for (let i = 1; i < expected.length; i++) {
            const token = Query.encodeSortedCursor(await valueOf(expected[i]!), expected[i]!);
            const back = await make().sortedCursor(token, 'before').take(1).exec();
            expect(back.map((row) => row.id)).toEqual([expected[i - 1]!]);
        }
        const beforeFirst = await make()
            .sortedCursor(Query.encodeSortedCursor(await valueOf(expected[0]!), expected[0]!), 'before')
            .take(2)
            .exec();
        expect(beforeFirst).toEqual([]);
    }

    test('cursor(id) with an entity sort throws on exec and explain', async () => {
        const id = await makeEntity(null);
        const cursor = '00000000-0000-4000-8000-000000000099';
        await expect(new Query().sortByCreatedAt().cursor(cursor).take(1).exec())
            .rejects.toThrow(/cursor\(entityId\) cannot be combined with sortByCreatedAt\(\)\/sortByUpdatedAt\(\)/);
        await expect(new Query().with(EsClock).sortByUpdatedAt('DESC').cursor(id).explainAnalyze(false))
            .rejects.toThrow(/cursor\(entityId\) cannot be combined with sortByCreatedAt\(\)\/sortByUpdatedAt\(\)/);
    });

    test('invalid BUNSANE_ENTITY_SORT_PROBE throws', async () => {
        await withProbe('0', async () => {
            await expect(new Query().sortByCreatedAt().take(1).exec()).rejects.toThrow(/BUNSANE_ENTITY_SORT_PROBE/);
        });
        await withProbe('nope', async () => {
            await expect(new Query().sortByUpdatedAt().take(1).exec()).rejects.toThrow(/BUNSANE_ENTITY_SORT_PROBE/);
        });
    });

    test('count ignores entity sorts, take, and offset', async () => {
        const label = `es-count-${Date.now().toString(36)}`;
        for (let i = 0; i < 4; i++) {
            const id = await makeEntity(label);
            await stamp(
                id,
                new Date(Date.UTC(2031, 0, 1, 0, 0, i)).toISOString(),
                new Date(Date.UTC(2031, 1, 1, 0, 0, i)).toISOString(),
            );
        }
        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const plain = await scoped().count();
        expect(plain).toBe(4);
        expect(await scoped().sortByCreatedAt('DESC').take(1).offset(2).count()).toBe(plain);
        expect(await scoped().sortByUpdatedAt('ASC', true).count()).toBe(plain);
        expect(await scoped().sortByCreatedAt('ASC').sortByUpdatedAt('DESC').count()).toBe(plain);
    });

    test('soft-deleted entities are excluded with and without membership', async () => {
        const label = `es-del-${Date.now().toString(36)}`;
        const live: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await makeEntity(label);
            live.push(id);
            const ts = new Date(Date.UTC(1970, 0, 2, 0, 0, i)).toISOString();
            await stamp(id, ts, ts);
        }
        const dead = await makeEntity(label);
        // Dead is older than the live prefix. A missing entities.deleted_at
        // filter would put it first in the ASC window we own.
        await stamp(dead, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
        // Component row stays live — only the entity is soft-deleted. The old
        // .with() plan omitted entities.deleted_at and would have returned it.
        await ctx.db.unsafe(`UPDATE entities SET deleted_at = now() WHERE id = $1`, [dead]);

        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const withMembership = await sortBy(scoped(), 'created_at', 'DESC').take(10).exec();
        expect(withMembership.map((row) => row.id)).toEqual([...live].reverse());

        const bare = await new Query().sortByCreatedAt('ASC').take(live.length).exec();
        expect(bare.map((row) => row.id)).toEqual(live);
        expect(bare.map((row) => row.id)).not.toContain(dead);
    });

    test('identical timestamps tie-break by id in the sort direction, page 1 and keyset', async () => {
        const label = `es-tie-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push(await makeEntity(label));
        const created = new Date(Date.UTC(2033, 3, 1, 0, 0, 0)).toISOString();
        const updated = new Date(Date.UTC(2033, 4, 1, 0, 0, 0)).toISOString();
        for (const id of ids) await stamp(id, created, updated);

        const ascIds = await idOrder(ids, 'ASC');
        const descIds = await idOrder(ids, 'DESC');
        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const valueOf = async (id: string): Promise<Date | null> => (await readStamp(id)).created_at;

        await assertPages(() => sortBy(scoped(), 'created_at', 'ASC'), valueOf, ascIds);
        await assertPages(() => sortBy(scoped(), 'created_at', 'DESC'), valueOf, descIds);

        const updatedValue = async (id: string): Promise<Date | null> => (await readStamp(id)).updated_at;
        await assertPages(() => sortBy(scoped(), 'updated_at', 'ASC'), updatedValue, ascIds);
        await assertPages(() => sortBy(scoped(), 'updated_at', 'DESC'), updatedValue, descIds);

        // Ancient created_at is an ASC prefix even if other rows remain.
        for (const id of ids) await stamp(id, '1971-01-01T00:00:00Z', '1971-01-01T00:00:00Z');
        const bareAsc = await new Query().sortByCreatedAt('ASC').take(ids.length).exec();
        expect(bareAsc.map((row) => row.id)).toEqual(ascIds);
        const indexPlan = new Query().sortByCreatedAt('ASC').take(2);
        await indexPlan.exec();
        expect(indexPlan.getLastRouteInfo().entitySortPlan).toBe('index');

        for (const id of ids) {
            await stamp(id, '2098-01-01T00:00:00Z', '2098-01-01T00:00:00Z');
        }
        const bareDesc = await new Query().sortByUpdatedAt('DESC').take(ids.length).exec();
        expect(bareDesc.map((row) => row.id)).toEqual(descIds);
        const descPage = await new Query().sortByUpdatedAt('DESC').take(2).offset(2).exec();
        expect(descPage.map((row) => row.id)).toEqual(descIds.slice(2, 4));
        const token = Query.encodeSortedCursor(new Date(Date.UTC(2098, 0, 1)), descIds[2]!);
        const before = await new Query().sortByUpdatedAt('DESC').sortedCursor(token, 'before').take(2).exec();
        expect(before.map((row) => row.id)).toEqual(descIds.slice(0, 2));
    });

    test('millisecond ties and sub-millisecond stamps page without gaps', async () => {
        const label = `es-ms-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 8; i++) ids.push(await makeEntity(label));
        for (let i = 0; i < ids.length; i++) {
            const micros = String((i % 2) * 100).padStart(6, '0');
            const second = Math.floor(i / 2);
            await stamp(
                ids[i]!,
                `2034-05-01T00:00:${String(second).padStart(2, '0')}.${micros}+00:00`,
                `2034-06-01T00:00:${String(7 - second).padStart(2, '0')}.${micros}+00:00`,
            );
        }
        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const createdOf = async (id: string): Promise<Date | null> => (await readStamp(id)).created_at;
        const updatedOf = async (id: string): Promise<Date | null> => (await readStamp(id)).updated_at;

        for (const dir of ['ASC', 'DESC'] as const) {
            const created = (await sortBy(scoped(), 'created_at', dir).take(20).exec()).map((row) => row.id);
            await assertPages(() => sortBy(scoped(), 'created_at', dir), createdOf, created);
            const updated = (await sortBy(scoped(), 'updated_at', dir).take(20).exec()).map((row) => row.id);
            await assertPages(() => sortBy(scoped(), 'updated_at', dir), updatedOf, updated);
        }

        const asc = (await sortBy(scoped(), 'created_at', 'ASC').take(20).exec()).map((row) => row.id);
        const tieToken = Query.encodeSortedCursor(await createdOf(asc[1]!), asc[1]!);
        const afterTie = await sortBy(scoped(), 'created_at', 'ASC').sortedCursor(tieToken).take(2).exec();
        expect(afterTie.map((row) => row.id)).toEqual(asc.slice(2, 4));
    });

    test('NULL timestamps are ordered and paged, including the NULL tail', async () => {
        const label = `es-null-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push(await makeEntity(label));
        const times = [
            '2036-01-01T00:00:01Z',
            '2036-01-01T00:00:02Z',
            '2036-01-01T00:00:02Z',
            null,
            null,
            '2036-01-01T00:00:00Z',
        ];
        for (let i = 0; i < ids.length; i++) {
            await stamp(ids[i]!, times[i] ?? null, times[ids.length - 1 - i] ?? null);
        }
        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const createdOf = async (id: string): Promise<Date | null> => (await readStamp(id)).created_at;

        for (const dir of ['ASC', 'DESC'] as const) {
            for (const nullsFirst of [false, true]) {
                const expected = (await sortBy(scoped(), 'created_at', dir, nullsFirst).take(20).exec()).map((row) => row.id);
                expect([...expected].sort()).toEqual([...ids].sort());
                const stamps = await Promise.all(expected.map((id) => createdOf(id)));
                if (nullsFirst) {
                    const firstNonNull = stamps.findIndex((value) => value !== null);
                    expect(firstNonNull).toBeGreaterThan(0);
                    expect(stamps.slice(0, firstNonNull).every((value) => value === null)).toBe(true);
                } else {
                    const firstNull = stamps.findIndex((value) => value === null);
                    expect(firstNull).toBeGreaterThan(0);
                    expect(stamps.slice(firstNull).every((value) => value === null)).toBe(true);
                }
                await assertPages(() => sortBy(scoped(), 'created_at', dir, nullsFirst), createdOf, expected);
            }
        }

        const desc = (await sortBy(scoped(), 'created_at', 'DESC').take(20).exec()).map((row) => row.id);
        const descStamps = await Promise.all(desc.map((id) => createdOf(id)));
        const nonNullCount = descStamps.filter((value) => value !== null).length;
        const token = Query.encodeSortedCursor(await createdOf(desc[nonNullCount - 1]!), desc[nonNullCount - 1]!);
        const tail = await sortBy(scoped(), 'created_at', 'DESC').sortedCursor(token).take(10).exec();
        expect(tail.map((row) => row.id)).toEqual(desc.slice(nonNullCount));
        expect(tail.length).toBeGreaterThan(0);
    });

    test('multi-key entity sort pages with mixed directions and a NULL key', async () => {
        const label = `es-multi-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push(await makeEntity(label));
        const created = ['2037-01-01T00:00:01Z', '2037-01-01T00:00:01Z', '2037-01-01T00:00:01Z', '2037-01-01T00:00:02Z', null, null];
        const updated = ['2037-02-01T00:00:01Z', '2037-02-01T00:00:02Z', null, '2037-02-01T00:00:01Z', '2037-02-01T00:00:03Z', null];
        for (let i = 0; i < ids.length; i++) await stamp(ids[i]!, created[i] ?? null, updated[i] ?? null);

        const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
        const both = async (id: string): Promise<SortValue[]> => {
            const row = await readStamp(id);
            return [row.created_at, row.updated_at];
        };
        const make = () => scoped().sortByCreatedAt('ASC').sortByUpdatedAt('DESC', true);
        const expected = (await make().take(20).exec()).map((row) => row.id);
        const probe = make().take(3);
        await probe.exec();
        expect(probe.getLastRouteInfo().entitySortPlan).toBe('fallback');
        const bareMulti = new Query().sortByCreatedAt('ASC').sortByUpdatedAt('DESC').take(1);
        await bareMulti.exec();
        expect(bareMulti.getLastRouteInfo().entitySortPlan).toBe('index');
        await assertPages(make, both, expected);

        // Last key is ASC, so an identical later pair breaks ties by id ASC
        // and sorts first under created_at DESC.
        const pair = [ids[0]!, ids[1]!];
        await stamp(pair[0]!, '2037-05-01T00:00:00Z', '2037-05-01T00:00:00Z');
        await stamp(pair[1]!, '2037-05-01T00:00:00Z', '2037-05-01T00:00:00Z');
        for (const id of ids.slice(2)) await stamp(id, '2037-04-01T00:00:00Z', '2037-04-01T00:00:00Z');
        const tied = await scoped().sortByCreatedAt('DESC').sortByUpdatedAt('ASC').take(2).exec();
        expect(tied.map((row) => row.id)).toEqual(await idOrder(pair, 'ASC'));
    });

    test('OR membership and excluded components stay in canonical order', async () => {
        const label = `es-or-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
            const entity = ctx.tracker.create();
            entity.add(EsClock, { label });
            if (i === 3) entity.add(EsExtra, { tag: label });
            await entity.save();
            ids.push(entity.id);
            await stamp(
                entity.id,
                new Date(Date.UTC(2038, 0, 1, 0, 0, i)).toISOString(),
                new Date(Date.UTC(2038, 0, 2, 0, 0, i)).toISOString(),
            );
        }
        const orPage = await new Query()
            .with(or([{ component: EsClock, filters: [Query.filter('label', FilterOp.EQ, label)] }]))
            .sortByCreatedAt('ASC')
            .take(10)
            .exec();
        expect(orPage.map((row) => row.id)).toEqual(ids);

        const excluded = await new Query()
            .with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] })
            .without(EsExtra)
            .sortByCreatedAt('DESC')
            .take(10)
            .exec();
        expect(excluded.map((row) => row.id)).toEqual([ids[2]!, ids[1]!, ids[0]!]);
    });

    test('time-clustered membership reports probe or fallback and stays correct', async () => {
        await withProbe('4', async () => {
            const seed = async (prefix: string, componentAt: 'newest' | 'oldest'): Promise<string[]> => {
                const ids: string[] = [];
                for (let i = 0; i < 12; i++) {
                    const has = componentAt === 'newest' ? i >= 8 : i < 4;
                    const id = await makeEntity(has ? prefix : null);
                    ids.push(id);
                    // Non-matching side at 1970 (global ASC prefix), matching
                    // side at 2199 (global DESC prefix). Foreign now() rows sit
                    // in the middle and cannot enter a probe window of 4.
                    const atOld = componentAt === 'newest' ? i < 8 : i < 4;
                    const created = atOld
                        ? new Date(Date.UTC(1970, 0, 1, 0, 0, i)).toISOString()
                        : new Date(Date.UTC(2199, 0, 1, 0, 0, i)).toISOString();
                    const updated = atOld
                        ? new Date(Date.UTC(1970, 1, 1, 0, 0, i)).toISOString()
                        : new Date(Date.UTC(2199, 1, 1, 0, 0, i)).toISOString();
                    await stamp(id, created, updated);
                }
                return ids;
            };
            const labelOf = async (id: string): Promise<string> => {
                const rows = await ctx.db.unsafe(
                    `SELECT data->>'label' AS label FROM components WHERE entity_id = $1 AND deleted_at IS NULL`,
                    [id],
                ) as Array<{ label: string }>;
                const label = rows[0]?.label;
                if (!label) throw new Error(`missing label for ${id}`);
                return label;
            };

            const newestIds = await seed(`es-new-${Date.now().toString(36)}`, 'newest');
            const newestLabel = await labelOf(newestIds[8]!);
            const newest = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, newestLabel)] });
            const cluster = newestIds.slice(8);

            const ascMiss = newest().sortByCreatedAt('ASC').take(2);
            expect((await ascMiss.exec()).map((row) => row.id)).toEqual(cluster.slice(0, 2));
            expect(ascMiss.getLastRouteInfo().entitySortPlan).toBe('fallback');

            const descHit = newest().sortByCreatedAt('DESC').take(2);
            expect((await descHit.exec()).map((row) => row.id)).toEqual([...cluster].reverse().slice(0, 2));
            expect(descHit.getLastRouteInfo().entitySortPlan).toBe('probe');
            expect((await newest().sortByCreatedAt('ASC').take(10).exec()).map((row) => row.id)).toEqual(cluster);

            // Leave the 1970/2199 extremes so the oldest scenario owns them.
            for (const id of newestIds) await stamp(id, '2000-06-01T00:00:00Z', '2000-06-01T00:00:00Z');
            const oldestIds = await seed(`es-old-${Date.now().toString(36)}`, 'oldest');
            const oldestLabel = await labelOf(oldestIds[0]!);
            const oldest = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, oldestLabel)] });
            const oldCluster = oldestIds.slice(0, 4);

            const ascHit = oldest().sortByUpdatedAt('ASC').take(2);
            expect((await ascHit.exec()).map((row) => row.id)).toEqual(oldCluster.slice(0, 2));
            expect(ascHit.getLastRouteInfo().entitySortPlan).toBe('probe');

            const descMiss = oldest().sortByUpdatedAt('DESC').take(2);
            expect((await descMiss.exec()).map((row) => row.id)).toEqual([...oldCluster].reverse().slice(0, 2));
            expect(descMiss.getLastRouteInfo().entitySortPlan).toBe('fallback');

            expect((await oldest().sortByCreatedAt('DESC').take(10).exec()).map((row) => row.id)).toEqual([...oldCluster].reverse());
        });
    });

    test('offset skips the probe; a short exhausted window is the probe answer', async () => {
        await withProbe('100', async () => {
            const label = `es-off-${Date.now().toString(36)}`;
            const ids: string[] = [];
            for (let i = 0; i < 5; i++) {
                const id = await makeEntity(label);
                ids.push(id);
                await stamp(
                    id,
                    new Date(Date.UTC(2041, 0, 1, 0, 0, i)).toISOString(),
                    new Date(Date.UTC(2041, 0, 2, 0, 0, i)).toISOString(),
                );
            }
            const scoped = () => new Query().with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] });
            const offsetPage = scoped().sortByCreatedAt('ASC').take(2).offset(2);
            expect((await offsetPage.exec()).map((row) => row.id)).toEqual(ids.slice(2, 4));
            expect(offsetPage.getLastRouteInfo().entitySortPlan).toBe('fallback');

            // Cursor just before a 2199 prefix so the candidate window is only
            // these rows, even when the suite has far more than the probe cap.
            const sentinel = await makeEntity(label);
            await stamp(sentinel, '2198-12-31T00:00:00Z', '2198-12-31T00:00:00Z');
            for (let i = 0; i < ids.length; i++) {
                const ts = new Date(Date.UTC(2199, 11, 31, 0, 0, i)).toISOString();
                await stamp(ids[i]!, ts, ts);
            }
            const token = Query.encodeSortedCursor(new Date(Date.UTC(2198, 11, 31)), sentinel);
            const exhausted = scoped().sortByCreatedAt('ASC').sortedCursor(token).take(10);
            expect((await exhausted.exec()).map((row) => row.id)).toEqual(ids);
            expect(exhausted.getLastRouteInfo().entitySortPlan).toBe('probe');
        });
    });

    (isPglite ? test.skip : test)('no-membership list uses the bk_ entities index', async () => {
        const specs = entityKeyIndexSpecs();
        const created = specs.find((spec) => spec.columnsSql.includes('created_at') && !spec.columnsSql.includes('updated_at'));
        const updated = specs.find((spec) => spec.columnsSql.includes('updated_at'));
        if (!created || !updated) throw new Error('entity key index specs missing');
        await dbTransaction(async (trx) => {
            const opts = { conn: trx, callerOwnsConn: true as const, lane: 'request' as const };
            await dbExec(`SET LOCAL enable_seqscan = off`, [], { ...opts, label: 'entitySort.explain.seqscan' });
            await dbExec(`SET LOCAL enable_bitmapscan = off`, [], { ...opts, label: 'entitySort.explain.bitmap' });
            await dbExec(created.createSql(false), [], { ...opts, label: 'entitySort.explain.created' });
            await dbExec(updated.createSql(false), [], { ...opts, label: 'entitySort.explain.updated' });
            const createdPlan = await new Query(trx).sortByCreatedAt('DESC').take(5).explainAnalyze(false);
            expect(createdPlan).toContain(created.name);
            expect(createdPlan.toLowerCase()).toContain('index scan');
            const updatedPlan = await new Query(trx).sortByUpdatedAt('ASC').take(5).explainAnalyze(false);
            expect(updatedPlan).toContain(updated.name);
            expect(updatedPlan.toLowerCase()).toContain('index scan');
            const multiPlan = await new Query(trx)
                .with(EsClock)
                .sortByCreatedAt('ASC')
                .sortByUpdatedAt('DESC')
                .take(5)
                .explainAnalyze(false);
            expect(multiPlan).not.toContain(created.name);
            expect(multiPlan).not.toContain(updated.name);
        });
    });

    test('rare membership skips the probe when the page cannot fit in the cap', async () => {
        const label = `es-stat-${Date.now().toString(36)}`;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await makeEntity(label);
            ids.push(id);
            await stamp(id, `1900-01-01T00:00:0${i}Z`, `1900-01-01T00:00:0${i}Z`);
        }
        for (let i = 0; i < 30; i++) await makeEntity(null);
        const typeId = ComponentRegistry.getComponentId('EsClock');
        if (!typeId) throw new Error('EsClock is not registered');
        const leaf = shouldUseDirectPartition()
            ? (ComponentRegistry.getPartitionTableName(typeId) || 'components')
            : 'components';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(leaf)) throw new Error(`unexpected leaf table ${leaf}`);
        await ctx.db.unsafe(`ANALYZE entities`);
        await ctx.db.unsafe(`ANALYZE ${leaf}`);
        resetEntitySortTupleCache();
        const stats = await ctx.db.unsafe(
            `SELECT relname, reltuples::float8 AS reltuples FROM pg_class WHERE relname IN ($1, $2)`,
            [leaf, 'entities'],
        ) as Array<{ relname: string; reltuples: number | string }>;
        const positive = (name: string): number | null => {
            const row = stats.find((item) => item.relname === name);
            if (!row) return null;
            const n = typeof row.reltuples === 'number' ? row.reltuples : Number(row.reltuples);
            return Number.isFinite(n) && n > 0 ? n : null;
        };
        // take(2) fetches 3. Cap 3 skips whenever stats show the leaf is not the whole table.
        const cap = 3;
        const decision = entitySortProbeWindow({
            pageLimit: 3,
            entities: positive('entities'),
            leaves: [positive(leaf)],
            combine: 'and',
            cap,
        });
        await withProbe(String(cap), async () => {
            resetEntitySortTupleCache();
            const page = new Query()
                .with(EsClock, { filters: [Query.filter('label', FilterOp.EQ, label)] })
                .sortByCreatedAt('ASC')
                .take(2);
            expect((await page.exec()).map((row) => row.id)).toEqual(ids.slice(0, 2));
            expect(decision.probe).toBe(false);
            expect(page.getLastRouteInfo().entitySortPlan).toBe('fallback');
        });
    });
});
