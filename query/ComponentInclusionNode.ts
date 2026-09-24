import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext, sortedCursorValues } from "./QueryContext";
import { shouldUseLateralJoins, shouldUseDirectPartition } from "../core/Config";
import {
    buildComponentFilterCondition,
    buildComponentFilterGroup,
} from "./FilterBuilder";
import { ComponentRegistry } from "../core/components";
import { getMetadataStorage } from "../core/metadata";
import { assertIdentifier, normalizeSortDirection } from "./SqlIdentifier";
import { getMembershipSource, getMembershipTable } from "./membershipSource";

const numericByComponent = new WeakMap<object, Map<string, boolean>>();

/**
 * Check if a component property is numeric based on metadata.
 * Result is cached on the component metadata object (WeakMap) so sort/filter
 * emission does not re-walk property lists. Unregistered components are not
 * cached — registration may still follow.
 */
export function isNumericProperty(componentName: string, propertyName: string): boolean {
    const storage = getMetadataStorage();
    const componentMeta = storage.components_map.get(componentName);
    if (componentMeta) {
        const hit = numericByComponent.get(componentMeta)?.get(propertyName);
        if (hit !== undefined) return hit;
    }

    const typeId = storage.getComponentId(componentName);
    const indexedFields = storage.getIndexedFields(typeId);
    const indexedField = indexedFields.find(f => f.propertyKey === propertyName);
    let numeric = false;
    if (indexedField?.indexType === 'numeric') {
        numeric = true;
    } else {
        const props = storage.getComponentProperties(typeId);
        const prop = props.find(p => p.propertyKey === propertyName);
        numeric = prop?.propertyType === Number;
    }

    if (componentMeta) {
        let cache = numericByComponent.get(componentMeta);
        if (!cache) {
            cache = new Map();
            numericByComponent.set(componentMeta, cache);
        }
        cache.set(propertyName, numeric);
    }
    return numeric;
}

export type KeysetValueCast = '::text' | '::numeric' | '::timestamptz';

export interface KeysetCursorKey {
    sortExpr: string;
    /** Fetch ORDER BY direction (already flipped for 'before'). */
    direction: 'ASC' | 'DESC';
    /** Fetch NULLS placement (already flipped for 'before'). */
    nullsFirst: boolean;
    valueCast: KeysetValueCast;
    /** Cursor value for this key. null means the cursor row's key was NULL. */
    value: string | null;
}

export interface MultiKeysetCursorArgs {
    keys: KeysetCursorKey[];
    entityIdCol: string;
    connective: 'WHERE' | 'AND';
    cursorId: string;
    addParam: (value: unknown) => number;
    /** Tie-break direction matching ORDER BY entity_id. Default ASC. */
    idDirection?: 'ASC' | 'DESC';
}

/**
 * Composite keyset WHERE fragment.
 *
 * Single-key callers may pass the legacy shape (`sortExpr` + `cursor`).
 * N-key callers pass `keys` (each with its own direction, NULLS placement,
 * cast, and cursor value) plus `cursorId`.
 *
 * Returns ` ${connective} <predicate>` (leading space). Params are pushed
 * only through `addParam`, which must return the 1-based placeholder index.
 *
 * N-key predicate is the expanded lexicographic OR-chain:
 * `(k1 op1 v1) OR (k1 = v1 AND k2 op2 v2) OR ... OR (all equal AND id op id)`
 * with IS NULL / IS NOT NULL branches so NULLS FIRST/LAST match ORDER BY.
 * A row-value comparison is used only when every direction matches (including
 * the id tie-break) and no key can be NULL (timestamptz entity columns).
 *
 * One-key `keys` arrays delegate to the legacy emitter so issued single-key
 * SQL (and tokens) stay stable.
 */
export function buildKeysetCursorWhere(args: {
    sortExpr: string;
    entityIdCol: string;
    connective: 'WHERE' | 'AND';
    direction: 'ASC' | 'DESC';
    nullsFirst: boolean;
    valueCast: KeysetValueCast;
    cursor: { v: string | null; id: string };
    addParam: (value: unknown) => number;
    /** Tie-break direction matching ORDER BY entity_id. Default ASC. */
    idDirection?: 'ASC' | 'DESC';
} | MultiKeysetCursorArgs): string {
    if ('keys' in args) {
        return buildKeysetFromKeys(args);
    }
    const { sortExpr, entityIdCol, connective, direction, nullsFirst, valueCast, cursor, addParam } = args;
    const idDesc = args.idDirection === 'DESC';
    const idOp = idDesc ? '<' : '>';
    if (cursor.v === null) {
        const idIdx = addParam(cursor.id);
        return ` ${connective} (${sortExpr} IS NULL AND ${entityIdCol} ${idOp} $${idIdx}::uuid)`;
    }
    if (direction !== 'DESC') {
        const nullInclude = nullsFirst ? '' : ` OR ${sortExpr} IS NULL`;
        if (!idDesc) {
            const vIdx = addParam(cursor.v);
            const idIdx = addParam(cursor.id);
            return ` ${connective} ((${sortExpr}, ${entityIdCol}) > ($${vIdx}${valueCast}, $${idIdx}::uuid)${nullInclude})`;
        }
        const vGtIdx = addParam(cursor.v);
        const vEqIdx = addParam(cursor.v);
        const idIdx = addParam(cursor.id);
        return ` ${connective} (${sortExpr} > $${vGtIdx}${valueCast} OR (${sortExpr} = $${vEqIdx}${valueCast} AND ${entityIdCol} < $${idIdx}::uuid)${nullInclude})`;
    }
    const vLtIdx = addParam(cursor.v);
    const vEqIdx = addParam(cursor.v);
    const idIdx = addParam(cursor.id);
    return ` ${connective} (${sortExpr} < $${vLtIdx}${valueCast} OR (${sortExpr} = $${vEqIdx}${valueCast} AND ${entityIdCol} ${idOp} $${idIdx}::uuid))`;
}

function buildKeysetFromKeys(args: MultiKeysetCursorArgs): string {
    if (args.keys.length === 0) {
        throw new Error('sortedCursor() requires at least one sort key.');
    }
    if (args.keys.length === 1) {
        const key = args.keys[0]!;
        return buildKeysetCursorWhere({
            sortExpr: key.sortExpr,
            entityIdCol: args.entityIdCol,
            connective: args.connective,
            direction: key.direction,
            nullsFirst: key.nullsFirst,
            valueCast: key.valueCast,
            cursor: { v: key.value, id: args.cursorId },
            addParam: args.addParam,
            idDirection: args.idDirection,
        });
    }
    const rowCompare = tryRowValueComparison(args);
    if (rowCompare) return rowCompare;
    return buildExpandedKeysetOr(args);
}

/**
 * `(k1, k2, id) > ($1, $2, $3)` is only valid when every column compares in
 * the same direction and none of them can be NULL. Component JSON keys can
 * be NULL; timestamptz entity columns cannot.
 */
function tryRowValueComparison(args: MultiKeysetCursorArgs): string | null {
    const idDirection = args.idDirection ?? 'ASC';
    const dir = args.keys[0]!.direction;
    if (args.keys.some((key) => key.direction !== dir)) return null;
    if (dir === 'ASC' ? idDirection !== 'ASC' : idDirection !== 'DESC') return null;
    if (args.keys.some((key) => key.value === null || key.valueCast !== '::timestamptz')) return null;
    const op = dir === 'DESC' ? '<' : '>';
    const valueIdx = args.keys.map((key) => args.addParam(key.value));
    const idIdx = args.addParam(args.cursorId);
    const lhs = [...args.keys.map((key) => key.sortExpr), args.entityIdCol].join(', ');
    const rhs = [
        ...args.keys.map((key, i) => `$${valueIdx[i]}${key.valueCast}`),
        `$${idIdx}::uuid`,
    ].join(', ');
    return ` ${args.connective} ((${lhs}) ${op} (${rhs}))`;
}

