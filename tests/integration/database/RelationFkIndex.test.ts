/**
 * Coverage for relation foreign-key indexing.
 *
 * CreateRelationIndexes() existed but was never wired into startup, so
 * @BelongsTo/@HasMany resolver queries (`WHERE data->>'fk' = $1`) sequentially
 * scanned relation component partition tables in production. The fix calls
 * CreateRelationIndexes() from ComponentRegistry.setupComponentFeatures().
 *
 * This suite proves the underlying mechanism — CreateForeignKeyIndex — creates
 * a usable btree index on a component partition table and is idempotent.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../../../database';
import { CreateForeignKeyIndex, GenerateTableName } from '../../../database/DatabaseHelper';
import { TestOrder } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

describe('Relation foreign-key indexing', () => {
    const tableName = GenerateTableName(TestOrder.name); // components_testorder
    const fkField = 'status';
    const indexName = `idx_${tableName}_fk_${fkField}`;

    const indexExists = async (): Promise<boolean> => {
        const rows = await db.unsafe(
            `SELECT 1 FROM pg_indexes WHERE tablename = '${tableName}' AND indexname = '${indexName}'`
        );
        return rows.length > 0;
    };

    beforeAll(async () => {
        await ensureComponentsRegistered(TestOrder);
        // Start from a clean slate so the "created" assertion is meaningful.
        await db.unsafe(`DROP INDEX IF EXISTS ${indexName}`);
    });

    test('creates a btree FK index on the component partition table', async () => {
        const created = await CreateForeignKeyIndex(tableName, fkField);
        expect(created).toBe(true);
        expect(await indexExists()).toBe(true);
    });

    test('is idempotent — second call is a no-op', async () => {
        const createdAgain = await CreateForeignKeyIndex(tableName, fkField);
        expect(createdAgain).toBe(false);
        expect(await indexExists()).toBe(true);
    });
});
