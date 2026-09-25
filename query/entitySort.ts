/**
 * Entity timestamp list plans (RFC D6).
 *
 * Single key, no component membership: index-ordered id select on `entities`
 * (`bk_entities_created` / `bk_entities_updated`).
 *
 * Single key with membership (`.with` / OR / excluded components): adaptive
 * probe. The candidate window is `min(cap, max(64, ceil(4 * pageLimit / f)))`,
 * where `f` is the driving leaf's `reltuples` over `entities` (OR: sum of
 * leaves, capped at 1) and `cap` is `BUNSANE_ENTITY_SORT_PROBE` (default 5000).
 * Unknown or non-positive stats use `cap`. `needed > cap` skips the probe and
 * runs the hash-join plan directly. A full page, or a window that exhausted
 * every entity after the cursor, is the answer. Otherwise the same order and
 * keyset run with an index-ineligible key expression. `OFFSET > 0` skips the
 * probe.
 *
 * Multi-key (`created_at` + `updated_at`): one statement. No membership uses
 * the canonical keys (plan `index`). Membership uses the index-ineligible twin
 * of every key so the planner cannot walk `entities` in index order (plan `fallback`).
 * The id tiebreak follows the last key's fetch direction.
 *
 * Page 1 and keyset pages both order by the UTC millisecond key. The id
 * tiebreak follows the fetch direction. `'before'` pages are fetched reversed;
 * the caller flips the rows.
 */
import { dbExec } from "../database/gateway";
import { ComponentRegistry } from "../core/components";
import { shouldUseDirectPartition } from "../core/Config";
import { buildComponentFilterGroup } from "./FilterBuilder";
import { getMembershipSource } from "./membershipSource";
import { OrQuery } from "./OrQuery";
import {
    buildOrderedIdSelect,
    entityTimestampFallbackKey,
    entityTimestampKey,
    fetchOrder,
    keyParam,
    type KeysetPosition,
    type OrderKey,
} from "./orderPlan";
import {
    sortedCursorValues,
    type EntitySortOrder,
    type QueryContext,
    type QueryFilter,
} from "./QueryContext";
import { assertComponentTableName } from "./SqlIdentifier";

export type EntitySortPlan = "index" | "probe" | "fallback";

export interface EntitySortPage {
    ids: string[];
    plan: EntitySortPlan;
    /** True when the fetch order was reversed for a `'before'` page. */
    reverse: boolean;
    sql: string;
    params: readonly unknown[];
}

export type EntitySortRunner = (
    sql: string,
    params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

const DEFAULT_PROBE = 5000;

function entitySortProbeLimit(): number {
    const raw = process.env.BUNSANE_ENTITY_SORT_PROBE;
    if (raw === undefined || raw.trim() === "") return DEFAULT_PROBE;
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
        throw new Error(`BUNSANE_ENTITY_SORT_PROBE must be a positive integer (got ${JSON.stringify(raw)}).`);
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1) {
        throw new Error(`BUNSANE_ENTITY_SORT_PROBE must be a positive integer (got ${JSON.stringify(raw)}).`);
    }
    return n;
}

function timestampOrderKey(sort: EntitySortOrder, isBefore: boolean, expr: string): OrderKey {
    const presented = fetchOrder(sort.direction === "DESC" ? "DESC" : "ASC", sort.nullsFirst === true, isBefore);
    return { expr, kind: "timestamp", direction: presented.direction, nullsFirst: presented.nullsFirst };
}

function pageIsBefore(context: QueryContext): boolean {
    return context.compositeCursor !== null && context.cursorDirection === "before";
}

/** sortedCursor() clears offset. A stale offset beside a keyset cursor must not also apply. */
function pageOffset(context: QueryContext): number {
    return context.compositeCursor ? 0 : context.offsetValue;
}

function singleCursor(context: QueryContext): KeysetPosition | null {
    const cursor = context.compositeCursor;
    if (!cursor) return null;
    const values = sortedCursorValues(cursor);
    return { value: values[0] ?? null, id: cursor.id };
}

interface ParamSnap {
    index: number;
    length: number;
}

