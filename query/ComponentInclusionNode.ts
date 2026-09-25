import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext, sortedCursorValues } from "./QueryContext";
import { shouldUseLateralJoins, shouldUseDirectPartition } from "../core/Config";
import { buildComponentFilterGroup } from "./FilterBuilder";
import { ComponentRegistry } from "../core/components";
import { getMembershipSource, getMembershipTable } from "./membershipSource";
import {
    buildOrderedIdSelect,
    fetchOrder,
    fieldKeyKind,
    jsonFieldKey,
} from "./orderPlan";
import { sortKeyIndexed } from "../database/keyIndexSpec";
import {
    buildMembershipIdSelect,
    componentOrderKey,
    equalityFieldsOf,
    excludedComponentPredicate,
    excludedEntityPredicate,
    membershipProbeExists,
    valueCastOf,
    warnUnindexedComponentSort,
} from "./listSelect";


export type KeysetValueCast = '::text' | '::numeric';

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
 * JSON keys are nullable, so this never uses a row-value comparison.
 *
 * One-key callers pass the flat shape. NULL placement matches ORDER BY:
 * a non-null cursor includes the NULL tail under NULLS LAST, and a NULL
 * cursor includes the non-null group under NULLS FIRST.
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
        const core = `(${sortExpr} IS NULL AND ${entityIdCol} ${idOp} $${idIdx}::uuid)`;
        if (nullsFirst) return ` ${connective} (${core} OR ${sortExpr} IS NOT NULL)`;
        return ` ${connective} ${core}`;
    }
    const nullInclude = nullsFirst ? '' : ` OR ${sortExpr} IS NULL`;
    if (direction !== 'DESC') {
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
    return ` ${connective} (${sortExpr} < $${vLtIdx}${valueCast} OR (${sortExpr} = $${vEqIdx}${valueCast} AND ${entityIdCol} ${idOp} $${idIdx}::uuid)${nullInclude})`;
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
    return buildExpandedKeysetOr(args);
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

        const isBefore = context.compositeCursor !== null && context.cursorDirection === "before";
        const keyMeta = context.sortOrders.map((sort) => {
            const typeId = ComponentRegistry.getComponentId(sort.component)!;
            const alias = aliasByType.get(typeId)!;
            warnUnindexedComponentSort(sort.component, sort.property, equalityFieldsOf(context.componentFilters.get(typeId)));
            return {
                expr: jsonFieldKey(alias, sort.property, fieldKeyKind(sort.component, sort.property)),
                valueCast: valueCastOf(sort.component, sort.property),
                presented: fetchOrder(sort.direction, !!sort.nullsFirst, isBefore),
            };
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
            conditions.push(membershipProbeExists({
                compId,
                entityIdExpr: "s.entity_id",
                context,
                withFilters: filters.length > 0,
            }));
        }
        const excluded = excludedComponentPredicate("s.entity_id", context);
        if (excluded) conditions.push(excluded);
        const excludedEntities = excludedEntityPredicate("s.entity_id", context);
        if (excludedEntities) conditions.push(excludedEntities);

        const last = keyMeta[keyMeta.length - 1]!;
        let cursorWhere = "";
        if (context.compositeCursor) {
            const values = assertSortedCursorWidth(context.compositeCursor, context.sortOrders.length, "sortBy() key(s)");
            cursorWhere = buildKeysetCursorWhere({
                keys: keyMeta.map((meta, i) => ({
                    sortExpr: meta.expr,
                    direction: meta.presented.direction,
                    nullsFirst: meta.presented.nullsFirst,
                    valueCast: meta.valueCast,
                    value: values[i]!,
                })),
                entityIdCol: "s.entity_id",
                connective: "AND",
                cursorId: context.compositeCursor.id,
                idDirection: last.presented.direction,
                addParam: (value) => context.addParam(value),
            });
        }

        const orderParts = keyMeta.map((meta) => {
            const nulls = meta.presented.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
            return `${meta.expr} ${meta.presented.direction} ${nulls}`;
        });
        const idDir = last.presented.direction;
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
        return this.applySortDrivenScanSingle(context);
    }

    private applySortDrivenScanSingle(context: QueryContext): string {
        const sortOrder = context.sortOrders[0]!;
        const sortTypeId = ComponentRegistry.getComponentId(sortOrder.component)!;
        const sortTable = this.getComponentTableName(sortTypeId);
        const legacy = getMembershipSource().isLegacy;
        const driveDirect = shouldUseDirectPartition() && sortTable !== "components";
        const fromLeaf = driveDirect || !legacy;
        const where: string[] = fromLeaf
            ? [`s.type_id = $${context.addParam(sortTypeId)}::text`, `s.deleted_at IS NULL`]
            : [`ec.type_id = $${context.addParam(sortTypeId)}::text`, `ec.deleted_at IS NULL`];
        where.push(...this.sortProbePredicates(context, sortTypeId));

        const isBefore = context.compositeCursor !== null && context.cursorDirection === "before";
        const equality = equalityFieldsOf(context.componentFilters.get(sortTypeId));
        warnUnindexedComponentSort(sortOrder.component, sortOrder.property, equality);
        const cursor = context.compositeCursor
            ? { value: sortedCursorValues(context.compositeCursor)[0] ?? null, id: context.compositeCursor.id }
            : null;
        return buildOrderedIdSelect({
            idExpr: "s.entity_id",
            fromSql: fromLeaf
                ? `${sortTable} s`
                : `entity_components ec JOIN ${sortTable} s ON s.id = ec.component_id AND s.deleted_at IS NULL`,
            where,
            key: componentOrderKey("s", sortOrder.component, sortOrder.property, sortOrder.direction, !!sortOrder.nullsFirst, isBefore),
            cursor,
            limit: context.limit,
            offset: context.compositeCursor ? 0 : context.offsetValue,
            addParam: (value) => context.addParam(value),
            // The legacy entity_components join is not the leaf the key index is on.
            indexed: fromLeaf && sortKeyIndexed(sortOrder.component, sortOrder.property, equality),
        });
    }

    /** Filters on the driving alias, plus EXISTS probes for every other required component. */
    private sortProbePredicates(context: QueryContext, sortTypeId: string): string[] {
        const conditions: string[] = [];
        const sortFilterGroup = buildComponentFilterGroup(context.componentFilters.get(sortTypeId) ?? [], "s", context);
        if (sortFilterGroup) conditions.push(sortFilterGroup);
        for (const compId of context.componentIds) {
            if (compId === sortTypeId) continue;
            const filters = context.componentFilters.get(compId) ?? [];
            conditions.push(membershipProbeExists({
                compId,
                entityIdExpr: "s.entity_id",
                context,
                withFilters: filters.length > 0,
            }));
        }
        const excluded = excludedComponentPredicate("s.entity_id", context);
        if (excluded) conditions.push(excluded);
        const excludedEntities = excludedEntityPredicate("s.entity_id", context);
        if (excludedEntities) conditions.push(excludedEntities);
        return conditions;
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

        // LATERAL insertion assumes a single outer FROM. A multi-leaf driving
        // select already has WHERE/EXISTS, so leave LATERAL off for that shape.
        const isMultiLeafSelect = componentCount > 1 && !useCTE;
        const useLateralJoins = Boolean(shouldUseLateralJoins()) && !isMultiLeafSelect;

        // Collect LATERAL join fragments if using LATERAL joins
        const lateralJoins: string[] = [];
        const lateralConditions: string[] = [];

        // Check if we need custom sorting (sortOrders specified)
        const hasSortOrders = context.sortOrders.length > 0;

        // Multi-component sorted queries drive from the sort component's leaf
        // and probe the other components with EXISTS, so the planner can stop
        // at LIMIT. Checked before any params are added so a null fallback
        // leaves the context clean.

        if (!useCTE && hasSortOrders && ComponentInclusionNode.canUseSortDrivenScan(context)) {
            const sortDriven = this.applySortDrivenScan(context);
            if (sortDriven) {
                return { sql: sortDriven, params: context.params, context };
            }
        }

        if (componentCount === 1) {
            // Single component case
            const componentId = componentIds[0]!;



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
                // CTE already selected the membership set (filters pushed when it could).
                sql = `SELECT ${context.cteName}.entity_id as id FROM ${context.cteName}`;
            } else {
                const built = buildMembershipIdSelect({
                    context,
                    componentIds,
                    selectSql: "s.entity_id AS id",
                });
                sql = built.sql;
                if (built.filtersPushed) context.filtersAppliedInMembership = true;
            }

            const multiCompAlias = useCTE ? context.cteName : "s";
            let outerHasWhere = sql.includes(" WHERE ");

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

            // Apply component filters that were not pushed into the driving leaf.
            // Alias is the driver (`s`) or the CTE name. outerHasWhere tracks the
            // outer SELECT, not predicates inside EXISTS probes.
            const filterResult = this.applyComponentFiltersWithState(context, componentIds, useCTE, useLateralJoins, lateralJoins, lateralConditions, sql, componentParamIndices, multiCompAlias, outerHasWhere);
            sql = filterResult.sql;
            outerHasWhere = filterResult.hasWhere;



            // Apply sorting with component data joins if sortOrders are specified
            if (hasSortOrders) {
                sql = this.applySortingWithComponentJoins(sql, context);
            } else {
                // Default: order by the driving leaf's entity_id (CTE uses its name).
                const idColumn = `${multiCompAlias}.entity_id`;

                // Apply cursor-based pagination if cursor is set (more efficient than OFFSET)
                if (context.cursorId !== null && !context.paginationAppliedInCTE) {
                    const operator = context.cursorDirection === 'after' ? '>' : '<';
                    // Use tracked WHERE state for the outer driving-leaf select.
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
     * Sort when the leaf scan is ineligible (withId, CTE). Key expressions
     * come from orderPlan so a non-numeric value never raises. The id
     * tiebreak follows the last key's fetch direction.
     */
    private applySortingWithComponentJoins(baseQuery: string, context: QueryContext): string {
        if (context.sortOrders.length > 1) return this.applyCorrelatedMultiSort(baseQuery, context);
        return this.applyCorrelatedSingleSort(baseQuery, context);
    }

    private correlatedSortExpr(context: QueryContext, component: string, property: string, idExpr: string): string | null {
        const typeId = ComponentRegistry.getComponentId(component);
        if (!typeId) return null;
        const table = this.getComponentTableName(typeId);
        const expr = jsonFieldKey("sort_c", property, fieldKeyKind(component, property));
        const typePh = `$${context.addParam(typeId)}::text`;
        if (getMembershipSource().isLegacy) {
            return `(SELECT ${expr} FROM entity_components sort_ec JOIN ${table} sort_c ON sort_c.id = sort_ec.component_id WHERE sort_ec.entity_id = ${idExpr} AND sort_ec.type_id = ${typePh} AND sort_ec.deleted_at IS NULL AND sort_c.deleted_at IS NULL LIMIT 1)`;
        }
        return `(SELECT ${expr} FROM ${table} sort_c WHERE sort_c.entity_id = ${idExpr} AND sort_c.type_id = ${typePh} AND sort_c.deleted_at IS NULL LIMIT 1)`;
    }

    private applyCorrelatedSingleSort(baseQuery: string, context: QueryContext): string {
        const sortOrder = context.sortOrders[0];
        const subquery = sortOrder
            ? this.correlatedSortExpr(context, sortOrder.component, sortOrder.property, "base.id")
            : null;
        if (!sortOrder || !subquery) {
            return `SELECT base.id AS id FROM (${baseQuery}) AS base ORDER BY base.id ASC`;
        }
        const isBefore = context.compositeCursor !== null && context.cursorDirection === "before";
        const typeId = ComponentRegistry.getComponentId(sortOrder.component) ?? "";
        warnUnindexedComponentSort(sortOrder.component, sortOrder.property, equalityFieldsOf(context.componentFilters.get(typeId)));
        const presented = fetchOrder(sortOrder.direction, !!sortOrder.nullsFirst, isBefore);
        const paging = context.paginationAppliedInCTE;
        const cursor = context.compositeCursor
            ? { value: sortedCursorValues(context.compositeCursor)[0] ?? null, id: context.compositeCursor.id }
            : null;
        return buildOrderedIdSelect({
            idExpr: "base.id",
            fromSql: `(${baseQuery}) AS base`,
            where: [],
            key: {
                expr: subquery,
                kind: fieldKeyKind(sortOrder.component, sortOrder.property),
                direction: presented.direction,
                nullsFirst: presented.nullsFirst,
            },
            cursor,
            limit: paging ? null : context.limit,
            offset: paging || context.compositeCursor ? 0 : context.offsetValue,
            addParam: (value) => context.addParam(value),
            indexed: false,
        });
    }

    private applyCorrelatedMultiSort(baseQuery: string, context: QueryContext): string {
        const isBefore = context.compositeCursor !== null && context.cursorDirection === "before";
        const keys: Array<{
            expr: string;
            presented: { direction: "ASC" | "DESC"; nullsFirst: boolean };
            valueCast: "::text" | "::numeric";
        }> = [];
        for (const sort of context.sortOrders) {
            const expr = this.correlatedSortExpr(context, sort.component, sort.property, "base.id");
            if (!expr) continue;
            const typeId = ComponentRegistry.getComponentId(sort.component) ?? "";
            warnUnindexedComponentSort(sort.component, sort.property, equalityFieldsOf(context.componentFilters.get(typeId)));
            keys.push({
                expr,
                presented: fetchOrder(sort.direction, !!sort.nullsFirst, isBefore),
                valueCast: valueCastOf(sort.component, sort.property),
            });
        }
        if (keys.length === 0) {
            return `SELECT base.id AS id FROM (${baseQuery}) AS base ORDER BY base.id ASC`;
        }
        const idDir = keys[keys.length - 1]!.presented.direction;
        const paging = !context.paginationAppliedInCTE;

        if (context.compositeCursor) {
            if (keys.length !== context.sortOrders.length) {
                throw new Error("sortedCursor() could not resolve every sortBy() key.");
            }
            const values = assertSortedCursorWidth(context.compositeCursor, context.sortOrders.length, "sortBy() key(s)");
            const selects = keys.map((key, i) => `${key.expr} AS _sv${i}`).join(", ");
            const cursorWhere = buildKeysetCursorWhere({
                keys: keys.map((key, i) => ({
                    sortExpr: `_sorted._sv${i}`,
                    direction: key.presented.direction,
                    nullsFirst: key.presented.nullsFirst,
                    valueCast: key.valueCast,
                    value: values[i]!,
                })),
                entityIdCol: "_sorted.id",
                connective: "WHERE",
                cursorId: context.compositeCursor.id,
                idDirection: idDir,
                addParam: (value) => context.addParam(value),
            });
            const order = keys.map((key, i) => {
                const nulls = key.presented.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
                return `_sorted._sv${i} ${key.presented.direction} ${nulls}`;
            }).join(", ");
            let sql = `WITH _sorted AS (SELECT base.id, ${selects} FROM (${baseQuery}) AS base) SELECT _sorted.id FROM _sorted${cursorWhere} ORDER BY ${order}, _sorted.id ${idDir}`;
            if (paging && context.limit !== null) sql += ` LIMIT $${context.addParam(context.limit)}`;
            return sql;
        }

        const orderParts = keys.map((key) => {
            const nulls = key.presented.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
            return `${key.expr} ${key.presented.direction} ${nulls}`;
        });
        let sql = `SELECT base.id AS id FROM (${baseQuery}) AS base ORDER BY ${orderParts.join(", ")}, base.id ${idDir}`;
        if (paging) {
            if (context.limit !== null) sql += ` LIMIT $${context.addParam(context.limit)}`;
            if (context.cursorId === null && context.offsetValue > 0) sql += ` OFFSET $${context.addParam(context.offsetValue)}`;
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
     * (or one LATERAL) instead of one subquery per filter. When the driving
     * leaf or its EXISTS probes already applied field filters, this is a no-op.
     *
     * @param entityTableAlias - Outer id alias (`ec`, `s`, or the CTE name)
     * @param outerHasWhere - Whether the outer SELECT already has WHERE
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

        // Filters already pushed into the driving leaf or its EXISTS probes.
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