/**
 * Lexicographic "strictly after the cursor" for mixed directions and NULLs.
 * A NULL cursor value ties on `IS NULL` and is strictly-after only when
 * NULLS FIRST (every non-null sorts later). A non-null cursor is strictly-after
 * on `>`/`<`, plus `IS NULL` when NULLS LAST.
 */
function buildExpandedKeysetOr(args: MultiKeysetCursorArgs): string {
    const idOp = args.idDirection === 'DESC' ? '<' : '>';
    const valueIdx = args.keys.map((key) => (key.value === null ? null : args.addParam(key.value)));
    const idIdx = args.addParam(args.cursorId);

    const tieOf = (i: number): string => {
        const key = args.keys[i]!;
        if (key.value === null) return `(${key.sortExpr} IS NULL)`;
        return `(${key.sortExpr} = $${valueIdx[i]}${key.valueCast})`;
    };
    const strictOf = (i: number): string | null => {
        const key = args.keys[i]!;
        if (key.value === null) {
            return key.nullsFirst ? `(${key.sortExpr} IS NOT NULL)` : null;
        }
        const op = key.direction === 'DESC' ? '<' : '>';
        const cmp = `${key.sortExpr} ${op} $${valueIdx[i]}${key.valueCast}`;
        if (key.nullsFirst) return `(${cmp})`;
        return `(${cmp} OR ${key.sortExpr} IS NULL)`;
    };

    const parts: string[] = [];
    const ties: string[] = [];
    for (let i = 0; i < args.keys.length; i++) {
        const strict = strictOf(i);
        if (strict) {
            parts.push(ties.length === 0 ? strict : `(${ties.join(' AND ')} AND ${strict})`);
        }
        ties.push(tieOf(i));
    }
    parts.push(`(${ties.join(' AND ')} AND ${args.entityIdCol} ${idOp} $${idIdx}::uuid)`);
    return ` ${args.connective} (${parts.join(' OR ')})`;
}

/**
 * Throw when a token's sort-value count does not match the query's sort keys.
 * Legacy `{v, id}` tokens count as one value.
 */
export function assertSortedCursorWidth(
    cursor: { v: string | null; id: string; vs?: (string | null)[] },
    expected: number,
    what: string,
): (string | null)[] {
    const values = sortedCursorValues(cursor);
    if (values.length !== expected) {
        throw new Error(
            `sortedCursor() token encodes ${values.length} sort value(s) but the query has ${expected} ${what}. ` +
            'Encode every sort key in order: Query.encodeSortedCursor([k1, k2, ...], entityId).'
        );
    }
    return values;
}

export function componentSortValueExpr(
    alias: string,
    component: string,
    property: string,
): { expr: string; valueCast: '::text' | '::numeric' } {
    const safeProperty = assertIdentifier(property, 'sortOrder.property');
    if (isNumericProperty(component, property)) {
        return { expr: `(${alias}.data->>'${safeProperty}')::numeric`, valueCast: '::numeric' };
    }
    return { expr: `${alias}.data->>'${safeProperty}'`, valueCast: '::text' };
}

/** Flip sort + tiebreak when fetching a 'before' page so Query can reverse rows. */
export function cursorSortPresentation(
    direction: 'ASC' | 'DESC',
    nullsFirst: boolean,
    isBefore: boolean,
): { direction: 'ASC' | 'DESC'; nullsFirst: boolean; nullsClause: string; idDirection: 'ASC' | 'DESC' } {
    const dir = isBefore ? (direction === 'DESC' ? 'ASC' : 'DESC') : direction;
    const nf = isBefore ? !nullsFirst : nullsFirst;
    return {
        direction: dir,
        nullsFirst: nf,
        nullsClause: nf ? 'NULLS FIRST' : 'NULLS LAST',
        idDirection: isBefore ? 'DESC' : 'ASC',
    };
}


export class ComponentInclusionNode extends QueryNode {
    private getComponentTableName(compId: string): string {
        if (shouldUseDirectPartition()) {
            return ComponentRegistry.getPartitionTableName(compId) || 'components';
        }
        return 'components';
    }

    /**
     * Whether the sort-driven / leaf-driven scan applies. Must be pure
     * (no param side effects) — QueryDAG consults it to skip CTE planning
     * and execute() consults it before building any SQL.
     *
     * Eligible shape: one or more sort orders, each on a required component,
     * no findById, no plain entity-id cursor, no OR. Filters on any component
     * are supported (applied inline on the driving/joined sort tables, or via
     * EXISTS). Multi-key emits `ORDER BY expr1, expr2, …, entity_id LIMIT n`
     * from the first sort component's table.
     */
    public static canUseSortDrivenScan(context: QueryContext): boolean {
        if (context.sortOrders.length < 1) return false;
        if (context.componentIds.size < 1) return false;
        if (context.withId) return false;
        if (context.cursorId !== null) return false;
        if (context.hasOrQuery) return false;
        for (const sort of context.sortOrders) {
            const sortTypeId = ComponentRegistry.getComponentId(sort.component);
            if (!sortTypeId || !context.componentIds.has(sortTypeId)) return false;
        }
        return true;
    }


    /**
     * Build a filter condition against `<alias>.data`. Shared implementation
     * lives in FilterBuilder so INTERSECT/CTE pushdown and EXISTS coalesce
     * emit the same SQL (RP-03).
     */
    private buildFilterCondition(
        filter: { field: string; operator: string; value: any },
        alias: string,
        context: QueryContext
    ): string {
        return buildComponentFilterCondition(filter as any, alias, context);
    }

    /**
     * Membership (+ optional field filters) branch for INTERSECT. Non-legacy
     * sources can push field filters into the branch because membership rows
     * carry `data`. Legacy entity_components has no data column.
     */
    private buildMembershipIntersectBranch(
        compId: string,
        context: QueryContext,
        componentParamIndices: Map<string, number>
    ): string {
        const source = getMembershipSource();
        let table = getMembershipTable();
        let canPushFilters = !source.isLegacy;
        if (!source.isLegacy && shouldUseDirectPartition()) {
            const partition = ComponentRegistry.getPartitionTableName(compId);
            if (partition) table = partition;
        }

        if (!componentParamIndices.has(compId)) {
            componentParamIndices.set(compId, context.addParam(compId));
        }
        const typeParam = componentParamIndices.get(compId)!;
        let branch =
            `SELECT ec.entity_id FROM ${table} ec WHERE ec.type_id = $${typeParam}::text AND ec.deleted_at IS NULL`;

        if (canPushFilters) {
            const filters = context.componentFilters.get(compId) ?? [];
            const group = buildComponentFilterGroup(filters, 'ec', context);
            if (group) {
                branch += ` AND ${group}`;
                context.filtersAppliedInMembership = true;
            }
        }
        return branch;
    }

