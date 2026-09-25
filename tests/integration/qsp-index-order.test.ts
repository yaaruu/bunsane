/**
 * QSP rm_ list order (RFC D7): routed pages match the legacy route for after,
 * before, and offset, including ties and NULLs. Real PG also checks that a
 * routed sort is an index scan on rm_ (no Seq Scan) at a few thousand rows.
 *
 * Env is set inside the test, never at module top, so a PGlite suite does not
 * inherit BUNSANE_QSP and wedge on the single connection.
 */
import 'reflect-metadata';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../database';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { Query } from '../../query/Query';
import { ProjectionManager, runBackfill, rmTableName, assertRmTableName } from '../../database/projection';
import { PlannerCache, buildCoverageRequest, buildRmQuery } from '../../query/planner';
import type { CoverageRequest } from '../../query/planner/CoverageRequest';
import type { QueryContext } from '../../query/QueryContext';
import type { ComponentConstructor } from '../../types/query.types';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const isPGlite = process.env.USE_PGLITE === 'true';

@Component
class QspIdxOrder extends BaseComponent {
    @CompData() score!: number;
    @CompData() label!: string;
    @CompData() active!: boolean;
    @CompData() paidAt!: Date;
}

@ArcheType({ name: 'QspIdxArchetype' })
class QspIdxArchetype extends BaseArcheType {
    @ArcheTypeField(QspIdxOrder) order!: QspIdxOrder;
}

const ARCHETYPE = 'QspIdxArchetype';
const PAGE = 5;
const N = 36;

interface Seed {
    id: string;
    score: number | null;
    label: string | null;
    active: boolean | null;
    paidAt: Date | null;
}
type ListQuery = Query<readonly ComponentConstructor[]>;

function coverageOf(q: ListQuery): CoverageRequest {
    const context = Reflect.get(q, 'context');
    if (!context || typeof context !== 'object') throw new Error('Query has no context');
    return buildCoverageRequest(context as QueryContext);
}

