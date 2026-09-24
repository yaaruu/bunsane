import type { SQL } from 'bun';
import { projDdl } from './exec';
import { getMetadataStorage } from '../../core/metadata';
import { assertIdentifier, InvalidIdentifierError } from '../../query/SqlIdentifier';
import type { ProjectedColumn, ProjectionSqlType } from './types';

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

export const createCoveringIndex = async (
    archetypeName: string,
    opts: { equalityColumns: string[]; sortColumn?: string; sortDir?: 'ASC' | 'DESC' },
    trx?: SQL
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const indexName = assertIdentifier(`idx_${tableName}__cover`.slice(0, 63), 'projectionIndex');
    const equalityColumns = opts.equalityColumns.map(col => `"${assertIdentifier(col, 'projectionIndexColumn')}"`);
    const sortDir = opts.sortDir === 'ASC' || opts.sortDir === 'DESC' ? opts.sortDir : 'ASC';
    const sortColumn = opts.sortColumn ? [`"${assertIdentifier(opts.sortColumn, 'projectionSortColumn')}" ${sortDir}`] : [];
    const indexColumns = [...equalityColumns, ...sortColumn, 'entity_id'].join(', ');
    const concurrently = trx ? '' : (process.env.USE_PGLITE ? '' : ' CONCURRENTLY');

    await runDdl(
        'projection.createCoveringIndex',
        `CREATE INDEX${concurrently} IF NOT EXISTS ${indexName} ON ${tableName} (${indexColumns}) INCLUDE (created_at, updated_at) WHERE deleted_at IS NULL`,
        trx,
    );
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