    /**
     * Sort-driven scan for multi-component sorted queries.
     *
     * The previous shape (INTERSECT/CTE base set + correlated scalar
     * subquery ORDER BY) forces PostgreSQL to materialize EVERY matching
     * entity, run one correlated lookup per row for the sort key, sort the
     * whole set, then apply LIMIT. This shape instead drives the scan from
     * the sort component's table so the planner can walk the functional
     * index on the sort expression and stop after LIMIT rows, probing the
     * other component requirements with cheap EXISTS lookups per visited
     * row:
     *
     *   SELECT s.entity_id AS id FROM <sort component table> s
     *   WHERE s.type_id = $1 AND s.deleted_at IS NULL
     *     AND <filters on sort component (inline on s)>
     *     AND EXISTS (... other required component ...)   -- per component
     *     AND EXISTS (... other component filter ...)     -- per filter
     *   ORDER BY (s.data->>'prop')::numeric ASC NULLS LAST
     *   LIMIT $n OFFSET $m
     *
     * The form leaves the planner free to fall back to filter-first +
     * sort when the predicate is highly selective — unlike the correlated
     * subquery ORDER BY, which can never use an index for ordering.
     */
    /**
     * Build a composite keyset WHERE clause for a single-sort-key component query.
     * Returns an empty string when no composite cursor is set.
     *
     * The ORDER BY shape is `sort_expr <dir> NULLS <x>, entity_id ASC` (Fix #1).
     * For `cursorDirection='after'`:
     *   - ASC sort: (sort_expr, entity_id) > ($v, $id)   → row comparison works
     *   - DESC sort: sort_expr < $v OR (sort_expr = $v AND entity_id > $id)
     * For `cursorDirection='before'` (reverse — rarely used): opposite operators.
     *
     * Null sort values: placed last by default (NULLS LAST). A NULL cursor value
     * means "after all NULL-sorted rows" — we exclude them entirely (`IS NOT NULL`).
     */
    private buildCompositeCursorWhere(
        context: QueryContext,
        sortExpr: string,
        isNumeric: boolean,
        entityIdCol: string,
        connective: 'WHERE' | 'AND'
    ): string {
        if (!context.compositeCursor) return '';
        if (context.sortOrders.length !== 1) {
            throw new Error(
                'sortedCursor() requires exactly one sort key on a component sortBy(). ' +
                'Multi-key component sort cursors are not supported.'
            );
        }
        const sortOrder = context.sortOrders[0]!;
        const presented = cursorSortPresentation(
            sortOrder.direction,
            !!sortOrder.nullsFirst,
            context.cursorDirection === 'before',
        );

        return buildKeysetCursorWhere({
            sortExpr,
            entityIdCol,
            connective,
            direction: presented.direction,
            nullsFirst: presented.nullsFirst,
            valueCast: isNumeric ? '::numeric' : '::text',
            cursor: context.compositeCursor,
            addParam: (value) => context.addParam(value),
            idDirection: presented.idDirection,
        });


    }

    /**
     * Multi-key sort-driven scan. Drives from the first sort component and
     * joins any later sort components so ORDER BY can be
     * `expr1, expr2, …, entity_id` with LIMIT pushed to the scan.
     */
    private applySortDrivenScanMulti(context: QueryContext): string {
        const drive = context.sortOrders[0]!;
        const driveTypeId = ComponentRegistry.getComponentId(drive.component)!;
        const aliasByType = new Map<string, string>();
        aliasByType.set(driveTypeId, 's');

        const joins: string[] = [];
        let extra = 0;
        const legacy = getMembershipSource().isLegacy;
        for (let i = 1; i < context.sortOrders.length; i++) {
            const sort = context.sortOrders[i]!;
            const typeId = ComponentRegistry.getComponentId(sort.component)!;
            if (aliasByType.has(typeId)) continue;
            extra += 1;
            const alias = `sk${extra}`;
            aliasByType.set(typeId, alias);
            const table = this.getComponentTableName(typeId);
            const direct = shouldUseDirectPartition() && table !== 'components';
            const typePh = `$${context.addParam(typeId)}::text`;
            if (direct || !legacy) {
                joins.push(
                    `JOIN ${table} ${alias} ON ${alias}.entity_id = s.entity_id AND ${alias}.type_id = ${typePh} AND ${alias}.deleted_at IS NULL`
                );
            } else {
                joins.push(
                    `JOIN entity_components ec_${alias} ON ec_${alias}.entity_id = s.entity_id AND ec_${alias}.type_id = ${typePh} AND ec_${alias}.deleted_at IS NULL ` +
                    `JOIN ${table} ${alias} ON ${alias}.id = ec_${alias}.component_id AND ${alias}.deleted_at IS NULL`
                );
            }
        }

        const keyMeta = context.sortOrders.map((sort) => {
            const typeId = ComponentRegistry.getComponentId(sort.component)!;
            const alias = aliasByType.get(typeId)!;
            const built = componentSortValueExpr(alias, sort.component, sort.property);
            return { sort, expr: built.expr, valueCast: built.valueCast };
        });

        const conditions: string[] = [];
        for (const [typeId, alias] of aliasByType) {
            const filters = context.componentFilters.get(typeId) ?? [];
            const group = buildComponentFilterGroup(filters, alias, context);
            if (group) conditions.push(group);
        }

        for (const compId of context.componentIds) {
            if (aliasByType.has(compId)) continue;
            const filters = context.componentFilters.get(compId) ?? [];
            const filterGroup = buildComponentFilterGroup(filters, 'cf', context);
            if (filterGroup) {
                const compTable = this.getComponentTableName(compId);
                const filterDirect = shouldUseDirectPartition() && compTable !== 'components';
                if (filterDirect || !legacy) {
                    conditions.push(`EXISTS (
                        SELECT 1 FROM ${compTable} cf
                        WHERE cf.entity_id = s.entity_id
                        AND cf.type_id = $${context.addParam(compId)}::text
                        AND ${filterGroup}
                        AND cf.deleted_at IS NULL
                    )`);
                } else {
                    conditions.push(`EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN ${compTable} cf ON ec_f.component_id = cf.id
                        WHERE ec_f.entity_id = s.entity_id
                        AND ec_f.type_id = $${context.addParam(compId)}::text
                        AND ${filterGroup}
                        AND ec_f.deleted_at IS NULL
                        AND cf.deleted_at IS NULL
                    )`);
                }
            } else {
                conditions.push(`EXISTS (
                    SELECT 1 FROM ${getMembershipTable()} ec_r
                    WHERE ec_r.entity_id = s.entity_id
                    AND ec_r.type_id = $${context.addParam(compId)}::text
                    AND ec_r.deleted_at IS NULL
                )`);
            }
        }

        if (context.excludedComponentIds.size > 0) {
            const excludedPlaceholders = Array.from(context.excludedComponentIds)
                .map((id) => `$${context.addParam(id)}`).join(', ');
            conditions.push(`NOT EXISTS (
                SELECT 1 FROM ${getMembershipTable()} ec_ex
                WHERE ec_ex.entity_id = s.entity_id
                AND ec_ex.type_id IN (${excludedPlaceholders})
                AND ec_ex.deleted_at IS NULL
            )`);
        }
        if (context.excludedEntityIds.size > 0) {
            const entityPlaceholders = Array.from(context.excludedEntityIds)
                .map((id) => `$${context.addParam(id)}`).join(', ');
            conditions.push(`s.entity_id NOT IN (${entityPlaceholders})`);
        }

        const isBefore = context.compositeCursor !== null && context.cursorDirection === 'before';
        let cursorWhere = '';
        if (context.compositeCursor) {
            const values = assertSortedCursorWidth(context.compositeCursor, context.sortOrders.length, 'sortBy() key(s)');
            cursorWhere = buildKeysetCursorWhere({
                keys: keyMeta.map((meta, i) => {
                    const presented = cursorSortPresentation(meta.sort.direction, !!meta.sort.nullsFirst, isBefore);
                    return {
                        sortExpr: meta.expr,
                        direction: presented.direction,
                        nullsFirst: presented.nullsFirst,
                        valueCast: meta.valueCast,
                        value: values[i]!,
                    };
                }),
                entityIdCol: 's.entity_id',
                connective: 'AND',
                cursorId: context.compositeCursor.id,
                idDirection: isBefore ? 'DESC' : 'ASC',
                addParam: (value) => context.addParam(value),
            });
        }

        const orderParts = keyMeta.map((meta) => {
            const presented = cursorSortPresentation(meta.sort.direction, !!meta.sort.nullsFirst, isBefore);
            return `${meta.expr} ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}`;
        });
        const idDir = isBefore ? 'DESC' : 'ASC';
        const extraConditions = conditions.length > 0 ? `\n                AND ${conditions.join('\n                AND ')}` : '';
        const joinSql = joins.length > 0 ? `\n                ${joins.join('\n                ')}` : '';

        const sortTable = this.getComponentTableName(driveTypeId);
        const driveDirect = shouldUseDirectPartition() && sortTable !== 'components';
        let sql: string;
        if (driveDirect || !legacy) {
            sql = `SELECT s.entity_id as id FROM ${sortTable} s${joinSql}
                WHERE s.type_id = $${context.addParam(driveTypeId)}::text
                AND s.deleted_at IS NULL${extraConditions}${cursorWhere}
                ORDER BY ${orderParts.join(', ')}, s.entity_id ${idDir}`;
        } else {
            sql = `SELECT s.entity_id as id FROM entity_components ec
                JOIN ${sortTable} s ON s.id = ec.component_id AND s.deleted_at IS NULL${joinSql}
                WHERE ec.type_id = $${context.addParam(driveTypeId)}::text
                AND ec.deleted_at IS NULL${extraConditions}${cursorWhere}
                ORDER BY ${orderParts.join(', ')}, s.entity_id ${idDir}`;
        }

        if (context.limit !== null) {
            sql += ` LIMIT $${context.addParam(context.limit)}`;
        }
        if (!context.compositeCursor && context.offsetValue > 0) {
            sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
        }
        return sql;
    }

