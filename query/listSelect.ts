/**
 * Shared list-read SQL (RFC D3/D5/D8): component key expressions, the
 * unindexed-sort warning, and the driving-leaf + EXISTS membership select.
 * ComponentInclusionNode and CTENode both call this so the semi-join text
 * exists once.
 */
import { ComponentRegistry } from "../core/components";
import { shouldUseDirectPartition } from "../core/Config";
import { logger } from "../core/Logger";
import { sortKeyIndexed } from "../database/keyIndexSpec";
import { buildComponentFilterGroup } from "./FilterBuilder";
import { getMembershipSource, getMembershipTable } from "./membershipSource";
import {
    fetchOrder,
    fieldKeyKind,
    jsonFieldKey,
    type OrderKey,
    type SortDirection,
} from "./orderPlan";
import type { QueryContext, QueryFilter } from "./QueryContext";

const warnedUnindexedSorts = new Set<string>();

/** Fields this component pins with `=` (composite-index prefixes). Nested paths are not keys. */
export function equalityFieldsOf(filters: readonly QueryFilter[] | undefined): Set<string> {
    const fields = new Set<string>();
    for (const filter of filters ?? []) {
        if (filter.operator === "=" && !filter.field.includes(".")) fields.add(filter.field);
    }
    return fields;
}

/**
 * Development-only, once per (component, field). Names the decorator that
 * would make the sort index-ordered.
 */
export function warnUnindexedComponentSort(
    component: string,
    field: string,
    equalityFields: ReadonlySet<string>,
): void {
    if (process.env.NODE_ENV !== "development") return;
    if (sortKeyIndexed(component, field, equalityFields)) return;
    const key = `${component}\0${field}`;
    if (warnedUnindexedSorts.has(key)) return;
    warnedUnindexedSorts.add(key);
    logger.warn(
        { scope: "query.sort", component, field },
        `sortBy(${component}, "${field}") has no key index; the list will not be index-ordered. Add @CompData({ indexed: true }) or @CompositeIndex.`,
    );
}

export function componentOrderKey(
    alias: string,
    component: string,
    field: string,
    direction: SortDirection,
    nullsFirst: boolean,
    isBefore: boolean,
): OrderKey {
    const kind = fieldKeyKind(component, field);
    const presented = fetchOrder(direction, nullsFirst, isBefore);
    return {
        expr: jsonFieldKey(alias, field, kind),
        kind,
        direction: presented.direction,
        nullsFirst: presented.nullsFirst,
    };
}

export function valueCastOf(component: string, field: string): "::text" | "::numeric" {
    return fieldKeyKind(component, field) === "numeric" ? "::numeric" : "::text";
}

interface MembershipLeaf {
    table: string;
    canPushFilters: boolean;
}

function membershipLeaf(compId: string): MembershipLeaf {
    const source = getMembershipSource();
    if (source.isLegacy) return { table: source.table, canPushFilters: false };
    let table = getMembershipTable();
    if (shouldUseDirectPartition()) {
        const partition = ComponentRegistry.getPartitionTableName(compId);
        if (partition) table = partition;
    }
    return { table, canPushFilters: true };
}

/** First component that has filters, else the first `.with()` (Set insertion order). */
export function pickMembershipDriver(
    componentIds: readonly string[],
    filters: ReadonlyMap<string, readonly QueryFilter[]>,
): string {
    for (const id of componentIds) {
        const list = filters.get(id);
        if (list && list.length > 0) return id;
    }
    return componentIds[0]!;
}

/**
 * One component probe. Field filters are pushed when the membership row
 * carries `data`; otherwise this is presence-only and the caller keeps the
 * outer filter EXISTS (legacy `entity_components`).
 */