function snapParams(context: QueryContext): ParamSnap {
    return { index: context.paramIndex, length: context.params.length };
}

function restoreParams(context: QueryContext, snap: ParamSnap): void {
    context.paramIndex = snap.index;
    context.params.length = snap.length;
}

function idsOf(rows: readonly Record<string, unknown>[]): string[] {
    const ids: string[] = [];
    for (const row of rows) {
        if (typeof row.id === "string" && row.id.length > 0) ids.push(row.id);
    }
    return ids;
}

function baseEntityWhere(context: QueryContext): string[] {
    const clauses = ["e.deleted_at IS NULL"];
    if (context.withId) {
        clauses.push(`e.id = $${context.addParam(context.withId)}`);
    }
    if (context.excludedEntityIds.size > 0) {
        const placeholders = Array.from(context.excludedEntityIds)
            .map((id) => `$${context.addParam(id)}`)
            .join(", ");
        clauses.push(`e.id NOT IN (${placeholders})`);
    }
    return clauses;
}

function membershipExists(
    context: QueryContext,
    entityIdSql: string,
    typeId: string,
    filters: readonly QueryFilter[] | undefined,
): string {
    const legacy = getMembershipSource().isLegacy;
    const typeIdx = context.addParam(typeId);
    if (legacy) {
        let sql = `EXISTS (SELECT 1 FROM entity_components p WHERE p.entity_id = ${entityIdSql} AND p.type_id = $${typeIdx}::text AND p.deleted_at IS NULL)`;
        if (filters && filters.length > 0) {
            const raw = shouldUseDirectPartition()
                ? (ComponentRegistry.getPartitionTableName(typeId) || "components")
                : "components";
            const dataTable = assertComponentTableName(raw, "entitySort.dataTable");
            const dataTypeIdx = context.addParam(typeId);
            const group = buildComponentFilterGroup([...filters], "d", context);
            sql += ` AND EXISTS (SELECT 1 FROM ${dataTable} d WHERE d.entity_id = ${entityIdSql} AND d.type_id = $${dataTypeIdx}::text AND d.deleted_at IS NULL${group ? ` AND ${group}` : ""})`;
        }
        return sql;
    }
    const raw = shouldUseDirectPartition()
        ? (ComponentRegistry.getPartitionTableName(typeId) || "components")
        : "components";
    const table = assertComponentTableName(raw, "entitySort.table");
    const group = filters && filters.length > 0
        ? buildComponentFilterGroup([...filters], "p", context)
        : null;
    return `EXISTS (SELECT 1 FROM ${table} p WHERE p.entity_id = ${entityIdSql} AND p.type_id = $${typeIdx}::text AND p.deleted_at IS NULL${group ? ` AND ${group}` : ""})`;
}

/** Membership predicates. Empty means the index plan (no `.with` / OR / excluded component). */
function membershipPredicates(context: QueryContext, orQuery: OrQuery | null, entityIdSql: string): string[] {
    const clauses: string[] = [];
    for (const typeId of context.componentIds) {
        clauses.push(membershipExists(context, entityIdSql, typeId, context.componentFilters.get(typeId)));
    }
    if (orQuery) {
        const ors: string[] = [];
        for (const branch of orQuery.branches) {
            const typeId = context.getComponentId(branch.component);
            if (!typeId) {
                throw new Error(`Component ${branch.component.name} is not registered.`);
            }
            ors.push(membershipExists(context, entityIdSql, typeId, branch.filters));
        }
        clauses.push(`(${ors.join(" OR ")})`);
    }
    if (context.excludedComponentIds.size > 0) {
        const placeholders = Array.from(context.excludedComponentIds)
            .map((id) => `$${context.addParam(id)}`)
            .join(", ");
        const table = getMembershipSource().isLegacy ? "entity_components" : "components";
        clauses.push(
            `NOT EXISTS (SELECT 1 FROM ${table} ex WHERE ex.entity_id = ${entityIdSql} AND ex.type_id IN (${placeholders}) AND ex.deleted_at IS NULL)`,
        );
    }
    return clauses;
}