    private applySortDrivenScan(context: QueryContext): string | null {
        if (!ComponentInclusionNode.canUseSortDrivenScan(context)) return null;
        if (context.sortOrders.length > 1) return this.applySortDrivenScanMulti(context);

        const sortOrder = context.sortOrders[0]!;
        const sortTypeId = ComponentRegistry.getComponentId(sortOrder.component)!;
        const componentIds = Array.from(context.componentIds);
        const otherComponentIds = componentIds.filter(id => id !== sortTypeId);

        const safeProperty = assertIdentifier(sortOrder.property, 'sortOrder.property');
        const isNumeric = isNumericProperty(sortOrder.component, sortOrder.property);
        const sortExpr = isNumeric
            ? `(s.data->>'${safeProperty}')::numeric`
            : `s.data->>'${safeProperty}'`;
        const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';

        const sortTable = this.getComponentTableName(sortTypeId);
        const driveDirect = shouldUseDirectPartition() && sortTable !== 'components';

        const conditions: string[] = [];

        // Filters on the sort component apply inline on the driving table.
        // Do NOT restate the partial numeric-index predicate for ORDER BY alone:
        // that would filter out NULL sort keys (breaks NULLS LAST / keyset).
        // Numeric *filters* restate it via buildComponentFilterGroup (RP-04).
        const sortFilters = context.componentFilters.get(sortTypeId) ?? [];
        const sortFilterGroup = buildComponentFilterGroup(sortFilters, 's', context);
        if (sortFilterGroup) {
            conditions.push(sortFilterGroup);
        }

        // Other required components: one probe each.
        // When field filters exist on that component, a single filter-EXISTS
        // also proves membership (UNIQUE(entity_id, type_id)) — skip the
        // separate presence-EXISTS (RP-03 / BUG-2 + fast-path dedupe).
        for (const compId of otherComponentIds) {
            const filters = context.componentFilters.get(compId) ?? [];
            const filterGroup = buildComponentFilterGroup(filters, 'cf', context);

            if (filterGroup) {
                const compTable = this.getComponentTableName(compId);
                const filterDirect = shouldUseDirectPartition() && compTable !== 'components';
                if (filterDirect || !getMembershipSource().isLegacy) {
                    conditions.push(`EXISTS (
                        SELECT 1 FROM ${compTable} cf
                        WHERE cf.entity_id = s.entity_id
                        AND cf.type_id = $${context.addParam(compId)}::text
                        AND ${filterGroup}
                        AND cf.deleted_at IS NULL
                    )`);
                } else {
                    conditions.push(`EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN ${compTable} cf ON ec_f.component_id = cf.id
                        WHERE ec_f.entity_id = s.entity_id
                        AND ec_f.type_id = $${context.addParam(compId)}::text
                        AND ${filterGroup}
                        AND ec_f.deleted_at IS NULL
                        AND cf.deleted_at IS NULL
                    )`);
                }
            } else {
                // Presence-only probe (no field filters on this component).
                conditions.push(`EXISTS (
                    SELECT 1 FROM ${getMembershipTable()} ec_r
                    WHERE ec_r.entity_id = s.entity_id
                    AND ec_r.type_id = $${context.addParam(compId)}::text
                    AND ec_r.deleted_at IS NULL
                )`);
            }
        }

        // Excluded components / entities.
        if (context.excludedComponentIds.size > 0) {
            const excludedPlaceholders = Array.from(context.excludedComponentIds)
                .map((id) => `$${context.addParam(id)}`).join(', ');
            conditions.push(`NOT EXISTS (
                SELECT 1 FROM ${getMembershipTable()} ec_ex
                WHERE ec_ex.entity_id = s.entity_id
                AND ec_ex.type_id IN (${excludedPlaceholders})
                AND ec_ex.deleted_at IS NULL
            )`);
        }
        if (context.excludedEntityIds.size > 0) {
            const entityPlaceholders = Array.from(context.excludedEntityIds)
                .map((id) => `$${context.addParam(id)}`).join(', ');
            conditions.push(`s.entity_id NOT IN (${entityPlaceholders})`);
        }

        const extraConditions = conditions.length > 0 ? `\n                AND ${conditions.join('\n                AND ')}` : '';

        // Composite keyset predicate (AND because WHERE already has type_id check).
        const cursorWhere = this.buildCompositeCursorWhere(context, sortExpr, isNumeric, 's.entity_id', 'AND');

        const presented = cursorSortPresentation(
            sortOrder.direction,
            !!sortOrder.nullsFirst,
            context.compositeCursor !== null && context.cursorDirection === 'before',
        );
        let sql: string;
        if (driveDirect || !getMembershipSource().isLegacy) {
            sql = `SELECT s.entity_id as id FROM ${sortTable} s
                WHERE s.type_id = $${context.addParam(sortTypeId)}::text
                AND s.deleted_at IS NULL${extraConditions}${cursorWhere}
                ORDER BY ${sortExpr} ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, s.entity_id ${presented.idDirection}`;
        } else {
            sql = `SELECT s.entity_id as id FROM entity_components ec
                JOIN ${sortTable} s ON s.id = ec.component_id AND s.deleted_at IS NULL
                WHERE ec.type_id = $${context.addParam(sortTypeId)}::text
                AND ec.deleted_at IS NULL${extraConditions}${cursorWhere}
                ORDER BY ${sortExpr} ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, s.entity_id ${presented.idDirection}`;
        }

        if (context.limit !== null) {
            sql += ` LIMIT $${context.addParam(context.limit)}`;
        }
        // OFFSET is not used alongside composite cursor pagination.
        if (!context.compositeCursor && context.offsetValue > 0) {
            sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
        }

        return sql;
    }