export function membershipProbeExists(args: {
    compId: string;
    entityIdExpr: string;
    context: QueryContext;
    withFilters: boolean;
}): string {
    const leaf = membershipLeaf(args.compId);
    const typePh = `$${args.context.addParam(args.compId)}::text`;
    const filters = args.withFilters ? (args.context.componentFilters.get(args.compId) ?? []) : [];
    if (leaf.canPushFilters) {
        const group = filters.length > 0 ? buildComponentFilterGroup(filters, "cf", args.context) : null;
        const filterSql = group ? ` AND ${group}` : "";
        return `EXISTS (SELECT 1 FROM ${leaf.table} cf WHERE cf.entity_id = ${args.entityIdExpr} AND cf.type_id = ${typePh}${filterSql} AND cf.deleted_at IS NULL)`;
    }
    if (filters.length === 0) {
        return `EXISTS (SELECT 1 FROM ${leaf.table} cf WHERE cf.entity_id = ${args.entityIdExpr} AND cf.type_id = ${typePh} AND cf.deleted_at IS NULL)`;
    }
    const compTable = shouldUseDirectPartition()
        ? (ComponentRegistry.getPartitionTableName(args.compId) || "components")
        : "components";
    const group = buildComponentFilterGroup(filters, "cf", args.context);
    const filterSql = group ? ` AND ${group}` : "";
    return (
        `EXISTS (SELECT 1 FROM entity_components ec_f JOIN ${compTable} cf ON ec_f.component_id = cf.id ` +
        `WHERE ec_f.entity_id = ${args.entityIdExpr} AND ec_f.type_id = ${typePh}${filterSql} ` +
        `AND ec_f.deleted_at IS NULL AND cf.deleted_at IS NULL)`
    );
}

export function excludedComponentPredicate(entityIdExpr: string, context: QueryContext): string | null {
    if (context.excludedComponentIds.size === 0) return null;
    const placeholders = Array.from(context.excludedComponentIds)
        .map((id) => `$${context.addParam(id)}`)
        .join(", ");
    return (
        `NOT EXISTS (SELECT 1 FROM ${getMembershipTable()} ec_ex WHERE ec_ex.entity_id = ${entityIdExpr} ` +
        `AND ec_ex.type_id IN (${placeholders}) AND ec_ex.deleted_at IS NULL)`
    );
}

export function excludedEntityPredicate(entityIdExpr: string, context: QueryContext): string | null {
    if (context.excludedEntityIds.size === 0) return null;
    const placeholders = Array.from(context.excludedEntityIds)
        .map((id) => `$${context.addParam(id)}`)
        .join(", ");
    return `${entityIdExpr} NOT IN (${placeholders})`;
}

/**
 * Unsorted multi-component id source: one driving leaf plus EXISTS semi-joins.
 * `UNIQUE (entity_id, type_id)` makes the set identical to a membership intersection.
 * Does not emit ORDER BY / LIMIT — the caller owns pagination.
 */
export function buildMembershipIdSelect(args: {
    context: QueryContext;
    componentIds: readonly string[];
    /** `s.entity_id AS id` or `s.entity_id`. */
    selectSql: string;
}): { sql: string; filtersPushed: boolean } {
    const driverId = pickMembershipDriver(args.componentIds, args.context.componentFilters);
    const driver = membershipLeaf(driverId);
    const where: string[] = [
        `s.type_id = $${args.context.addParam(driverId)}::text`,
        `s.deleted_at IS NULL`,
    ];
    let filtersPushed = false;
    if (driver.canPushFilters) {
        const group = buildComponentFilterGroup(args.context.componentFilters.get(driverId) ?? [], "s", args.context);
        if (group) {
            where.push(group);
            filtersPushed = true;
        }
    }
    for (const compId of args.componentIds) {
        if (compId === driverId) continue;
        const filters = args.context.componentFilters.get(compId) ?? [];
        const leaf = membershipLeaf(compId);
        if (leaf.canPushFilters && filters.length > 0) filtersPushed = true;
        where.push(membershipProbeExists({
            compId,
            entityIdExpr: "s.entity_id",
            context: args.context,
            withFilters: filters.length > 0,
        }));
    }
    return {
        sql: `SELECT ${args.selectSql} FROM ${driver.table} s WHERE ${where.join(" AND ")}`,
        filtersPushed,
    };
}
