import type { SQL } from 'bun';
import { projDdl } from './exec';
import { getMetadataStorage } from '../../core/metadata';
import { assertIdentifier, InvalidIdentifierError } from '../../query/SqlIdentifier';
import { entityTimestampKey, rmColumnKey, type EntityTimestampColumn } from '../../query/orderPlan';
import { expressionKeyIndexSpec, type KeyIndexSpec } from '../keyIndexSpec';
import { reconcileKeyIndexSpecs } from '../indexReconciler';
import { COMPONENT_ID_FIELD, type ProjectedColumn, type ProjectionSqlType } from './types';

const SQL_TYPES: Record<ProjectionSqlType, string> = {
    text: 'text',
    numeric: 'numeric',
    timestamptz: 'timestamptz',
    boolean: 'boolean',
    uuid: 'uuid',
};

export const rmTableName = (archetypeName: string): string => `rm_${archetypeName.toLowerCase()}`;

export const assertRmTableName = (name: string, storage = getMetadataStorage()): string => {
    const allowed = new Set(storage.archetypes.map(a => rmTableName(a.name)));
    if (!allowed.has(name) || !/^rm_[a-z0-9_]+$/.test(name)) {
        throw new InvalidIdentifierError('rmTableName', name);
    }
    return name;
};

const sqlType = (type: ProjectionSqlType): string => {
    const mapped = SQL_TYPES[type];
    if (!mapped) throw new Error(`Unsupported projection sqlType: ${type}`);
    return mapped;
};

/** Caller-owned trx: raw on that handle (no pool slot). Otherwise pool DDL through the gateway. */
const runDdl = async (label: string, sql: string, trx?: SQL): Promise<void> => {
    if (trx) await trx.unsafe(sql);
    else await projDdl(label, sql);
};

export const createRmTable = async (
    archetypeName: string,
    columns: ProjectedColumn[],
    trx?: SQL
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const columnDefs = columns.map(col => {
        const columnName = assertIdentifier(col.columnName, 'projectedColumn');
        return `"${columnName}" ${sqlType(col.sqlType)}`;
    });
    const projectedColumns = columnDefs.length > 0 ? `,\n        ${columnDefs.join(',\n        ')}` : '';

    await runDdl('projection.createRmTable', `CREATE TABLE IF NOT EXISTS ${tableName} (
        entity_id uuid PRIMARY KEY${projectedColumns},
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        shape_version int NOT NULL DEFAULT 1
    )`, trx);
};

const useConcurrently = (trx?: SQL): boolean => !trx && process.env.USE_PGLITE !== 'true';

function columnKeySpec(tableName: string, column: ProjectedColumn): KeyIndexSpec | null {
    if (column.kind === 'component_id' || column.field === COMPONENT_ID_FIELD || column.sqlType === 'uuid') return null;
    const key = rmColumnKey(`"${assertIdentifier(column.columnName, 'projectedColumn')}"`, column.sqlType);
    if (!key) return null;
    return expressionKeyIndexSpec(tableName, [tableName, column.columnName], key.expr);
}

/** Per projected column, plus `created_at` / `updated_at`. Same expressions the sort SQL emits. */
export function rmKeyIndexSpecs(tableName: string, columns: readonly ProjectedColumn[]): KeyIndexSpec[] {
    const specs: KeyIndexSpec[] = [];
    for (const column of columns) {
        const spec = columnKeySpec(tableName, column);
        if (spec) specs.push(spec);
    }
    const timestamps: EntityTimestampColumn[] = ['created_at', 'updated_at'];
    for (const column of timestamps) {
        specs.push(expressionKeyIndexSpec(tableName, [tableName, column], entityTimestampKey(null, column)));
    }
    return specs;
}

async function createIndex(label: string, sql: string, trx?: SQL): Promise<void> {
    try {
        await runDdl(label, sql, trx);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Winner and loser can both ensure the same index. IF NOT EXISTS does not
        // cover two CREATE INDEX CONCURRENTLY calls that pass the catalog check together.
        if (/already exists/i.test(message)) return;
        throw err;
    }
}

async function dropCoveringIndex(tableName: string, trx?: SQL): Promise<void> {
    const indexName = assertIdentifier(`idx_${tableName}__cover`.slice(0, 63), 'projectionIndex');
    const concurrently = useConcurrently(trx) ? ' CONCURRENTLY' : '';
    await runDdl('projection.dropCoveringIndex', `DROP INDEX${concurrently} IF EXISTS ${indexName}`, trx);
}

/**
 * Key indexes for every sortable projected column and for entity timestamps.
 * Drops the legacy `__cover` index only after the replacements exist.
 */
export const ensureRmKeyIndexes = async (
    archetypeName: string,
    columns: readonly ProjectedColumn[],
    trx?: SQL,
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const specs = rmKeyIndexSpecs(tableName, columns);
    if (trx) {
        for (const spec of specs) {
            await createIndex('projection.ensureKeyIndex', spec.createSql(false), trx);
        }
        await dropCoveringIndex(tableName, trx);
        return;
    }
    const cover = assertIdentifier(`idx_${tableName}__cover`.slice(0, 63), 'projectionIndex');
    await reconcileKeyIndexSpecs({
        specs,
        dropUndesired: true,
        coverIndexes: [{ table: tableName, name: cover }],
    });
};

/** Key index for one column added by schema growth. No-op for uuid `__cid`. */
export const ensureRmColumnKeyIndex = async (
    archetypeName: string,
    column: ProjectedColumn,
    trx?: SQL,
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const spec = columnKeySpec(tableName, column);
    if (!spec) return;
    await createIndex('projection.ensureColumnKeyIndex', spec.createSql(useConcurrently(trx)), trx);
};


export const addColumn = async (
    archetypeName: string,
    column: ProjectedColumn,
    trx?: SQL
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const columnName = assertIdentifier(column.columnName, 'projectedColumn');
    await runDdl('projection.addColumn', `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS "${columnName}" ${sqlType(column.sqlType)}`, trx);
};