    public execute(context: QueryContext): QueryResult {
        const componentIds = Array.from(context.componentIds);
        const excludedIds = Array.from(context.excludedComponentIds);

        if (componentIds.length === 0) {
            // No components required, return the input as-is
            return {
                sql: "",
                params: context.params,
                context
            };
        }

        let sql = "";
        const componentCount = componentIds.length;

        // Check if CTE is available and use it to avoid redundant entity_components scans
        const useCTE = Boolean(context.hasCTE && context.cteName);

        // LATERAL joins don't work correctly with INTERSECT queries (non-CTE multi-component)
        // because the SQL insertion logic places joins inside the INTERSECT subqueries
        const isIntersectQuery = componentCount > 1 && !useCTE;
        const useLateralJoins = Boolean(shouldUseLateralJoins()) && !isIntersectQuery;

        // Collect LATERAL join fragments if using LATERAL joins
        const lateralJoins: string[] = [];
        const lateralConditions: string[] = [];

        // Check if we need custom sorting (sortOrders specified)
        const hasSortOrders = context.sortOrders.length > 0;

        // Multi-component sorted queries: drive the scan from the sort
        // component so the planner can use the sort-expression index and
        // stop at LIMIT, instead of materializing the full INTERSECT set and
        // sorting it via correlated subqueries. Checked before any params
        // are added so a null fallback leaves the context clean.
        if (!useCTE && hasSortOrders && ComponentInclusionNode.canUseSortDrivenScan(context)) {
            const sortDriven = this.applySortDrivenScan(context);
            if (sortDriven) {
                return { sql: sortDriven, params: context.params, context };
            }
        }

        if (componentCount === 1) {
            // Single component case
            const componentId = componentIds[0]!;

            // Check if we can use single-pass optimization (filter + sort on same component)
            // This must be checked BEFORE adding any params to avoid orphan params
            const canUseSinglePass = hasSortOrders &&
                context.sortOrders.length === 1 &&
                context.componentFilters.size > 0 &&
                !context.withId &&
                excludedIds.length === 0 &&
                context.excludedEntityIds.size === 0 &&
                !useCTE;

            if (canUseSinglePass) {
                const singlePass = this.applySinglePassFilterSort(context);
                if (singlePass) {
                    // Single-pass handles filters, sort, and pagination all in one query
                    return { sql: singlePass, params: context.params, context };
                }
            }

            if (useCTE) {
                // CTE already selected this type (and pushed filters when it could).
                // UNIQUE(entity_id, type_id) — no DISTINCT, no membership re-probe.
                sql = `SELECT ${context.cteName}.entity_id as id FROM ${context.cteName}`;
            } else {
                // Prefer partition leaf when available (better pruning + filter indexes).
                let singleTable = getMembershipTable();
                if (!getMembershipSource().isLegacy && shouldUseDirectPartition()) {
                    singleTable = this.getComponentTableName(componentId) || singleTable;
                }
                sql = `SELECT ec.entity_id as id FROM ${singleTable} ec WHERE ec.type_id = $${context.addParam(componentId)}::text AND ec.deleted_at IS NULL`;
                // Push field filters into the membership scan when `data` is available
                // (non-legacy) — avoids a separate EXISTS re-scan (RP-03).
                if (!getMembershipSource().isLegacy) {
                    const filters = context.componentFilters.get(componentId) ?? [];
                    const group = buildComponentFilterGroup(filters, 'ec', context);
                    if (group) {
                        sql += ` AND ${group}`;
                        context.filtersAppliedInMembership = true;
                    }
                }
            }

            if (context.withId) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                sql += ` ${whereKeyword} ${tableAlias}.entity_id = $${context.addParam(context.withId)}`;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} NOT EXISTS (
                    SELECT 1 FROM ${getMembershipTable()} ec_ex
                    WHERE ec_ex.entity_id = ${tableAlias}.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const tableAlias = useCTE ? context.cteName : "ec";
                const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} ${tableAlias}.entity_id NOT IN (${entityPlaceholders})`;
            }

            // Apply component filters for single component (normal path).
            // Skipped when already pushed into the membership scan above.
            const singleCompHasWhere = sql.includes(' WHERE ');
            sql = this.applyComponentFilters(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, new Map(), useCTE ? context.cteName : "ec", singleCompHasWhere);

            // Apply sorting with component data joins if sortOrders are specified
            if (hasSortOrders) {
                sql = this.applySortingWithComponentJoins(sql, context);
            } else {
                // Default: order by entity_id
                const tableAlias = useCTE ? context.cteName : "ec";
                const idColumn = useCTE ? `${context.cteName}.entity_id` : `${tableAlias}.entity_id`;

                // Apply cursor-based pagination if cursor is set (more efficient than OFFSET)
                if (context.cursorId !== null && !context.paginationAppliedInCTE) {
                    const operator = context.cursorDirection === 'after' ? '>' : '<';
                    const whereKeyword = sql.includes('WHERE') ? 'AND' : 'WHERE';
                    sql += ` ${whereKeyword} ${idColumn} ${operator} $${context.addParam(context.cursorId)}`;
                }

                // Order direction depends on cursor direction
                const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
                sql += ` ORDER BY ${idColumn} ${orderDirection}`;

                // Add LIMIT and OFFSET only if not already applied in CTE
                // When pagination is applied at CTE level, skip it here to avoid double pagination
                if (!context.paginationAppliedInCTE) {
                    if (context.limit !== null) {
                        sql += ` LIMIT $${context.addParam(context.limit)}`;
                    }
                    // Only add OFFSET when not using cursor-based pagination
                    if (context.cursorId === null && context.offsetValue > 0) {
                        sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
                    }
                }
            }
        } else {
            // Multiple components case
            // Create parameter indices for component IDs to avoid duplicates
            const componentParamIndices: Map<string, number> = new Map();

            if (useCTE) {
                // CTE already INTERSECTed every required component (filters pushed
                // when the membership row carries data). Select the id set directly.
                sql = `SELECT ${context.cteName}.entity_id as id FROM ${context.cteName}`;
            } else {
                // Use INTERSECT for multi-component queries (much faster than GROUP BY + HAVING).
                // Field filters are pushed into each branch when membership rows
                // carry `data` (non-legacy) so INTERSECT inputs are selective (RP-03).
                const intersectQueries = componentIds.map((compId) =>
                    this.buildMembershipIntersectBranch(compId, context, componentParamIndices)
                );
                sql = `SELECT intersected.entity_id as id FROM (${intersectQueries.join(' INTERSECT ')}) AS intersected`;
            }

            // For INTERSECT queries, the alias is 'intersected', not 'ec'
            const multiCompAlias = useCTE ? context.cteName : "intersected";

            // Track if outer query has WHERE clause (don't count WHERE inside INTERSECT subqueries)
            // For INTERSECT queries, the outer query starts without WHERE
            let outerHasWhere = useCTE && sql.indexOf('WHERE', sql.lastIndexOf('FROM')) > -1;

            if (context.withId) {
                const whereKeyword = outerHasWhere ? 'AND' : 'WHERE';
                sql += ` ${whereKeyword} ${multiCompAlias}.entity_id = $${context.addParam(context.withId)}`;
                outerHasWhere = true;
            }

            // Add exclusions
            if (excludedIds.length > 0) {
                const whereKeyword = outerHasWhere ? 'AND' : 'WHERE';
                const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} NOT EXISTS (
                    SELECT 1 FROM ${getMembershipTable()} ec_ex
                    WHERE ec_ex.entity_id = ${multiCompAlias}.entity_id
                    AND ec_ex.type_id IN (${excludedPlaceholders})
                    AND ec_ex.deleted_at IS NULL
                )`;
                outerHasWhere = true;
            }

            // Add entity exclusions
            if (context.excludedEntityIds.size > 0) {
                const whereKeyword = outerHasWhere ? 'AND' : 'WHERE';
                const entityExcludedIds = Array.from(context.excludedEntityIds);
                const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
                sql += ` ${whereKeyword} ${multiCompAlias}.entity_id NOT IN (${entityPlaceholders})`;
                outerHasWhere = true;
            }