describe('QSP index-driven list order', () => {
    createTestContext();
    const tableName = assertRmTableName(rmTableName(ARCHETYPE));
    const savedEnv = {
        qsp: process.env.BUNSANE_QSP,
        archetypes: process.env.BUNSANE_QSP_ARCHETYPES,
        throttle: process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS,
        count: process.env.BUNSANE_QSP_COUNT,
    };
    const seeded: Seed[] = [];
    let scoreCol = '';
    let labelCol = '';
    let activeCol = '';
    let paidCol = '';

    beforeAll(async () => {
        await ensureComponentsRegistered(QspIdxOrder);
        process.env.BUNSANE_QSP_ARCHETYPES = ARCHETYPE;
        process.env.BUNSANE_QSP = 'route';
        process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = '0';
        process.env.BUNSANE_QSP_COUNT = 'exact';

        await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        await db.unsafe(`CREATE TABLE IF NOT EXISTS projection_state (
            archetype text PRIMARY KEY, shape_hash text NOT NULL,
            status text NOT NULL DEFAULT 'DISABLED', shape_version int NOT NULL DEFAULT 1,
            watermark uuid, field_state jsonb NOT NULL DEFAULT '{}',
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await db.unsafe(`DELETE FROM projection_state WHERE archetype = $1`, [ARCHETYPE]);

        ProjectionManager.reset();
        PlannerCache.reset();
        await ProjectionManager.instance.initialize();
        const descriptor = ProjectionManager.instance.getDescriptor(ARCHETYPE);
        if (!descriptor) throw new Error('missing projection descriptor');
        scoreCol = descriptor.columns.find(c => c.field === 'score')?.columnName ?? '';
        labelCol = descriptor.columns.find(c => c.field === 'label')?.columnName ?? '';
        activeCol = descriptor.columns.find(c => c.field === 'active')?.columnName ?? '';
        paidCol = descriptor.columns.find(c => c.field === 'paidAt')?.columnName ?? '';
        if (!scoreCol || !labelCol || !activeCol || !paidCol) throw new Error('projected columns missing');

        for (let i = 0; i < N; i++) {
            const score = i % 7 === 0 ? null : i % 4;
            const label = i % 6 === 0 ? null : ['aa', 'aa', 'bb', 'bb', 'cc'][i % 5]!;
            const active = i % 5 === 0 ? null : i % 2 === 0;
            const paidAt = i % 8 === 0 ? null : new Date(Date.UTC(2024, 0, 1, 0, 0, 0, i % 3));
            const e = Entity.Create();
            e.add(QspIdxOrder, {
                score: score ?? 0,
                label: label ?? 'x',
                active: active ?? false,
                paidAt: paidAt ?? new Date(0),
            });
            await e.save();
            seeded.push({ id: e.id, score, label, active, paidAt });
        }

        await runBackfill(ARCHETYPE);
        await ProjectionManager.instance.setStatus(ARCHETYPE, 'READY');
        await PlannerCache.instance.refresh();

        const typeId = new QspIdxOrder().getTypeID();
        for (const row of seeded) {
            if (row.score === null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'score' WHERE entity_id = $1 AND type_id = $2`,
                    [row.id, typeId],
                );
                await db.unsafe(`UPDATE ${tableName} SET "${scoreCol}" = NULL WHERE entity_id = $1`, [row.id]);
            }
            if (row.label === null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'label' WHERE entity_id = $1 AND type_id = $2`,
                    [row.id, typeId],
                );
                await db.unsafe(`UPDATE ${tableName} SET "${labelCol}" = NULL WHERE entity_id = $1`, [row.id]);
            }
            if (row.active === null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'active' WHERE entity_id = $1 AND type_id = $2`,
                    [row.id, typeId],
                );
                await db.unsafe(`UPDATE ${tableName} SET "${activeCol}" = NULL WHERE entity_id = $1`, [row.id]);
            }
            if (row.paidAt === null) {
                await db.unsafe(
                    `UPDATE components SET data = data - 'paidAt' WHERE entity_id = $1 AND type_id = $2`,
                    [row.id, typeId],
                );
                await db.unsafe(`UPDATE ${tableName} SET "${paidCol}" = NULL WHERE entity_id = $1`, [row.id]);
            }
        }
        // Four shared timestamps so entity-sort ties exist and both surfaces see them.
        for (let i = 0; i < seeded.length; i++) {
            const stamp = new Date(Date.UTC(2024, 5, 1, 0, 0, i % 4, 0)).toISOString();
            await db.unsafe(`UPDATE entities SET created_at = $2, updated_at = $2 WHERE id = $1`, [seeded[i]!.id, stamp]);
            await db.unsafe(
                `UPDATE ${tableName} SET created_at = $2, updated_at = $2 WHERE entity_id = $1`,
                [seeded[i]!.id, stamp],
            );
        }
    });

    afterAll(async () => {
        ProjectionManager.reset();
        PlannerCache.reset();
        await db.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        if (savedEnv.qsp === undefined) delete process.env.BUNSANE_QSP;
        else process.env.BUNSANE_QSP = savedEnv.qsp;
        if (savedEnv.archetypes === undefined) delete process.env.BUNSANE_QSP_ARCHETYPES;
        else process.env.BUNSANE_QSP_ARCHETYPES = savedEnv.archetypes;
        if (savedEnv.throttle === undefined) delete process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS;
        else process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS = savedEnv.throttle;
        if (savedEnv.count === undefined) delete process.env.BUNSANE_QSP_COUNT;
        else process.env.BUNSANE_QSP_COUNT = savedEnv.count;
    });

    async function ids(make: () => ListQuery, routed: boolean): Promise<string[]> {
        process.env.BUNSANE_QSP = routed ? 'route' : 'off';
        const q = make();
        const rows = await q.exec();
        if (routed) {
            expect(q.getLastRouteInfo().routed).toBe(true);
            expect(q.getLastRouteInfo().surface).toBe('rm');
        }
        return rows.map(e => e.id);
    }

    async function parity(make: () => ListQuery): Promise<string[]> {
        const legacy = await ids(make, false);
        const routed = await ids(make, true);
        expect(routed).toEqual(legacy);
        return legacy;
    }

    async function textValue(id: string, field: string): Promise<string | null> {
        const typeId = new QspIdxOrder().getTypeID();
        const rows = await db.unsafe(
            `SELECT data->>$3 AS v FROM components WHERE entity_id = $1 AND type_id = $2 AND deleted_at IS NULL`,
            [id, typeId, field],
        ) as Array<{ v: string | null }>;
        return rows[0]?.v ?? null;
    }

    async function createdAt(id: string): Promise<Date> {
        const rows = await db.unsafe(
            `SELECT created_at FROM entities WHERE id = $1`,
            [id],
        ) as Array<{ created_at: Date | string }>;
        const raw = rows[0]?.created_at;
        if (raw == null) throw new Error(`missing created_at for ${id}`);
        return raw instanceof Date ? raw : new Date(raw);
    }

    async function walk(
        label: string,
        make: () => ListQuery,
        valueOf: (id: string) => Promise<string | number | Date | null>,
    ): Promise<void> {
        const full = await parity(() => make().take(N + 5));
        expect(full.length).toBe(N);

        for (let off = 0; off < full.length; off += PAGE) {
            const page = await parity(() => make().offset(off).take(PAGE));
            expect(page).toEqual(full.slice(off, off + PAGE));
        }

        const forward: string[] = [];
        let token: string | undefined;
        while (forward.length < full.length) {
            const cursor = token;
            const page = await parity(() => {
                const q = make().take(PAGE);
                return cursor ? q.sortedCursor(cursor, 'after') : q;
            });
            expect(page.length).toBeGreaterThan(0);
            forward.push(...page);
            const last = page[page.length - 1]!;
            token = Query.encodeSortedCursor(await valueOf(last), last);
            if (page.length < PAGE) break;
        }
        expect(forward).toEqual(full);

        const boundary = full[PAGE];
        if (!boundary) throw new Error(`${label}: missing page boundary`);
        const backToken = Query.encodeSortedCursor(await valueOf(boundary), boundary);
        const back = await parity(() => make().sortedCursor(backToken, 'before').take(PAGE));
        expect(back).toEqual(full.slice(0, PAGE));
    }

    test('key indexes replace __cover', async () => {
        const rows = await db.unsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
            [tableName],
        ) as Array<{ indexname: string }>;
        const names = rows.map(r => r.indexname);
        expect(names.some(n => n.includes('__cover'))).toBe(false);
        expect(names.some(n => n.startsWith('bk_'))).toBe(true);
    });

    test('numeric sort pages match legacy, including ties, NULLs, before, and nullsFirst', async () => {
        for (const dir of ['ASC', 'DESC'] as const) {
            for (const nullsFirst of [false, true]) {
                await walk(
                    `score ${dir} nullsFirst=${nullsFirst}`,
                    () => new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'score', dir, nullsFirst),
                    (id) => textValue(id, 'score'),
                );
            }
        }
    });

    test('text, boolean, and timestamp component sorts match legacy', async () => {
        await walk(
            'label DESC',
            () => new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'label', 'DESC'),
            (id) => textValue(id, 'label'),
        );
        await walk(
            'active ASC nullsFirst',
            () => new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'active', 'ASC', true),
            (id) => textValue(id, 'active'),
        );
        await walk(
            'paidAt DESC',
            () => new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'paidAt', 'DESC'),
            (id) => textValue(id, 'paidAt'),
        );
    });

    test('entity created_at pages match legacy', async () => {
        for (const dir of ['ASC', 'DESC'] as const) {
            await walk(
                `created_at ${dir}`,
                () => new Query().with(QspIdxOrder).sortByCreatedAt(dir),
                createdAt,
            );
        }
    });

    test('unsorted offset and id cursor pages match legacy', async () => {
        const full = await parity(() => new Query().with(QspIdxOrder).take(N + 5));
        expect(full.length).toBe(N);
        for (let off = 0; off < full.length; off += PAGE) {
            const page = await parity(() => new Query().with(QspIdxOrder).offset(off).take(PAGE));
            expect(page).toEqual(full.slice(off, off + PAGE));
        }
        const after = await parity(() => new Query().with(QspIdxOrder).cursor(full[PAGE]!, 'after').take(PAGE));
        const nextId = full[PAGE + 1];
        if (!nextId) throw new Error('unsorted page is shorter than expected');
        expect(after[0]).toBe(nextId);
        const before = await parity(() => new Query().with(QspIdxOrder).cursor(full[PAGE]!, 'before').take(PAGE));
        expect(before.length).toBe(PAGE);
    });

    test('routed DESC sort is an index scan on rm_ at a few thousand rows', async () => {
        if (isPGlite) return;
        await db.unsafe(
            `INSERT INTO ${tableName} (entity_id, "${scoreCol}", "${labelCol}", created_at, updated_at, shape_version)
             SELECT gen_random_uuid(),
                    CASE WHEN g % 11 = 0 THEN NULL ELSE (g % 20) END,
                    'k' || (g % 8),
                    timestamptz '2024-01-01' + (g || ' seconds')::interval,
                    timestamptz '2024-01-01' + (g || ' seconds')::interval,
                    1
             FROM generate_series(1, 4000) g`,
        );
        await db.unsafe(`ANALYZE ${tableName}`);

        const q = new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'score', 'DESC').take(20);
        const { sql, params } = buildRmQuery(ARCHETYPE, coverageOf(q));
        const plan = await db.unsafe(`EXPLAIN ${sql}`, params) as Array<{ 'QUERY PLAN': string }>;
        const text = plan.map(r => r['QUERY PLAN']).join('\n');
        expect(text).toMatch(/Index( Only)? Scan/);
        expect(text).not.toMatch(/Seq Scan/i);
    });

    test('hydrate columns stay aligned with the sorted ids', async () => {
        const make = () => new Query().with(QspIdxOrder).sortBy(QspIdxOrder, 'score', 'DESC').take(PAGE);
        const expected = await ids(make, true);
        const descriptor = ProjectionManager.instance.getDescriptor(ARCHETYPE);
        if (!descriptor) throw new Error('missing descriptor');
        const { sql, params } = buildRmQuery(ARCHETYPE, coverageOf(make()), descriptor.columns);
        const rows = await db.unsafe(sql, params) as Array<Record<string, unknown>>;
        expect(rows.map(row => row.entity_id)).toEqual(expected);
        expect(rows[0]?.[scoreCol]).not.toBeUndefined();
        expect(rows[0]?.[labelCol]).not.toBeUndefined();
    });
});
