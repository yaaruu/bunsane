import type { SQL } from 'bun';
import db from '../index';
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

const executor = (trx?: SQL) => trx ?? db;

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

    await executor(trx).unsafe(`CREATE TABLE IF NOT EXISTS ${tableName} (
        entity_id uuid PRIMARY KEY${projectedColumns},
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        shape_version int NOT NULL DEFAULT 1
    )`);
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

    await executor(trx).unsafe(
        `CREATE INDEX${concurrently} IF NOT EXISTS ${indexName} ON ${tableName} (${indexColumns}) INCLUDE (created_at, updated_at) WHERE deleted_at IS NULL`
    );
};

export const addColumn = async (
    archetypeName: string,
    column: ProjectedColumn,
    trx?: SQL
): Promise<void> => {
    const tableName = assertRmTableName(rmTableName(archetypeName));
    const columnName = assertIdentifier(column.columnName, 'projectedColumn');
    await executor(trx).unsafe(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS "${columnName}" ${sqlType(column.sqlType)}`);
};