function nullsClause(nullsFirst: boolean): string {
    return nullsFirst ? "NULLS FIRST" : "NULLS LAST";
}

/**
 * Lexicographic "strictly after the cursor" for mixed directions and NULLs.
 * Same shape as the component multi-key predicate: a NULL cursor value ties
 * on `IS NULL` and is strictly-after only when NULLS FIRST; a non-null cursor
 * is strictly-after on `>`/`<`, plus `IS NULL` when NULLS LAST.
 */
function expandedTimestampKeyset(
    keys: readonly OrderKey[],
    values: readonly (string | null)[],
    cursorId: string,
    idExpr: string,
    addParam: (value: unknown) => number,
): string {
    const idOp = keys[keys.length - 1]!.direction === "DESC" ? "<" : ">";
    const valueIdx = keys.map((_, i) => (values[i] === null ? null : addParam(values[i])));
    const idIdx = addParam(cursorId);

    const tieOf = (i: number): string => {
        const key = keys[i]!;
        if (values[i] === null) return `(${key.expr} IS NULL)`;
        return `(${key.expr} = ${keyParam("timestamp", valueIdx[i]!)})`;
    };

    const strictOf = (i: number): string | null => {
        const key = keys[i]!;
        if (values[i] === null) {
            return key.nullsFirst ? `(${key.expr} IS NOT NULL)` : null;
        }
        const op = key.direction === "DESC" ? "<" : ">";
        const cmp = `${key.expr} ${op} ${keyParam("timestamp", valueIdx[i]!)}`;
        return key.nullsFirst ? `(${cmp})` : `(${cmp} OR ${key.expr} IS NULL)`;
    };

    const parts: string[] = [];
    const ties: string[] = [];
    for (let i = 0; i < keys.length; i++) {
        const strict = strictOf(i);
        if (strict) {
            parts.push(ties.length === 0 ? strict : `(${ties.join(" AND ")} AND ${strict})`);
        }
        ties.push(tieOf(i));
    }
    parts.push(`(${ties.join(" AND ")} AND ${idExpr} ${idOp} $${idIdx}::uuid)`);
    return `(${parts.join(" OR ")})`;
}

function pagingSql(context: QueryContext, limit: number | null, offset: number): string {
    let sql = "";
    if (limit !== null) sql += ` LIMIT $${context.addParam(limit)}`;
    if (offset > 0) sql += ` OFFSET $${context.addParam(offset)}`;
    return sql;
}

function buildMultiKeySql(
    context: QueryContext,
    orQuery: OrQuery | null,
    isBefore: boolean,
): { sql: string; plan: DirectSort["plan"] } {
    const sorts = context.entitySortOrders;
    const membership = membershipPredicates(context, orQuery, "e.id");
    const useIndex = membership.length === 0;
    const keys = sorts.map((sort) => timestampOrderKey(
        sort,
        isBefore,
        useIndex ? entityTimestampKey("e", sort.field) : entityTimestampFallbackKey("e", sort.field),
    ));
    const where = [...baseEntityWhere(context), ...membership];
    const cursor = context.compositeCursor;
    if (cursor) {
        const values = sortedCursorValues(cursor);
        where.push(expandedTimestampKeyset(keys, values, cursor.id, "e.id", (value) => context.addParam(value)));
    }
    const order = keys
        .map((key) => `${key.expr} ${key.direction} ${nullsClause(key.nullsFirst)}`)
        .join(", ");
    const idDir = keys[keys.length - 1]!.direction;
    return {
        sql: `SELECT e.id FROM entities e WHERE ${where.join(" AND ")}` +
            ` ORDER BY ${order}, e.id ${idDir}` +
            pagingSql(context, context.limit, pageOffset(context)),
        plan: useIndex ? "index" : "fallback",
    };
}

function singleKeySelect(
    context: QueryContext,
    where: readonly string[],
    key: OrderKey,
    cursor: KeysetPosition | null,
    limit: number | null,
    offset: number,
    indexed: boolean,
): string {
    return buildOrderedIdSelect({
        idExpr: "e.id",
        fromSql: "entities e",
        where,
        key,
        cursor,
        limit,
        offset,
        addParam: (value) => context.addParam(value),
        indexed,
    });
}