            // Apply component filters for multiple components
            // For INTERSECT queries, alias is 'intersected'; for CTE, use cteName
            // Pass outerHasWhere to correctly track WHERE clause in outer query (not in INTERSECT subqueries)
            const filterResult = this.applyComponentFiltersWithState(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, componentParamIndices, multiCompAlias, outerHasWhere);
            sql = filterResult.sql;
            outerHasWhere = filterResult.hasWhere;

            // Note: GROUP BY HAVING removed - INTERSECT already ensures all components are present

            // Apply sorting with component data joins if sortOrders are specified
            if (hasSortOrders) {
                sql = this.applySortingWithComponentJoins(sql, context);
            } else {
                // Default: order by entity_id
                // For INTERSECT queries, use 'intersected' alias; for CTE, use cteName
                const idColumn = `${multiCompAlias}.entity_id`;

                // Apply cursor-based pagination if cursor is set (more efficient than OFFSET)
                if (context.cursorId !== null && !context.paginationAppliedInCTE) {
                    const operator = context.cursorDirection === 'after' ? '>' : '<';
                    // Use tracked WHERE state for INTERSECT queries
                    const whereKeyword = outerHasWhere ? 'AND' : 'WHERE';
                    sql += ` ${whereKeyword} ${idColumn} ${operator} $${context.addParam(context.cursorId)}`;
                    outerHasWhere = true;
                }

                // Order direction depends on cursor direction
                const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
                sql += ` ORDER BY ${idColumn} ${orderDirection}`;

                // Add LIMIT and OFFSET only if not already applied in CTE
                // When pagination is applied at CTE level, skip it here to avoid double pagination
                if (!context.paginationAppliedInCTE) {
                    if (context.limit !== null) {
                        sql += ` LIMIT $${context.addParam(context.limit)}`;
                    }
                    // Only add OFFSET when not using cursor-based pagination
                    if (context.cursorId === null && context.offsetValue > 0) {
                        sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
                    }
                }
            }
        }

        return {
            sql,
            params: context.params,
            context
        };
    }

    /**
     * Wrap the base query with sorting joins and apply ORDER BY, LIMIT, OFFSET
     * This ensures that sorting and pagination work together correctly
     */
    private applySortingWithComponentJoins(baseQuery: string, context: QueryContext): string {

        // Check if we can use the optimized direct partition sort
        if (shouldUseDirectPartition() && context.sortOrders.length === 1) {
            const optimized = this.applySortingOptimized(baseQuery, context);
            if (optimized) return optimized;
        }

        // Try single-pass optimization when filters and sort are on the same component
        if (context.sortOrders.length === 1) {
            const singlePass = this.applySinglePassFilterSort(context);
            if (singlePass) return singlePass;
        }

        // Use scalar subquery approach for sorting to avoid cartesian product explosion
        // This forces PostgreSQL to evaluate the sort expression for each entity row,
        // rather than joining all component rows first and filtering later.
        // This is dramatically faster when base_entities is a small subset of total entities.
        const orderByClauses: string[] = [];
        const sortValueExprs: string[] = [];
        const sortValueCasts: Array<'::text' | '::numeric'> = [];

        for (let i = 0; i < context.sortOrders.length; i++) {
            const sortOrder = context.sortOrders[i]!;

            // Get the component type ID for this sort order
            const typeId = ComponentRegistry.getComponentId(sortOrder.component);
            if (!typeId) {
                continue; // Skip if component not registered
            }

            const sortComponentTableName = this.getComponentTableName(typeId);
            const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
            const isNumeric = isNumericProperty(sortOrder.component, sortOrder.property);
            // Validate property name before interpolating into JSON path.
            // Without this, a malicious or malformed sortOrder.property could
            // inject SQL through the template (C08).
            const safeProperty = assertIdentifier(sortOrder.property, 'sortOrder.property');

            // Build scalar subquery to get sort value for each entity
            // This avoids nested loop join by forcing row-by-row evaluation
            const sortExpr = isNumeric
                ? `(sort_c.data->>'${safeProperty}')::numeric`
                : `sort_c.data->>'${safeProperty}'`;

            const subquery = getMembershipSource().isLegacy
                ? `(
                SELECT ${sortExpr}
                FROM entity_components sort_ec
                JOIN ${sortComponentTableName} sort_c ON sort_c.id = sort_ec.component_id
                WHERE sort_ec.entity_id = base_entities.id
                AND sort_ec.type_id = $${context.addParam(typeId)}::text
                AND sort_ec.deleted_at IS NULL
                AND sort_c.deleted_at IS NULL
                LIMIT 1
            )`
                : `(
                SELECT ${sortExpr}
                FROM ${sortComponentTableName} sort_c
                WHERE sort_c.entity_id = base_entities.id
                AND sort_c.type_id = $${context.addParam(typeId)}::text
                AND sort_c.deleted_at IS NULL
                LIMIT 1
            )`;

            sortValueExprs.push(subquery);
            sortValueCasts.push(isNumeric ? '::numeric' : '::text');
            orderByClauses.push(`${subquery} ${normalizeSortDirection(sortOrder.direction)} ${nullsClause}`);
        }

        if (context.compositeCursor && orderByClauses.length === 1 && context.sortOrders.length === 1) {
            // Composite keyset on single sort key via CTE: materialize sort value,
            // filter by keyset predicate, then apply LIMIT.
            const sortOrder = context.sortOrders[0]!;
            const isNumericSv = isNumericProperty(sortOrder.component, sortOrder.property);
            const presented = cursorSortPresentation(
                sortOrder.direction,
                !!sortOrder.nullsFirst,
                context.cursorDirection === 'before',
            );
            const svExpr = orderByClauses[0]!.replace(/ (ASC|DESC) NULLS (FIRST|LAST)$/, '');

            const cursorWhere = buildKeysetCursorWhere({
                sortExpr: '_sorted._sv',
                entityIdCol: '_sorted.id',
                connective: 'WHERE',
                direction: presented.direction,
                nullsFirst: presented.nullsFirst,
                valueCast: isNumericSv ? '::numeric' : '::text',
                cursor: context.compositeCursor,
                addParam: (value) => context.addParam(value),
                idDirection: presented.idDirection,
            });

            let sql = `WITH _sorted AS (
                SELECT base_entities.id, ${svExpr} AS _sv
                FROM (${baseQuery}) AS base_entities
            )
            SELECT _sorted.id FROM _sorted${cursorWhere}
            ORDER BY _sorted._sv ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, _sorted.id ${presented.idDirection}`;


            if (!context.paginationAppliedInCTE && context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            return sql;
        }

        if (context.compositeCursor && context.sortOrders.length > 1) {
            if (sortValueExprs.length !== context.sortOrders.length) {
                throw new Error('sortedCursor() could not resolve every sortBy() key.');
            }
            const values = assertSortedCursorWidth(context.compositeCursor, context.sortOrders.length, 'sortBy() key(s)');
            const isBefore = context.cursorDirection === 'before';
            const presented = context.sortOrders.map((sortOrder) =>
                cursorSortPresentation(sortOrder.direction, !!sortOrder.nullsFirst, isBefore)
            );
            const selects = sortValueExprs.map((expr, i) => `${expr} AS _sv${i}`).join(', ');
            const cursorWhere = buildKeysetCursorWhere({
                keys: sortValueExprs.map((_, i) => ({
                    sortExpr: `_sorted._sv${i}`,
                    direction: presented[i]!.direction,
                    nullsFirst: presented[i]!.nullsFirst,
                    valueCast: sortValueCasts[i]!,
                    value: values[i]!,
                })),
                entityIdCol: '_sorted.id',
                connective: 'WHERE',
                cursorId: context.compositeCursor.id,
                idDirection: presented[0]!.idDirection,
                addParam: (value) => context.addParam(value),
            });
            const order = presented.map((p, i) =>
                `_sorted._sv${i} ${normalizeSortDirection(p.direction)} ${p.nullsClause}`
            ).join(', ');
            let sql = `WITH _sorted AS (
                SELECT base_entities.id, ${selects}
                FROM (${baseQuery}) AS base_entities
            )
            SELECT _sorted.id FROM _sorted${cursorWhere}
            ORDER BY ${order}, _sorted.id ${presented[0]!.idDirection}`;
            if (!context.paginationAppliedInCTE && context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            return sql;
        }

        // Wrap the base query as a subquery to get entity ids
        let sql = `SELECT base_entities.id FROM (${baseQuery}) AS base_entities`;

        // Add ORDER BY clause
        if (orderByClauses.length > 0) {
            sql += ` ORDER BY ${orderByClauses.join(', ')}, base_entities.id ASC`;
        } else {
            // Fallback to entity id if no valid sort orders
            sql += ` ORDER BY base_entities.id`;
        }

        // Add LIMIT and OFFSET only if not already applied in CTE
        // When pagination is applied at CTE level, skip it here to avoid double pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Only add OFFSET when not using cursor-based pagination
            if (!context.compositeCursor && context.cursorId === null && context.offsetValue > 0) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
    }

    /**
     * Single-pass optimization when all filters and sort are on the same component.
     * Instead of: CTE -> EXISTS filters -> subquery -> JOIN for sort -> LIMIT
     * We do: JOIN once -> filter + sort in same query -> LIMIT
     *
     * This is dramatically faster because PostgreSQL can use indexes to find
     * the top N matching rows directly instead of finding ALL matches first.
     *
     * NOTE: This optimization cannot be used when multiple component types are required,
     * because it only queries one component table and would miss the join requirement.
     */
    private applySinglePassFilterSort(context: QueryContext): string | null {
        if (context.sortOrders.length !== 1) return null;

        // Can't use single-pass when multiple components are required
        // (we need to ensure entities have ALL required components)
        if (context.componentIds.size > 1) return null;

        const sortOrder = context.sortOrders[0]!;
        const sortTypeId = ComponentRegistry.getComponentId(sortOrder.component);
        if (!sortTypeId) return null;

        // Check if all filters are on the same component as the sort
        const filterComponentIds = Array.from(context.componentFilters.keys());
        if (filterComponentIds.length === 0) return null;
        if (filterComponentIds.length > 1) return null; // Multiple components - can't optimize
        if (filterComponentIds[0] !== sortTypeId) return null; // Filter and sort on different components

        // All filters and sort are on the same component - use single-pass optimization
        const filters = context.componentFilters.get(sortTypeId) || [];
        if (filters.length === 0) return null;

        const componentTableName = this.getComponentTableName(sortTypeId);
        const useDirectPartition = shouldUseDirectPartition() && componentTableName !== 'components';

        // Shared filter emission (includes numeric partial-index restatement).
        const filterGroup = buildComponentFilterGroup(filters, 'c', context);
        if (!filterGroup) return null;

        const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
        const isNumeric = isNumericProperty(sortOrder.component, sortOrder.property);
        const safeProperty = assertIdentifier(sortOrder.property, 'sortOrder.property');
        const sortExpr = isNumeric
            ? `(c.data->>'${safeProperty}')::numeric`
            : `c.data->>'${safeProperty}'`;

        // Composite keyset predicate (AND because WHERE already has other conditions).
        // Note: do not AND partial-index validity for sort alone — NULL sort keys
        // must remain (NULLS LAST/FIRST + keyset). Filters already restate it.
        const cursorWhere = this.buildCompositeCursorWhere(context, sortExpr, isNumeric, 'c.entity_id', 'AND');

        const presented = cursorSortPresentation(
            sortOrder.direction,
            !!sortOrder.nullsFirst,
            context.compositeCursor !== null && context.cursorDirection === 'before',
        );
        let sql: string;
        if (useDirectPartition || !getMembershipSource().isLegacy) {
            sql = `SELECT c.entity_id as id FROM ${componentTableName} c
                WHERE c.type_id = $${context.addParam(sortTypeId)}::text
                AND c.deleted_at IS NULL
                AND ${filterGroup}${cursorWhere}
                ORDER BY ${sortExpr} ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, c.entity_id ${presented.idDirection}`;
        } else {
            sql = `SELECT ec.entity_id as id FROM entity_components ec
                JOIN ${componentTableName} c ON c.id = ec.component_id AND c.deleted_at IS NULL
                WHERE ec.type_id = $${context.addParam(sortTypeId)}::text
                AND ec.deleted_at IS NULL
                AND ${filterGroup}${cursorWhere}
                ORDER BY ${sortExpr} ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, c.entity_id ${presented.idDirection}`;
        }

        // Add pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // OFFSET is not used alongside composite cursor pagination.
            if (!context.compositeCursor && context.cursorId === null && context.offsetValue > 0) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
    }

    /**
     * Optimized sorting for direct partition access.
     * Uses scalar subquery to avoid cartesian product explosion when sorting.
     * Queries the partition table directly without going through entity_components.
     */
    private applySortingOptimized(baseQuery: string, context: QueryContext): string | null {
        if (context.sortOrders.length !== 1) return null;

        const sortOrder = context.sortOrders[0]!;
        const typeId = ComponentRegistry.getComponentId(sortOrder.component);
        if (!typeId) return null;

        const partitionTable = ComponentRegistry.getPartitionTableName(typeId);
        if (!partitionTable) return null;

        const nullsClause = sortOrder.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
        const isNumeric = isNumericProperty(sortOrder.component, sortOrder.property);
        const safeProperty = assertIdentifier(sortOrder.property, 'sortOrder.property');
        const sortExpr = isNumeric
            ? `(sort_c.data->>'${safeProperty}')::numeric`
            : `sort_c.data->>'${safeProperty}'`;

        // Use scalar subquery to avoid cartesian product explosion
        // This forces PostgreSQL to evaluate sort value per-entity, preventing
        // the nested loop join that scans all component rows before filtering
        const sortSubquery = `(
            SELECT ${sortExpr}
            FROM ${partitionTable} sort_c
            WHERE sort_c.entity_id = base.id
            AND sort_c.type_id = $${context.addParam(typeId)}::text
            AND sort_c.deleted_at IS NULL
            LIMIT 1
        )`;

        if (context.compositeCursor) {
            // Composite keyset via CTE: materialize sort value, filter, then paginate.
            const presented = cursorSortPresentation(
                sortOrder.direction,
                !!sortOrder.nullsFirst,
                context.cursorDirection === 'before',
            );

            const cursorWhere = buildKeysetCursorWhere({
                sortExpr: '_sorted._sv',
                entityIdCol: '_sorted.id',
                connective: 'WHERE',
                direction: presented.direction,
                nullsFirst: presented.nullsFirst,
                valueCast: isNumeric ? '::numeric' : '::text',
                cursor: context.compositeCursor,
                addParam: (value) => context.addParam(value),
                idDirection: presented.idDirection,
            });

            let sql = `WITH _sorted AS (
                SELECT base.id, ${sortSubquery} AS _sv FROM (${baseQuery}) AS base
            )
            SELECT _sorted.id FROM _sorted${cursorWhere}
            ORDER BY _sorted._sv ${normalizeSortDirection(presented.direction)} ${presented.nullsClause}, _sorted.id ${presented.idDirection}`;


            if (!context.paginationAppliedInCTE && context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            return sql;
        }

        let sql = `SELECT base.id FROM (${baseQuery}) AS base
            ORDER BY ${sortSubquery} ${normalizeSortDirection(sortOrder.direction)} ${nullsClause}, base.id ASC`;

        // Add LIMIT and OFFSET only if not already applied in CTE
        // When pagination is applied at CTE level, skip it here to avoid double pagination
        if (!context.paginationAppliedInCTE) {
            if (context.limit !== null) {
                sql += ` LIMIT $${context.addParam(context.limit)}`;
            }
            // Only add OFFSET when not using cursor-based pagination
            if (context.cursorId === null && context.offsetValue > 0) {
                sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
            }
        }

        return sql;
    }

    /**
     * Apply component filters using either EXISTS subqueries or LATERAL joins
     * Wrapper that returns just the SQL string for backward compatibility
     */
    private applyComponentFilters(
        context: QueryContext,
        componentIds: string[],
        useCTE: boolean,
        useLateralJoins: boolean,
        lateralJoins: string[],
        lateralConditions: string[],
        sql: string,
        componentParamIndices: Map<string, number>,
        entityTableAlias?: string,
        outerHasWhere: boolean = false
    ): string {
        return this.applyComponentFiltersWithState(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, componentParamIndices, entityTableAlias, outerHasWhere).sql;
    }

    /**
     * Apply component filters using either EXISTS subqueries or LATERAL joins.
     * Returns both SQL and updated WHERE state for proper tracking.
     *
     * RP-03: filters for one component are AND-coalesced into a single EXISTS
     * (or one LATERAL) instead of one subquery per filter. When membership
     * INTERSECT/CTE already applied field filters, this is a no-op.
     *
     * @param entityTableAlias - The alias for the entity table (e.g., 'ec', 'intersected', or CTE name)
     * @param outerHasWhere - Track if outer query already has WHERE clause (for INTERSECT queries)
     */
    private applyComponentFiltersWithState(
        context: QueryContext,
        componentIds: string[],
        useCTE: boolean,
        useLateralJoins: boolean,
        lateralJoins: string[],
        lateralConditions: string[],
        sql: string,
        componentParamIndices: Map<string, number>,
        entityTableAlias?: string,
        outerHasWhere: boolean = false
    ): { sql: string; hasWhere: boolean } {
        let hasOuterWhere = outerHasWhere;

        // Filters already pushed into INTERSECT/CTE membership branches.
        if (context.filtersAppliedInMembership) {
            return { sql, hasWhere: hasOuterWhere };
        }

        for (const [compId, filters] of context.componentFilters) {
            if (!filters.length) continue;

            // One predicate group per component (BUG-2 coalesce).
            const condition = buildComponentFilterGroup(filters, 'c', context);
            if (!condition) continue;

            const tableAlias = entityTableAlias || (useCTE ? context.cteName : "ec");
            const whereKeyword = hasOuterWhere ? 'AND' : 'WHERE';
            if (!componentParamIndices.has(compId)) {
                componentParamIndices.set(compId, context.addParam(compId));
            }
            const typeParam = componentParamIndices.get(compId)!;
            const componentTableName = this.getComponentTableName(compId);
            const useDirectPartition = shouldUseDirectPartition() && componentTableName !== 'components';

            if (useLateralJoins) {
                const compIdShort = compId.substring(0, 8);
                const lateralAlias = `lat_${compIdShort}_${lateralJoins.length}`;

                if (useDirectPartition || !getMembershipSource().isLegacy) {
                    lateralJoins.push(
                        `CROSS JOIN LATERAL (
                            SELECT 1 FROM ${componentTableName} c
                            WHERE c.entity_id = ${tableAlias}.entity_id
                            AND c.type_id = $${typeParam}::text
                            AND ${condition}
                            AND c.deleted_at IS NULL
                            LIMIT 1
                        ) AS ${lateralAlias}`
                    );
                } else {
                    lateralJoins.push(
                        `CROSS JOIN LATERAL (
                            SELECT 1 FROM entity_components ec_f
                            JOIN ${componentTableName} c ON ec_f.component_id = c.id
                            WHERE ec_f.entity_id = ${tableAlias}.entity_id
                            AND ec_f.type_id = $${typeParam}::text
                            AND ${condition}
                            AND ec_f.deleted_at IS NULL
                            AND c.deleted_at IS NULL
                            LIMIT 1
                        ) AS ${lateralAlias}`
                    );
                }
                lateralConditions.push(`${lateralAlias} IS NOT NULL`);
            } else if (useDirectPartition || !getMembershipSource().isLegacy) {
                sql += ` ${whereKeyword} EXISTS (
                        SELECT 1 FROM ${componentTableName} c
                        WHERE c.entity_id = ${tableAlias}.entity_id
                        AND c.type_id = $${typeParam}::text
                        AND ${condition}
                        AND c.deleted_at IS NULL
                    )`;
                hasOuterWhere = true;
            } else {
                sql += ` ${whereKeyword} EXISTS (
                        SELECT 1 FROM entity_components ec_f
                        JOIN ${componentTableName} c ON ec_f.component_id = c.id
                        WHERE ec_f.entity_id = ${tableAlias}.entity_id
                        AND ec_f.type_id = $${typeParam}::text
                        AND ${condition}
                        AND ec_f.deleted_at IS NULL
                        AND c.deleted_at IS NULL
                    )`;
                hasOuterWhere = true;
            }
        }

        // If using LATERAL joins, add them to the FROM clause and conditions to WHERE
        if (useLateralJoins && lateralJoins.length > 0) {
            // Add LATERAL conditions to WHERE clause FIRST (before inserting LATERAL joins)
            let whereClause = '';
            if (lateralConditions.length > 0) {
                const conditionsString = lateralConditions.join(' AND ');
                
                // Find ORDER BY or GROUP BY to determine WHERE insertion point
                const orderByMatch = sql.match(/\s+(ORDER\s+BY)/i);
                const groupByMatch = sql.match(/\s+(GROUP\s+BY)/i);
                
                let insertIndex = -1;
                if (orderByMatch) {
                    insertIndex = orderByMatch.index!;
                } else if (groupByMatch) {
                    insertIndex = groupByMatch.index!;
                }
                
                // Check if WHERE already exists in the query (before ORDER BY/GROUP BY)
                const beforeClause = insertIndex !== -1 ? sql.substring(0, insertIndex) : sql;
                const hasWhere = beforeClause.includes(' WHERE ');
                const whereKeyword = hasWhere ? ' AND' : ' WHERE';
                whereClause = `${whereKeyword} ${conditionsString}`;
                
                if (insertIndex !== -1) {
                    // Insert before ORDER BY or GROUP BY
                    sql = sql.substring(0, insertIndex) + whereClause + sql.substring(insertIndex);
                } else {
                    // No ORDER BY or GROUP BY, append at end
                    sql += whereClause;
                }
            }
            
            // Now find the FROM clause and add LATERAL joins after the table name
            const fromIndex = sql.indexOf(' FROM ');
            if (fromIndex !== -1) {
                const afterFromStart = fromIndex + 6; // Position after "FROM "
                const afterFromPart = sql.substring(afterFromStart);
                
                // Find the end of the table name/alias (before WHERE, ORDER BY, or GROUP BY)
                let tableEndIndex = afterFromPart.search(/\s+(WHERE|AND|ORDER\s+BY|GROUP\s+BY)/i);
                if (tableEndIndex === -1) {
                    tableEndIndex = afterFromPart.length;
                }
                
                const tableName = afterFromPart.substring(0, tableEndIndex).trim();
                const restOfQuery = afterFromPart.substring(tableEndIndex);
                
                const beforeFrom = sql.substring(0, afterFromStart);
                const lateralSql = lateralJoins.join(' ');
                sql = beforeFrom + tableName + ' ' + lateralSql + restOfQuery;
            }
        }

        return { sql, hasWhere: hasOuterWhere };
    }

    public getNodeType(): string {
        return "ComponentInclusionNode";
    }
}
