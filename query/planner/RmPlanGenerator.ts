import { ProjectionManager } from "../../database/projection/ProjectionManager";
import { rmTableName, assertRmTableName } from "../../database/projection/DDLGenerator";
import { assertIdentifier } from "../SqlIdentifier";
import type { CoverageRequest, CoverageSort } from "./CoverageRequest";
import type { ProjectedColumn } from "../../database/projection/types";
import {
    buildOrderedRowSelect,
    entityTimestampKey,
    fetchOrder,
    rmColumnKey,
    type EntityTimestampColumn,
    type SortKeyKind,
} from "../orderPlan";

/**
 * Shared filter WHERE construction for rm_ SELECT / COUNT / EXPLAIN estimate.
 * Keyset/id cursor predicates are only applied by buildRmQuery (count has no cursor).
 */
function buildRmFilterWhere(archetype: string, req: CoverageRequest): {
    table: string;
    whereClauses: string[];
    params: unknown[];
    p: (value: unknown) => string;
    columnLookup: Map<string, ProjectedColumn>;
} {
    const descriptor = ProjectionManager.instance.getDescriptor(archetype);
    if (!descriptor) {
        throw new Error(`No projection descriptor for archetype ${archetype}`);
    }

    const columnLookup = new Map<string, ProjectedColumn>();
    for (const col of descriptor.columns) {
        columnLookup.set(`${col.component}:${col.field}`, col);
    }

    const table = assertRmTableName(rmTableName(archetype));
    const params: unknown[] = [];
    const p = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
    };

    const whereClauses: string[] = ['deleted_at IS NULL'];

    for (const f of req.filters) {
        const col = columnLookup.get(`${f.component}:${f.field}`);
        if (!col) {
            throw new Error(`Filter column not found in descriptor: ${f.component}:${f.field}`);
        }
        const colRef = `"${assertIdentifier(col.columnName, 'rmFilterColumn')}"`;
        if (f.operator === 'IN' || f.operator === 'NOT IN') {
            const vals = Array.isArray(f.value) ? f.value : [];
            const phs = vals.map(v => p(v)).join(', ');
            whereClauses.push(`${colRef} ${f.operator} (${phs})`);
        } else {
            whereClauses.push(`${colRef} ${f.operator} ${p(f.value)}`);
        }
    }

    return { table, whereClauses, params, p, columnLookup };
}

function resolveSort(
    sort: CoverageSort,
    columnLookup: Map<string, ProjectedColumn>,
): { expr: string; kind: SortKeyKind } {
    if (sort.kind === 'entity') {
        const column: EntityTimestampColumn = sort.field === 'updated_at' ? 'updated_at' : 'created_at';
        return { expr: entityTimestampKey(null, column), kind: 'timestamp' };
    }
    const col = columnLookup.get(`${sort.component}:${sort.field}`);
    if (!col) {
        throw new Error(`Sort column not found: ${sort.component}:${sort.field}`);
    }
    const quoted = `"${assertIdentifier(col.columnName, 'rmSortColumn')}"`;
    const key = rmColumnKey(quoted, col.sqlType);
    if (!key) {
        throw new Error(`rm_ column ${col.columnName} (${col.sqlType}) is not a sort key`);
    }
    return key;
}

function hydrateSelect(columns: readonly ProjectedColumn[]): string[] {
    const seen = new Set<string>();
    const extra: string[] = [];
    for (const col of columns) {
        const name = assertIdentifier(col.columnName, 'rmHydrateColumn');
        if (seen.has(name) || name === 'entity_id') continue;
        seen.add(name);
        extra.push(`"${name}"`);
    }
    return extra;
}

export function buildRmQuery(
    archetype: string,
    req: CoverageRequest,
    hydrateColumns: ProjectedColumn[] = [],
): { sql: string; params: unknown[] } {
    if (req.sorts.length > 1) {
        throw new Error('rm_ plans do not support multi-key sorts');
    }

    const { table, whereClauses, params, p, columnLookup } = buildRmFilterWhere(archetype, req);
    const extraSelect = hydrateSelect(hydrateColumns);
    const isBefore = req.cursor?.direction === 'before';
    const sort = req.sorts[0];

    if (sort) {
        const key = resolveSort(sort, columnLookup);
        const fetched = fetchOrder(sort.direction === 'DESC' ? 'DESC' : 'ASC', sort.nullsFirst, isBefore);
        const cursor = req.cursor?.kind === 'keyset'
            ? { value: req.cursor.v ?? null, id: req.cursor.id }
            : null;
        const sql = buildOrderedRowSelect({
            idExpr: 'entity_id',
            fromSql: table,
            where: whereClauses,
            key: {
                expr: key.expr,
                kind: key.kind,
                direction: fetched.direction,
                nullsFirst: fetched.nullsFirst,
            },
            cursor,
            limit: req.limit,
            // A keyset cursor already positions the page. sortedCursor() clears offset.
            offset: cursor ? 0 : req.offset,
            addParam: (value: unknown) => {
                params.push(value);
                return params.length;
            },
            // Every routed sort column has a bk_ key index (created with the table).
            indexed: true,
        }, {
            idAlias: 'entity_id',
            extraSelect,
        });
        return { sql, params };
    }

    if (req.cursor?.kind === 'keyset') {
        throw new Error('rm_ keyset cursor requires exactly one sort');
    }
    if (req.cursor?.kind === 'id') {
        const op = isBefore ? '<' : '>';
        whereClauses.push(`entity_id ${op} ${p(req.cursor.id)}::uuid`);
    }

    const dir = isBefore ? 'DESC' : 'ASC';
    const selectList = ['entity_id', ...extraSelect].join(', ');
    let sql = `SELECT ${selectList} FROM ${table} WHERE ${whereClauses.join(' AND ')} ORDER BY entity_id ${dir}`;
    if (req.limit !== null) sql += ` LIMIT ${p(req.limit)}`;
    if (!req.cursor && req.offset > 0) sql += ` OFFSET ${p(req.offset)}`;
    return { sql, params };
}

export function buildRmCountQuery(archetype: string, req: CoverageRequest): { sql: string; params: unknown[] } {
    const { table, whereClauses, params } = buildRmFilterWhere(archetype, req);
    const whereSql = whereClauses.join(' AND ');
    const sql = `SELECT count(*)::bigint AS count FROM ${table} WHERE ${whereSql}`;
    return { sql, params };
}

/**
 * Same filter WHERE as count, no ORDER/LIMIT — intended for EXPLAIN (FORMAT JSON)
 * under BUNSANE_QSP_COUNT=estimate.
 */
export function buildRmEstimateQuery(archetype: string, req: CoverageRequest): { sql: string; params: unknown[] } {
    const { table, whereClauses, params } = buildRmFilterWhere(archetype, req);
    const whereSql = whereClauses.join(' AND ');
    const sql = `SELECT 1 FROM ${table} WHERE ${whereSql}`;
    return { sql, params };
}