/**
 * Index-ordered prefix of at most `probe` entities, then membership filter.
 * `MATERIALIZED` keeps the probe LIMIT from being pulled into the EXISTS
 * (that merge is the unbounded scan this probe exists to avoid). Referencing
 * the CTE twice would also fence it; the keyword does not depend on that.
 */
function buildProbeSql(
    context: QueryContext,
    whereBase: readonly string[],
    membership: readonly string[],
    key: OrderKey,
    cursor: KeysetPosition | null,
    pageLimit: number | null,
    probe: number,
): string {
    const idSelect = singleKeySelect(context, whereBase, key, cursor, probe, 0, true);
    const order = `${key.expr} ${key.direction} ${nullsClause(key.nullsFirst)}, e.id ${key.direction}`;
    const limitFilter = pageLimit === null ? "" : `WHERE ranked.ord <= $${context.addParam(pageLimit)}`;
    return (
        `WITH candidates AS MATERIALIZED (` +
        `SELECT id FROM (${idSelect}) AS cand_ids` +
        `), stats AS (` +
        `SELECT count(*)::int AS window_n FROM candidates` +
        `), matched AS (` +
        `SELECT ranked.id, ranked.ord FROM (` +
        `SELECT e.id, row_number() OVER (ORDER BY ${order}) AS ord ` +
        `FROM candidates c INNER JOIN entities e ON e.id = c.id ` +
        `WHERE ${membership.join(" AND ")}` +
        `) AS ranked ${limitFilter}` +
        `) ` +
        `SELECT m.id AS id, s.window_n AS window_n ` +
        `FROM stats s LEFT JOIN matched m ON TRUE ` +
        `ORDER BY m.ord NULLS LAST`
    );
}

function interpretProbe(
    rows: readonly Record<string, unknown>[],
    probe: number,
    pageLimit: number | null,
): { accept: boolean; ids: string[] } {
    const windowRaw = rows[0]?.window_n;
    const windowN = typeof windowRaw === "number"
        ? windowRaw
        : typeof windowRaw === "string"
            ? Number(windowRaw)
            : NaN;
    if (!Number.isFinite(windowN)) return { accept: false, ids: [] };
    const ids = idsOf(rows);
    const exhausted = windowN < probe;
    const fullPage = pageLimit !== null && ids.length >= pageLimit;
    if (!exhausted && !fullPage) return { accept: false, ids: [] };
    return { accept: true, ids: pageLimit === null ? ids : ids.slice(0, pageLimit) };
}

interface DirectSort {
    kind: "direct";
    plan: "index" | "fallback";
    sql: string;
    reverse: boolean;
}

interface ProbeSort {
    kind: "probe";
    sql: string;
    reverse: boolean;
    probe: number;
    pageLimit: number | null;
    buildFallback: () => string;
}

type PreparedSort = DirectSort | ProbeSort;

const PROBE_K = 4;
const PROBE_FLOOR = 64;
const TUPLE_TTL_MS = 60_000;

export interface ProbeWindowStats {
    /** Fetch limit, already including the n+1 extra row when that applies. null = unbounded. */
    pageLimit: number | null;
    /** `pg_class.reltuples` for `entities`. null or ≤ 0 is unknown. */
    entities: number | null;
    /** Driving leaf `reltuples`. A null or ≤ 0 entry makes the fraction unknown. */
    leaves: readonly (number | null)[];
    /** `and`: smallest leaf. `or`: sum of leaves, capped at the entity count. */
    combine: "and" | "or";
    /** `BUNSANE_ENTITY_SORT_PROBE`. Upper bound, not the window itself. */
    cap: number;
}

export type ProbeWindowDecision = { probe: true; window: number } | { probe: false };

/**
 * Candidates needed ≈ pageLimit / f, f = leaf rows / entities.
 * Window is `min(cap, max(64, ceil(4 * needed)))`.
 * `needed > cap` skips the probe. Unknown stats use `cap`.
 */
