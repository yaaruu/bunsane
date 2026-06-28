/**
 * Phase 1 of RFC_MATERIALIZED_READ_MODELS: scalar `@CompData({ indexed: true })`
 * must create a B-tree (or numeric) index that serves `data->>'field'` equality
 * and ORDER BY — NOT the historical per-field GIN, which only serves containment
 * (`@>`) and silently left scalar filters doing sequential scans.
 *
 * Benchmarked impact (staging PG 17, 1M rows): the GIN-only path seq-scanned at
 * ~43ms; the btree path Index-Scans at ~0.5ms (~100x). See RFC §9.
 *
 * This suite proves the index-layer mechanism directly via `ensureLegacyIndexedFields`,
 * independent of the full component-registration flow.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../../../database';
import { ensureLegacyIndexedFields, pickScalarIndexType } from '../../../database/IndexingStrategy';

const TABLE = 'phase1_legacy_idx_test';

async function indexMap(): Promise<Record<string, string>> {
    const rows = await db.unsafe(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${TABLE}'`
    );
    return Object.fromEntries(rows.map((r: any) => [r.indexname, r.indexdef]));
}

describe('Phase 1: type-aware indexes for legacy indexed:true', () => {
    beforeAll(async () => {
        await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
        await db.unsafe(
            `CREATE TABLE ${TABLE} (id uuid DEFAULT gen_random_uuid(), data jsonb NOT NULL, PRIMARY KEY (id))`
        );
        // Simulate an EXISTING database carrying the old scalar-GIN footgun on 'name'.
        await db.unsafe(`CREATE INDEX idx_${TABLE}_name_gin ON ${TABLE} USING GIN ((data->'name'))`);
    });

    afterAll(async () => {
        await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    });

    test('pickScalarIndexType maps property types to the right index', () => {
        expect(pickScalarIndexType({ propertyType: String })).toBe('btree');
        expect(pickScalarIndexType({ propertyType: Number })).toBe('numeric');
        expect(pickScalarIndexType({ propertyType: Boolean })).toBe('btree');
        expect(pickScalarIndexType({ propertyType: Date })).toBe('btree');
        // array/object fields keep GIN (containment is the real use)
        expect(pickScalarIndexType({ propertyType: Array, arrayOf: String })).toBe('gin');
        expect(pickScalarIndexType({ arrayOf: Number })).toBe('gin');
    });

    test('string -> btree, number -> numeric, array -> gin; scalar GIN footgun dropped', async () => {
        await ensureLegacyIndexedFields(TABLE, [
            { propertyKey: 'name', propertyType: String },
            { propertyKey: 'age', propertyType: Number },
            { propertyKey: 'tags', propertyType: Array, arrayOf: String },
        ]);
        const idx = await indexMap();

        // string scalar -> btree expression index on (data->>'name')
        const btree = idx[`idx_${TABLE}_name_btree`];
        expect(btree).toBeDefined();
        expect(btree!.toLowerCase()).toContain('using btree');
        expect(btree!).toMatch(/->>\s*'name'/);

        // number scalar -> numeric functional index
        const numeric = idx[`idx_${TABLE}_age_numeric`];
        expect(numeric).toBeDefined();
        expect(numeric!).toContain('numeric');

        // array field -> GIN kept
        const gin = idx[`idx_${TABLE}_tags_gin`];
        expect(gin).toBeDefined();
        expect(gin!.toLowerCase()).toContain('using gin');

        // the obsolete scalar GIN on 'name' must be gone (it cannot serve =/ORDER BY)
        expect(idx[`idx_${TABLE}_name_gin`]).toBeUndefined();
    });

    test('is idempotent — re-running keeps the same indexes and does not throw', async () => {
        await ensureLegacyIndexedFields(TABLE, [
            { propertyKey: 'name', propertyType: String },
            { propertyKey: 'age', propertyType: Number },
        ]);
        const idx = await indexMap();
        expect(idx[`idx_${TABLE}_name_btree`]).toBeDefined();
        expect(idx[`idx_${TABLE}_age_numeric`]).toBeDefined();
    });

    test('btree index is usable for `data->>field = ?` (planner picks Index Scan)', async () => {
        await db.unsafe(
            `INSERT INTO ${TABLE} (data) SELECT jsonb_build_object('name', 'n' || g, 'age', (g % 100)) FROM generate_series(1, 2000) g`
        );
        await db.unsafe(`ANALYZE ${TABLE}`);
        // enable_seqscan=off forces the planner to reveal whether the index is even an option
        await db.unsafe(`SET enable_seqscan = off`);
        const plan: any[] = await db.unsafe(
            `EXPLAIN (FORMAT TEXT) SELECT id FROM ${TABLE} WHERE data->>'name' = 'n42'`
        );
        await db.unsafe(`SET enable_seqscan = on`);
        const text = plan.map((r: any) => r['QUERY PLAN']).join('\n');
        expect(text).toContain('Index Scan');
    });
});
