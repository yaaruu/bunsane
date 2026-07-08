import { ProjectionManager } from "../../database/projection/ProjectionManager";
import { rmTableName, assertRmTableName } from "../../database/projection/DDLGenerator";
import { assertIdentifier } from "../SqlIdentifier";
import type { CoverageRequest } from "./CoverageRequest";
import type { ProjectedColumn } from "../../database/projection/types";

/**
 * Shared filter WHERE construction for rm_ SELECT / COUNT / EXPLAIN estimate.
 * Keyset/id cursor predicates are only applied by buildRmQuery (count has no cursor).
 */
function buildRmFilterWhere(archetype: string, req: CoverageRequest): {
    table: string;
    whereClauses: string[];
    params: any[];
    p: (v: any) => string;
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
    const params: any[] = [];
    const p = (v: any): string => {
        params.push(v);
        return `$${params.length}`;
    };

    const whereClauses: string[] = ['deleted_at IS NULL'];

    for (const f of req.filters) {
        const col = columnLookup.get(`${f.component}:${f.field}`);
        if (!col) {
            throw new Error(`Filter column not found in descriptor: ${f.component}:${f.field}`);
        }
        const colName = assertIdentifier(col.columnName, 'rmFilterColumn');
        const colRef = `"${colName}"`;
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

export function buildRmQuery(archetype: string, req: CoverageRequest): { sql: string; params: any[] } {
    const { table, whereClauses, params, p, columnLookup } = buildRmFilterWhere(archetype, req);

    const hasKeyset = req.cursor?.kind === 'keyset';
    const hasIdCursor = req.cursor?.kind === 'id' && !hasKeyset;

    if (hasKeyset && req.cursor) {
        const c = req.cursor;
        const s = req.sorts[0]!; // guaranteed by planner
        if (s.kind === 'entity') {
            const col = s.field === 'updated_at' ? 'updated_at' : 'created_at';
            const trunc = `date_trunc('milliseconds', "${col}")`;
            const rawCol = `"${col}"`;
            const v = c.v ?? null;
            const id = c.id;
            if (v === null) {
                whereClauses.push('FALSE');
            } else if (s.direction === 'ASC') {
                const vPh = p(v);
                const idPh = p(id);
                whereClauses.push(`((${trunc}, entity_id) > (${vPh}::timestamptz, ${idPh}::uuid) OR ${rawCol} IS NULL)`);
            } else {
                const vLt = p(v);
                const vEq = p(v);
                const idGt = p(id);
                whereClauses.push(`(${trunc} < ${vLt}::timestamptz OR (${trunc} = ${vEq}::timestamptz AND entity_id > ${idGt}::uuid))`);
            }
        } else {
            // component sort
            const col = columnLookup.get(`${s.component}:${s.field}`);
            if (!col) {
                throw new Error(`Sort column not found: ${s.component}:${s.field}`);
            }
            const colName = assertIdentifier(col.columnName, 'rmSortColumn');
            const expr = `"${colName}"`;
            const cast = col.sqlType === 'numeric' ? '::numeric' : '::text';
            const v = c.v ?? null;
            const id = c.id;
            const isDesc = s.direction === 'DESC';
            const nullsLast = !s.nullsFirst;
            if (v === null) {
                const idPh = p(id);
                whereClauses.push(`(${expr} IS NULL AND entity_id > ${idPh}::uuid)`);
            } else if (!isDesc) {
                const vPh = p(v);
                const idPh = p(id);
                const nullInclude = nullsLast ? ` OR ${expr} IS NULL` : '';
                whereClauses.push(`((${expr}, entity_id) > (${vPh}${cast}, ${idPh}::uuid)${nullInclude})`);
            } else {
                const vLt = p(v);
                const vEq = p(v);
                const idGt = p(id);
                whereClauses.push(`(${expr} < ${vLt}${cast} OR (${expr} = ${vEq}${cast} AND entity_id > ${idGt}::uuid))`);
            }
        }
    }

    if (hasIdCursor && req.cursor) {
        // Only 'after' supported
        const idPh = p(req.cursor.id);
        whereClauses.push(`entity_id > ${idPh}::uuid`);
    }

    let orderBy = '';
    if (req.sorts.length === 1) {
        const s = req.sorts[0]!;
        const dir = s.direction === 'DESC' ? 'DESC' : 'ASC';
        const nulls = s.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
        if (s.kind === 'component') {
            const col = columnLookup.get(`${s.component}:${s.field}`);
            if (!col) {
                throw new Error(`Sort column not found: ${s.component}:${s.field}`);
            }
            const colName = assertIdentifier(col.columnName, 'rmSortColumn');
            const colRef = `"${colName}"`;
            orderBy = ` ORDER BY ${colRef} ${dir} ${nulls}, entity_id ASC`;
        } else {
            // entity
            const col = s.field === 'updated_at' ? 'updated_at' : 'created_at';
            if (hasKeyset) {
                orderBy = ` ORDER BY date_trunc('milliseconds', "${col}") ${dir} ${nulls}, entity_id ASC`;
            } else {
                orderBy = ` ORDER BY "${col}" ${dir} ${nulls}, entity_id ASC`;
            }
        }
    } else if (hasIdCursor || (!hasKeyset && req.sorts.length === 0)) {
        orderBy = ' ORDER BY entity_id ASC';
    }

    let limitClause = '';
    if (req.limit !== null) {
        limitClause = ` LIMIT ${p(req.limit)}`;
    }

    let offsetClause = '';
    if (!hasKeyset && (req.offset > 0 || req.limit !== null)) {
        offsetClause = ` OFFSET ${p(req.offset)}`;
    }

    const whereSql = whereClauses.join(' AND ');
    const sql = `SELECT entity_id FROM ${table} WHERE ${whereSql}${orderBy}${limitClause}${offsetClause}`;
    return { sql, params };
}

export function buildRmCountQuery(archetype: string, req: CoverageRequest): { sql: string; params: any[] } {
    const { table, whereClauses, params } = buildRmFilterWhere(archetype, req);
    const whereSql = whereClauses.join(' AND ');
    const sql = `SELECT count(*)::bigint AS count FROM ${table} WHERE ${whereSql}`;
    return { sql, params };
}

/**
 * Same filter WHERE as count, no ORDER/LIMIT — intended for EXPLAIN (FORMAT JSON)
 * under BUNSANE_QSP_COUNT=estimate.
 */
export function buildRmEstimateQuery(archetype: string, req: CoverageRequest): { sql: string; params: any[] } {
    const { table, whereClauses, params } = buildRmFilterWhere(archetype, req);
    const whereSql = whereClauses.join(' AND ');
    const sql = `SELECT 1 FROM ${table} WHERE ${whereSql}`;
    return { sql, params };
}