export function entitySortProbeWindow(stats: ProbeWindowStats): ProbeWindowDecision {
    const cap = stats.cap;
    if (!Number.isFinite(cap) || cap < 1) return { probe: true, window: DEFAULT_PROBE };
    const entities = stats.entities;
    const leaves = stats.leaves;
    const known: number[] = [];
    for (const n of leaves) {
        if (n == null || !Number.isFinite(n) || n <= 0) return { probe: true, window: cap };
        known.push(n);
    }
    if (entities == null || entities <= 0 || known.length === 0) return { probe: true, window: cap };
    const members = stats.combine === "or"
        ? Math.min(entities, known.reduce((sum, n) => sum + n, 0))
        : Math.min(...known);
    const fraction = members / entities;
    if (!(fraction > 0) || !Number.isFinite(fraction)) return { probe: false };
    const needed = stats.pageLimit == null ? members : stats.pageLimit / fraction;
    if (!Number.isFinite(needed) || needed > cap) return { probe: false };
    const scaled = Math.ceil(PROBE_K * needed);
    return { probe: true, window: Math.min(cap, Math.max(PROBE_FLOOR, scaled)) };
}

const tupleCache = new Map<string, { tuples: number; at: number }>();

/** Drop cached `reltuples` so a just-analyzed table is visible to the next list. */
export function resetEntitySortTupleCache(): void {
    tupleCache.clear();
}

async function cachedReltuples(tables: readonly string[]): Promise<Map<string, number | null>> {
    const now = Date.now();
    const out = new Map<string, number | null>();
    const missing: string[] = [];
    for (const table of tables) {
        const hit = tupleCache.get(table);
        if (hit && now - hit.at < TUPLE_TTL_MS) out.set(table, hit.tuples);
        else missing.push(table);
    }
    if (missing.length === 0) return out;
    try {
        const placeholders = missing.map((_, i) => `$${i + 1}`).join(", ");
        const raw = await dbExec<Array<{ relname: string; reltuples: number | string }>>(
            `SELECT relname, reltuples::float8 AS reltuples FROM pg_class WHERE relname IN (${placeholders})`,
            [...missing],
            { lane: "request", label: "entitySort.reltuples" },
        );
        const found = new Map<string, number>();
        if (Array.isArray(raw)) {
            for (const row of raw) {
                const n = typeof row.reltuples === "number" ? row.reltuples : Number(row.reltuples);
                if (typeof row.relname === "string" && Number.isFinite(n)) found.set(row.relname, n);
            }
        }
        for (const table of missing) {
            const n = found.get(table);
            if (n == null || n <= 0) out.set(table, null);
            else {
                tupleCache.set(table, { tuples: n, at: now });
                out.set(table, n);
            }
        }
    } catch {
        for (const table of missing) out.set(table, null);
    }
    return out;
}

function leafTable(typeId: string): string {
    const raw = shouldUseDirectPartition()
        ? (ComponentRegistry.getPartitionTableName(typeId) || "components")
        : "components";
    return assertComponentTableName(raw, "entitySort.statsTable");
}

function drivingLeaves(context: QueryContext, orQuery: OrQuery | null): { tables: string[]; combine: "and" | "or" } | null {
    const seen = new Set<string>();
    const add = (typeId: string): void => {
        seen.add(leafTable(typeId));
    };
    if (context.componentIds.size > 0) {
        for (const typeId of context.componentIds) add(typeId);
        return seen.size > 0 ? { tables: [...seen], combine: "and" } : null;
    }
    if (orQuery) {
        for (const branch of orQuery.branches) {
            const typeId = context.getComponentId(branch.component);
            if (typeId) add(typeId);
        }
        return seen.size > 0 ? { tables: [...seen], combine: "or" } : null;
    }
    return null;
}

/** null = skip the probe. A number is the candidate window. Stats failures use the cap. */
async function resolveProbeWindow(context: QueryContext, orQuery: OrQuery | null, cap: number): Promise<number | null> {
    if (context.entitySortOrders.length !== 1 || pageOffset(context) > 0) return cap;
    const driving = drivingLeaves(context, orQuery);
    if (!driving) return cap;
    const tuples = await cachedReltuples(["entities", ...driving.tables]);
    const decision = entitySortProbeWindow({
        pageLimit: context.limit,
        entities: tuples.get("entities") ?? null,
        leaves: driving.tables.map((table) => tuples.get(table) ?? null),
        combine: driving.combine,
        cap,
    });
    return decision.probe ? decision.window : null;
}

function prepareEntitySort(context: QueryContext, orQuery: OrQuery | null, probeWindow: number | null): PreparedSort {
    const sorts = context.entitySortOrders;
    if (sorts.length === 0) {
        throw new Error("entity sort requires sortByCreatedAt() or sortByUpdatedAt().");
    }
    const isBefore = pageIsBefore(context);
    if (sorts.length > 1) {
        const multi = buildMultiKeySql(context, orQuery, isBefore);
        return { kind: "direct", plan: multi.plan, sql: multi.sql, reverse: isBefore };
    }

    const sort = sorts[0]!;
    const whereBase = baseEntityWhere(context);
    const membership = membershipPredicates(context, orQuery, "e.id");
    const cursor = singleCursor(context);
    const offset = pageOffset(context);
    const pageLimit = context.limit;
    const canonical = timestampOrderKey(sort, isBefore, entityTimestampKey("e", sort.field));

    if (membership.length === 0) {
        return {
            kind: "direct",
            plan: "index",
            sql: singleKeySelect(context, whereBase, canonical, cursor, pageLimit, offset, true),
            reverse: isBefore,
        };
    }
    const fallbackKey = timestampOrderKey(sort, isBefore, entityTimestampFallbackKey("e", sort.field));
    if (offset > 0 || probeWindow == null) {
        return {
            kind: "direct",
            plan: "fallback",
            sql: singleKeySelect(context, [...whereBase, ...membership], fallbackKey, cursor, pageLimit, offset, false),
            reverse: isBefore,
        };
    }

    const shared = snapParams(context);
    const probeSql = buildProbeSql(context, whereBase, membership, canonical, cursor, pageLimit, probeWindow);
    return {
        kind: "probe",
        sql: probeSql,
        reverse: isBefore,
        probe: probeWindow,
        pageLimit,
        buildFallback: () => {
            restoreParams(context, shared);
            return singleKeySelect(context, [...whereBase, ...membership], fallbackKey, cursor, pageLimit, 0, false);
        },
    };
}

/** SQL `explainAnalyze` should show: the statement exec runs, or the probe when the choice is adaptive. */
export async function explainEntitySortSql(
    context: QueryContext,
    orQuery: OrQuery | null,
): Promise<{ sql: string; params: unknown[] }> {
    const cap = entitySortProbeLimit();
    const window = await resolveProbeWindow(context, orQuery, cap);
    const prepared = prepareEntitySort(context, orQuery, window);
    return { sql: prepared.sql, params: context.params };
}

export async function executeEntitySort(
    context: QueryContext,
    orQuery: OrQuery | null,
    run: EntitySortRunner,
): Promise<EntitySortPage> {
    const cap = entitySortProbeLimit();
    const window = await resolveProbeWindow(context, orQuery, cap);
    const prepared = prepareEntitySort(context, orQuery, window);
    if (prepared.kind === "direct") {
        const params = context.params.slice();
        const rows = await run(prepared.sql, params);
        return { ids: idsOf(rows), plan: prepared.plan, reverse: prepared.reverse, sql: prepared.sql, params };
    }

    const probeParams = context.params.slice();
    const probeRows = await run(prepared.sql, probeParams);
    const decision = interpretProbe(probeRows, prepared.probe, prepared.pageLimit);
    if (decision.accept) {
        return {
            ids: decision.ids,
            plan: "probe",
            reverse: prepared.reverse,
            sql: prepared.sql,
            params: probeParams,
        };
    }

    const sql = prepared.buildFallback();
    const params = context.params.slice();
    const rows = await run(sql, params);
    return { ids: idsOf(rows), plan: "fallback", reverse: prepared.reverse, sql, params };
}
