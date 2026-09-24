import {ComponentRegistry , type BaseComponent, type ComponentDataType } from "../core/components";
import { Entity } from "../core/Entity";
import { logger } from "../core/Logger";
import db, { QUERY_TIMEOUT_MS } from "../database";
import { timed } from "../core/Decorators";
import { inList } from "../database/sqlHelpers";
import { QueryContext, QueryDAG, ComponentInclusionNode } from "./index";
import { buildKeysetCursorWhere } from "./ComponentInclusionNode";
import { buildComponentFilterGroup } from "./FilterBuilder";
import { hydrateComponentRow } from "../core/entity/hydrateComponentRow";
import { OrQuery } from "./OrQuery";
import { OrNode } from "./OrNode";
import { type PerRequestCounters } from "../database/instrumentedDb";
import { dbExec } from "../database/gateway";
import { linkAbortSignals } from "../database/cancellable";
import { getMetadataStorage } from "../core/metadata";
import { shouldUseDirectPartition } from "../core/Config";
import type { SQL } from "bun";
import type { ComponentConstructor, TypedEntity, ComponentRecord } from "../types/query.types";
import { assertComponentTableName, assertFieldPath, assertIdentifier, normalizeSortDirection } from "./SqlIdentifier";
import { getMembershipSource } from "./membershipSource";
import { isNumericProperty } from "./ComponentInclusionNode";
import { buildCoverageRequest } from "./planner/CoverageSet";
import { shadowRunExec, shadowRunCount } from "./planner/ShadowRunner";
import {
    buildRmQuery,
    buildRmCountQuery,
    buildRmEstimateQuery,
    SurfacePlanner,
    recordRoute,
    recordFallback,
    type PlanResolution,
} from "./planner";
import type { CoverageRequest } from "./planner/CoverageRequest";
import { resolveHydrationPlan, EMPTY_HYDRATION_PLAN, type RmHydrationPlan } from "./planner/RmHydrationPlan";
import { hydrateEntityFromRow } from "./planner/RmRowHydrator";
import { PlannerCache } from "./planner/PlannerCache";
import { qspMode, qspCountStrategy, qspActive, qspHydrate } from "../database/projection/qspConfig";
import { ProjectionManager } from "../database/projection/ProjectionManager";
import { sqlTimeBucketFromTs, type TimeTrunc } from "./timeBucket";
import { isVerboseErrors } from "../core/envMode";

// Parsed once, re-read only if the env string changes so tests can lower the
// cap without a process.env read on the steady-state hot path.
let defaultLimitRaw = process.env.BUNSANE_DEFAULT_QUERY_LIMIT;
let defaultQueryLimit = parseDefaultQueryLimit(defaultLimitRaw);

function parseDefaultQueryLimit(raw: string | undefined): number {
    const n = parseInt(raw ?? "10000", 10);
    return Number.isFinite(n) ? n : 10000;
}

function currentDefaultQueryLimit(): number {
    const raw = process.env.BUNSANE_DEFAULT_QUERY_LIMIT;
    if (raw !== defaultLimitRaw) {
        defaultLimitRaw = raw;
        defaultQueryLimit = parseDefaultQueryLimit(raw);
    }
    return defaultQueryLimit;
}

let warnedDefaultLimit = false;

// Gated once through the single SEC-08 verbosity gate: only NODE_ENV=development
// logs params. Fail-closed — unset/staging/typo'd NODE_ENV masks.
const DEBUG_PARAMS = isVerboseErrors();

// QSP gates read env at call time via qspConfig.
/** Extract Plan Rows from EXPLAIN (FORMAT JSON) result (object or string). */
function extractExplainPlanRows(plan: any[]): number {
    try {
        let qp: any = plan?.[0]?.['QUERY PLAN'];
        if (typeof qp === 'string') {
            qp = JSON.parse(qp);
        }
        const root = Array.isArray(qp) ? qp[0] : qp;
        const planRows = root?.Plan?.['Plan Rows'] ?? root?.['Plan Rows'] ?? 0;
        const n = Number(planRows);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

// Shared across all TypedEntity instances — avoids one closure allocation per row.
// Must be called as a method (entity.getTyped(Ctor)) so `this` resolves correctly.
async function sharedGetTyped(
    this: any,
    ctor: any
): Promise<any> {
    const data = await this.get(ctor);
    if (!data) {
        throw new Error(`Component ${ctor.name} not found on entity ${this.id}, but it was expected from query`);
    }
    return data;
}

// Hoisted descriptor for _queriedComponents — non-enumerable by design (hidden from
// Object.keys / spreads). Descriptor is reused; only `value` is patched per row.
const queriedComponentsDescriptor: PropertyDescriptor = {
    value: undefined as any,
    writable: false,
    enumerable: false,
    configurable: false,
};

// getTyped stays non-enumerable like the original defineProperty version; the value
// never varies, so the descriptor is fully static.
const getTypedDescriptor: PropertyDescriptor = {
    value: sharedGetTyped,
    writable: false,
    enumerable: false,
    configurable: false,
};

export type FilterOperator =
    | "="
    | ">"
    | "<"
    | ">="
    | "<="
    | "!="
    | "LIKE"
    | "ILIKE"
    | "IN"
    | "NOT IN"
    | "IS NULL"
    | "IS NOT NULL"
    | string;

export type GroupAggCast = "timestamptz" | "numeric" | "text";

export const FilterOp = {
    EQ: "=" as FilterOperator,
    GT: ">" as FilterOperator,
    LT: "<" as FilterOperator,
    GTE: ">=" as FilterOperator,
    LTE: "<=" as FilterOperator,
    NEQ: "!=" as FilterOperator,
    LIKE: "LIKE" as FilterOperator,
    ILIKE: "ILIKE" as FilterOperator,
    IN: "IN" as FilterOperator,
    NOT_IN: "NOT IN" as FilterOperator,
    IS_NULL: "IS NULL" as FilterOperator,
    IS_NOT_NULL: "IS NOT NULL" as FilterOperator,
    CONTAINS: "CONTAINS" as FilterOperator,
    CONTAINED_BY: "CONTAINED_BY" as FilterOperator,
    HAS_ANY: "HAS_ANY" as FilterOperator,
    HAS_ALL: "HAS_ALL" as FilterOperator,
}

export interface QueryFilter {
    field: string;
    operator: FilterOperator;
    value: unknown;
}

/** Filter whose `field` is a key of the component the ctor belongs to. */
export type ComponentFieldFilter<T extends BaseComponent> = {
    field: keyof ComponentDataType<T> & string;
    operator: FilterOperator;
    value: unknown;
};

export interface QueryFilterOptions<T extends BaseComponent = BaseComponent> {
    filters: ReadonlyArray<ComponentFieldFilter<T>>;
}

type WithItem = {
    component: ComponentConstructor;
    filters?: ReadonlyArray<{ field: string; operator: FilterOperator; value: unknown }>;
};

type CtorOfItem<T> = T extends { component: infer C extends ComponentConstructor } ? C : never;

type CtorsOf<T extends readonly { component: ComponentConstructor }[]> = {
    [K in keyof T]: CtorOfItem<T[K]>;
};

export type SortDirection = "ASC" | "DESC";

export interface SortOrder {
    component: string;
    property: string;
    direction: SortDirection;
    nullsFirst?: boolean;
}

export interface ComponentWithFilters<T extends BaseComponent = BaseComponent> {
    component: new (...args: never[]) => T;
    filters?: ReadonlyArray<ComponentFieldFilter<T>>;
}

export interface QueryCacheOptions {
    /** Ignored. Bun SQL prepares statements; there is no framework statement cache. */
    preparedStatement?: boolean;
    component?: boolean;
}

/**
 * Options accepted by Query terminal methods (`exec`, `count`, `sum`, etc.).
 * - `signal` cancels in-flight DB queries via Bun's `Query.cancel()` when
 *   fired. The request-scoped signal from `req.signal` is automatically
 *   threaded into resolver-level Query instances by the framework's
 *   GraphQL request context plugin; manual callers pass it explicitly.
 * - `perRequest` is an opaque counter object incremented by the
 *   instrumented DB layer so per-request stats (dbQueryCount,
 *   dataLoaderCalls) are reported on access/timeout logs.
 */
export interface QueryExecOptions {
    signal?: AbortSignal;
    perRequest?: PerRequestCounters;
}

export interface QueryRouteInfo {
    routed: boolean;
    surface: 'rm' | 'legacy';
    archetype?: string;
    hasNextPage?: boolean;
    /**
     * True when an unbounded `exec()` filled `BUNSANE_DEFAULT_QUERY_LIMIT`
     * (default 10000). The page may be truncated. Call `.take(n)`.
     */
    truncatedByDefaultLimit?: boolean;
}

/**
 * Query builder. `TComponents` accumulates `.with()` ctors. `TPopulated` is
 * true only after `.populate()` — `exec()` then types `componentData` as loaded.
 *
 * @example
 * ```typescript
 * const entities = await new Query()
 *   .with(Position)
 *   .with(Velocity)
 *   .populate()
 *   .exec();
 * // entities is TypedEntity<[typeof Position, typeof Velocity], true>[]
 * ```
 */
class Query<
    TComponents extends readonly ComponentConstructor[] = [],
    TPopulated extends boolean = false,
> {
    private context: QueryContext;
    private debug: boolean = false;
    private orQuery: OrQuery | null = null;
    private shouldPopulate: boolean = false;
    private trx: SQL | undefined;
    private skipComponentCache: boolean = false;
    private execSignal?: AbortSignal;
    private execPerRequest?: PerRequestCounters;
    /** Last QSP route decision for this Query instance (additive; not GraphQL-exposed). */
    private _lastRouteInfo: QueryRouteInfo = { routed: false, surface: 'legacy' };
    /** Unbounded exec() applied BUNSANE_DEFAULT_QUERY_LIMIT. */
    private appliedDefaultLimit = false;
    /** 'before' keyset fetched in reverse order; flip rows after the n+1 trim. */
    private reverseSortedPage = false;

    /**
     * True only when the caller invoked `.take(N)`. Framework default LIMIT
     * does not set this — used for LIMIT n+1 / hasNextPage (RP-01).
     */
    private explicitTake: boolean = false;

    /**
     * When set for a legacy exec, SQL was built with pageSize+1 and the result
     * is trimmed after fetch to derive hasNextPage without a second count().
     */
    private nPlus1PageSize: number | null = null;

    /** Component constructors added to this query for type-safe access */
    private _componentCtors: ComponentConstructor[] = [];

    private groupBySpec: {
        ctor: new (...args: any[]) => BaseComponent;
        field: string;
        trunc?: TimeTrunc;
        tzOffsetMinutes: number;
    } | null = null;

    constructor(trx?: SQL) {
        this.trx = trx;
        this.context = new QueryContext(trx);
    }

    /**
     * Additive QSP diagnostic: whether the last exec/count served via rm_ (route mode)
     * and optional hasNextPage from N+1 fetch. Not part of GraphQL schema.
     */
    public getLastRouteInfo(): QueryRouteInfo {
        return this._lastRouteInfo;
    }

    /**
     * Run a read statement through the DB execution seam.
     *
     * Same argument order as the `timedUnsafe` it replaces, so the change at
     * each call site is the function name and a label, nothing else.
     *
     * `callerOwnsConn` is derived from `this.trx`, never hardcoded: a Query
     * given a transaction via `withTrx()` runs on a connection the caller
     * already holds — often one opened by consumer code with a raw
     * `db.transaction()`, where there is no admitted scope to inherit. Waiting
     * for an admission permit there would block while holding the very resource
     * permits ration, which is the nested-acquire deadlock this seam exists to
     * prevent.
     */
    private execSql<T = any>(
        label: string,
        conn: any,
        sql: string,
        params: any[],
        signal?: AbortSignal,
        perRequest?: PerRequestCounters,
    ): Promise<T> {
        return dbExec<T>(sql, params, {
            conn,
            callerOwnsConn: !!this.trx,
            lane: 'request',
            label,
            signal,
            perRequest,
        });
    }

    /**
     * Get the database connection to use (transaction or default db)
     */
    private getDb(): SQL {
        return this.trx ?? db;
    }

    public findById(id: string) {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            throw new Error(`Query.findById called with invalid id: "${id}"`);
        }
        this.context.withId = id;
        return this;
    }

    public async findOneById(id: string, opts?: QueryExecOptions): Promise<TypedEntity<TComponents, TPopulated> | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            return null;
        }
        const entities = await this.findById(id).exec(opts);
        return entities.length > 0 ? entities[0]! : null;
    }

    /**
     * Add a component requirement to the query with type accumulation.
     * The returned Query tracks all component types for type-safe access after exec().
     */
    public with<T extends BaseComponent>(
        componentCtor: ComponentConstructor<T>,
        options?: QueryFilterOptions<T>
    ): Query<readonly [...TComponents, ComponentConstructor<T>], TPopulated>;
    public with<const TItems extends readonly WithItem[]>(
        components: TItems
    ): Query<readonly [...TComponents, ...CtorsOf<TItems>], TPopulated>;
    public with(orQuery: OrQuery): this;
    public with(
        componentCtorOrComponentsOrOrQuery: ComponentConstructor | readonly WithItem[] | OrQuery,
        options?: { filters?: ReadonlyArray<{ field: string; operator: FilterOperator; value: unknown }> }
    ): unknown {
        if (componentCtorOrComponentsOrOrQuery instanceof OrQuery) {
            this.orQuery = componentCtorOrComponentsOrOrQuery;
            this.context.hasOrQuery = true;
            return this;
        }

        if (Array.isArray(componentCtorOrComponentsOrOrQuery)) {
            const items: readonly WithItem[] = componentCtorOrComponentsOrOrQuery;
            for (const item of items) {
                const typeId = this.context.getComponentId(item.component);
                if (!typeId) {
                    throw new Error(`Component ${item.component.name} is not registered.`);
                }
                this.context.componentIds.add(typeId);
                this._componentCtors.push(item.component);

                if (item.filters && item.filters.length > 0) {
                    this.context.componentFilters.set(typeId, [...item.filters]);
                }
            }
            return this;
        }

        // Array.isArray does not exclude a readonly array from the false branch.
        const ctor = componentCtorOrComponentsOrOrQuery as ComponentConstructor;
        const typeId = this.context.getComponentId(ctor);
        if (!typeId) {
            throw new Error(`Component ${ctor.name} is not registered.`);
        }
        this.context.componentIds.add(typeId);
        this._componentCtors.push(ctor);

        if (options?.filters && options.filters.length > 0) {
            this.context.componentFilters.set(typeId, [...options.filters]);
        }
        return this;
    }

    public without<T extends BaseComponent>(ctor: new (...args: any[]) => T) {
        const type_id = this.context.getComponentId(ctor);
        if (!type_id) {
            throw new Error(`Component ${ctor.name} is not registered.`);
        }
        this.context.excludedComponentIds.add(type_id);
        return this;
    }

    public excludeEntityId(entityId: string): this {
        this.context.excludedEntityIds.add(entityId);
        return this;
    }

    public populate(): Query<TComponents, true> {
        this.shouldPopulate = true;
        // Type-state: the same instance is now a populated query. Callers must
        // use the return value (chaining) for componentData to be typed loaded.
        return this as unknown as Query<TComponents, true>;
    }

    /**
     * Eagerly load specific components after query execution.
     * This preloads components into entities to avoid N+1 queries when accessing them later.
     * @param ctors Array of component constructors to eagerly load
     */
    public eagerLoadComponents(ctors: Array<new () => BaseComponent>): this {
        for (const ctor of ctors) {
            const type_id = this.context.getComponentId(ctor);
            if (!type_id) {
                throw new Error(`Component ${ctor.name} is not registered.`);
            }
            this.context.eagerComponents.add(type_id);
        }
        return this;
    }

    /**
     * Alias for eagerLoadComponents for backward compatibility
     */
    public eagerLoad<T extends BaseComponent>(ctors: (new (...args: any[]) => T)[]): this {
        return this.eagerLoadComponents(ctors);
    }

    public take(limit: number): this {
        this.context.limit = limit;
        this.explicitTake = true;
        return this;
    }

    public offset(offset: number): this {
        this.context.offsetValue = offset;
        return this;
    }

    /**
     * SQL GROUP BY on one component field. Does not hydrate entities.
     * `trunc: 'day'|'week'` buckets a Date/timestamptz JSON field after shifting
     * by `tzOffsetMinutes` (same convention as Isoiresik sales local days).
     * Pair with {@link countBy} / {@link sumBy} / {@link maxBy} / {@link minBy}.
     * Cannot combine with OR queries.
     */
    public groupBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T> | string,
        opts?: { trunc?: TimeTrunc; tzOffsetMinutes?: number }
    ): this {
        if (this.orQuery) {
            throw new Error("Query.groupBy cannot be combined with OR queries");
        }
        const ident = assertIdentifier(String(field), "Query.groupBy.field");
        const typeId = this.context.getComponentId(componentCtor);
        if (!typeId) {
            throw new Error(`Component ${componentCtor.name} is not registered.`);
        }
        if (!this.context.componentIds.has(typeId)) {
            throw new Error(
                `Query.groupBy(${componentCtor.name}, '${ident}') requires .with(${componentCtor.name}) first`
            );
        }
        this.groupBySpec = {
            ctor: componentCtor,
            field: ident,
            trunc: opts?.trunc,
            tzOffsetMinutes: opts?.tzOffsetMinutes ?? 0,
        };
        return this;
    }

    /**
     * GROUP BY + COUNT(*). Requires {@link groupBy}. Ignores .take() / sort.
     */
    public countBy(): Promise<Array<Record<string, unknown>>> {
        if (!this.groupBySpec) {
            throw new Error("Query.countBy() requires .groupBy() first");
        }
        return this.runWithTimeout("Query countBy execution", () => this.doCountBy());
    }

    /**
     * GROUP BY + SUM(field). Requires {@link groupBy}. Ignores .take() / sort.
     */
    public sumBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>
    ): Promise<Array<Record<string, unknown>>> {
        if (!this.groupBySpec) {
            throw new Error("Query.sumBy() requires .groupBy() first");
        }
        return this.runWithTimeout("Query sumBy execution", () =>
            this.doSumBy(componentCtor, field as string)
        );
    }

    /**
     * GROUP BY + MAX(field). Default cast is timestamptz (ISO Date fields).
     * Pass `{ cast: "numeric" }` for numbers, `{ cast: "text" }` for raw JSON text.
     */
    public maxBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>,
        opts?: { cast?: GroupAggCast }
    ): Promise<Array<Record<string, unknown>>> {
        if (!this.groupBySpec) {
            throw new Error("Query.maxBy() requires .groupBy() first");
        }
        return this.runWithTimeout("Query maxBy execution", () =>
            this.doMinMaxBy("MAX", componentCtor, field as string, opts?.cast ?? "timestamptz")
        );
    }

    /**
     * GROUP BY + MIN(field). Same cast rules as {@link maxBy}.
     */
    public minBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>,
        opts?: { cast?: GroupAggCast }
    ): Promise<Array<Record<string, unknown>>> {
        if (!this.groupBySpec) {
            throw new Error("Query.minBy() requires .groupBy() first");
        }
        return this.runWithTimeout("Query minBy execution", () =>
            this.doMinMaxBy("MIN", componentCtor, field as string, opts?.cast ?? "timestamptz")
        );
    }

    /**
     * GROUP BY + AVG(end − start) in minutes for two Date JSON fields on the
     * same component. Null/blank timestamps are skipped (AVG ignores NULL).
     */
    public avgIntervalMinutesBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        startField: keyof ComponentDataType<T>,
        endField: keyof ComponentDataType<T>
    ): Promise<Array<Record<string, unknown>>> {
        if (!this.groupBySpec) {
            throw new Error("Query.avgIntervalMinutesBy() requires .groupBy() first");
        }
        return this.runWithTimeout("Query avgIntervalMinutesBy execution", () =>
            this.doAvgIntervalMinutesBy(componentCtor, startField as string, endField as string)
        );
    }

    /**
     * Use cursor-based pagination instead of OFFSET.
     * Much more efficient for large datasets - O(1) instead of O(offset).
     * 
     * @param cursorId - The entity ID to paginate from (exclusive)
     * @param direction - 'after' for next page (default), 'before' for previous page
     * @returns this for chaining
     * 
     * @example
     * // Get first page
     * const page1 = await new Query().with(User).take(100).exec();
     * 
     * // Get next page using cursor
     * const lastId = page1[page1.length - 1].id;
     * const page2 = await new Query().with(User).take(100).cursor(lastId).exec();
     */
    public cursor(cursorId: string, direction: 'after' | 'before' = 'after'): this {
        this.context.cursorId = cursorId;
        this.context.cursorDirection = direction;
        // Clear offset when using cursor-based pagination
        this.context.offsetValue = 0;
        // Plain entity_id cursor is incompatible with component sortBy (pages by
        // id order, not sort order). Fail at exec if both are set (RP-06b).
        return this;
    }

    /**
     * Use composite keyset pagination for a SORTED query.
     *
     * Pass the opaque token returned by `Query.encodeSortedCursor(sortValue, entityId)`
     * where `sortValue` is the sort column's raw value from the last row of the
     * previous page, and `entityId` is that row's entity id. The query must have
     * exactly one active sort key (sortByCreatedAt / sortByUpdatedAt / sortBy).
     * Multi-key sort cursors are not supported — the method will throw at exec time.
     *
     * @example
     * // Page 1
     * const page1 = await new Query().with(MyComp).sortBy(MyComp, 'score', 'ASC').take(10).exec();
     * const last = page1[page1.length - 1]!;
     * // Build cursor from the last row's sort value.
     * const token = Query.encodeSortedCursor(last.componentData['MyComp'].score, last.id);
     *
     * // Page 2
     * const page2 = await new Query().with(MyComp).sortBy(MyComp, 'score', 'ASC').take(10).sortedCursor(token).exec();
     */
    public sortedCursor(token: string, direction: 'after' | 'before' = 'after'): this {
        this.context.compositeCursor = Query.decodeSortedCursor(token);
        this.context.cursorDirection = direction;
        // A composite cursor supersedes plain cursorId and OFFSET.
        this.context.cursorId = null;
        this.context.offsetValue = 0;
        return this;
    }

    /**
     * Encode a composite sort cursor from the last row's sort value and entity id.
     * The sort value is stored as a string; pass the raw JS value (string, number,
     * Date, or null). Dates are converted to ISO strings for timestamptz comparison.
     */
    public static encodeSortedCursor(sortValue: string | number | Date | null, entityId: string): string {
        let v: string | null;
        if (sortValue === null || sortValue === undefined) {
            v = null;
        } else if (sortValue instanceof Date) {
            v = sortValue.toISOString();
        } else {
            v = String(sortValue);
        }
        return Buffer.from(JSON.stringify({ v, id: entityId })).toString('base64');
    }

    /** Decode a composite sort cursor token. Returns `{v, id}`. */
    public static decodeSortedCursor(token: string): { v: string | null; id: string } {
        try {
            const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
            if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'string') {
                throw new Error('malformed cursor');
            }
            return { v: parsed.v ?? null, id: parsed.id };
        } catch {
            throw new Error(`Invalid sorted cursor token: "${token}"`);
        }
    }

    public sortBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        property: keyof ComponentDataType<T>,
        direction: SortDirection = "ASC",
        nullsFirst: boolean = false
    ): this {
        const componentName = componentCtor.name;
        const typeId = this.context.getComponentId(componentCtor);

        if (!typeId) {
            throw new Error(`Component ${componentName} is not registered.`);
        }

        // Validate that the component is required in this query
        if (!this.context.componentIds.has(typeId)) {
            throw new Error(`Cannot sort by component ${componentName} that is not included in the query. Use .with(${componentName}) first.`);
        }

        this.context.sortOrders.push({
            component: componentName,
            property: property as string,
            // SEC-03: normalized to the closed ASC/DESC set at the source so
            // no downstream ORDER BY emission can receive anything else.
            direction: normalizeSortDirection(direction),
            nullsFirst
        });

        return this;
    }

    /**
     * Sort by a native `entities`-table timestamp column (created_at /
     * updated_at). Needs no component and no `.with()` — the column always
     * exists on every entity and is a real indexed `timestamptz`, so this is
     * cheaper than duplicating the timestamp into a JSONB component and
     * sorting `data->>'...'`.
     *
     * Applied as an outer ORDER BY over the resolved id-set in doExec, so it
     * composes with any `.with()` / filter combination. Cursor pagination is
     * ignored when an entity sort is active (use .take()/.offset()).
     */
    public sortByEntityField(
        field: "created_at" | "updated_at",
        direction: SortDirection = "ASC",
        nullsFirst: boolean = false
    ): this {
        this.context.entitySortOrders.push({ field, direction, nullsFirst });
        return this;
    }

    /** Sort by entity creation time (`entities.created_at`). */
    public sortByCreatedAt(direction: SortDirection = "ASC", nullsFirst: boolean = false): this {
        return this.sortByEntityField("created_at", direction, nullsFirst);
    }

    /** Sort by entity last-update time (`entities.updated_at`). */
    public sortByUpdatedAt(direction: SortDirection = "ASC", nullsFirst: boolean = false): this {
        return this.sortByEntityField("updated_at", direction, nullsFirst);
    }

    public debugMode(enabled: boolean = true): this {
        this.debug = enabled;
        return this;
    }

    /**
     * Bypass cache for this query.
     * @param options Cache options to bypass. If not provided, bypasses prepared statement cache.
     * Note: the prepared-statement option is now a no-op (queries always
     * execute directly; Bun SQL handles statement preparation). The
     * `component` option still controls the component cache.
     */
    public noCache(): this;
    public noCache(options: QueryCacheOptions): this;
    public noCache(options?: QueryCacheOptions): this {
        // preparedStatement is ignored: Bun SQL prepares per connection.
        // The component option still bypasses the component cache.
        if (options?.component === true) {
            this.skipComponentCache = true;
        }
        return this;
    }

    /**
     * Run a terminal operation under the wall-clock query timeout.
     *
     * The timer CANCELS the in-flight statement (via `execSignal` →
     * `runWithSignal` → Bun SQL `query.cancel()`) before rejecting. Rejecting
     * alone leaves the query running server-side, holding a pooled backend
     * and its locks after the caller has given up — the failure mode that
     * turns a DB slowdown into pool exhaustion behind pgbouncer.
     *
     * A caller-supplied `signal` is linked in, and `execSignal` is restored
     * on settle so a reusable Query instance is not left holding a fired
     * signal. `execSignal` is instance state (as it already was via
     * applyExecOptions), so two terminal calls running CONCURRENTLY on the
     * same Query instance share one signal — a timeout in either cancels
     * both. Run concurrent terminals on separate Query instances.
     */
    private runWithTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const restoreSignal = this.execSignal;
        const unlinkCaller = linkAbortSignals(restoreSignal, controller);
        this.execSignal = controller.signal;

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`${label} timeout`);
                const err = new Error(`${label} timeout after ${QUERY_TIMEOUT_MS / 1000} seconds`);
                controller.abort(err);
                reject(err);
            }, QUERY_TIMEOUT_MS);
            // unref: at high QPS thousands of these are live concurrently;
            // they must not hold the event loop open nor add ref'd-timer churn.
            (timeout as unknown as { unref?: () => void }).unref?.();

            const cleanup = () => {
                clearTimeout(timeout);
                unlinkCaller();
                this.execSignal = restoreSignal;
            };

            run()
                .then(result => {
                    cleanup();
                    resolve(result);
                })
                .catch(error => {
                    cleanup();
                    reject(error);
                });
        });
    }

    public count(opts?: QueryExecOptions): Promise<number> {
        this.applyExecOptions(opts);
        return this.runWithTimeout('Query count execution', () => this.doCount());
    }

    /**
     * Apply terminal-method options to instance fields so internal helpers
     * (doCount, doExec, populateComponents, doAggregate, …) can read them
     * without threading parameters through every private method.
     */
    private applyExecOptions(opts?: QueryExecOptions): void {
        if (!opts) return;
        if (opts.signal !== undefined) this.execSignal = opts.signal;
        if (opts.perRequest !== undefined) this.execPerRequest = opts.perRequest;
    }

    /**
     * Get an estimated count using PostgreSQL statistics.
     * Much faster than exact count() for large tables - O(1) instead of O(n).
     * 
     * Note: Returns approximate count based on PostgreSQL's statistics.
     * Run ANALYZE on the table for more accurate estimates.
     * 
     * @param component - The component class to count (uses its partition table)
     * @returns Estimated count (may be up to 10% off for recently modified tables)
     * 
     * @example
     * // Fast approximate count
     * const approxCount = await new Query().with(User).estimatedCount(User);
     * console.log(`Approximately ${approxCount} users`);
     */
    public async estimatedCount(component: new (...args: any[]) => BaseComponent, opts?: QueryExecOptions): Promise<number> {
        this.applyExecOptions(opts);
        const typeId = ComponentRegistry.getComponentId(component.name);
        if (!typeId) {
            throw new Error(`Component ${component.name} not registered`);
        }

        // Validate the resolved partition table name against the component
        // table allow-list before passing to pg_class lookup. Although
        // `relname` here is a bound parameter ($1) and cannot inject SQL
        // directly, we still reject unexpected names so a registry
        // poisoning bug cannot query arbitrary tables.
        const rawTableName = ComponentRegistry.getPartitionTableName(typeId);
        const tableName = rawTableName ? assertComponentTableName(rawTableName, 'estimatedCount.tableName') : null;
        const dbConn = this.getDb();

        // Use PostgreSQL's statistics for fast count estimate
        // This queries pg_class which is O(1) instead of scanning the table.
        // When the component resolves to a specific partition table, read its
        // reltuples directly. Otherwise fall back to the membership source:
        // legacy reads `entity_components` reltuples; the components source
        // sums the LIST-partition child stats (the partitioned parent's
        // reltuples is unreliable).
        let sql: string;
        let params: any[];
        if (tableName && tableName !== 'components') {
            sql = `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = $1`;
            params = [tableName];
        } else if (getMembershipSource().isLegacy) {
            sql = `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'entity_components'`;
            params = [];
        } else {
            // No COALESCE: an empty partition set must yield NULL so the
            // exact-count fallback below triggers, matching the legacy
            // zero-rows behavior.
            sql = `SELECT SUM(c.reltuples)::bigint AS estimate
                   FROM pg_class c
                   JOIN pg_inherits i ON c.oid = i.inhrelid
                   WHERE i.inhparent = 'components'::regclass`;
            params = [];
        }

        const result = await this.execSql<any[]>('query.exec', dbConn, sql, params, this.execSignal, this.execPerRequest);

        if (!result || result.length === 0 || result[0].estimate === null) {
            // Fallback to exact count if statistics not available
            return this.count();
        }

        return Number(result[0].estimate);
    }

    private async doCount(): Promise<number> {
        // Fresh params for re-execution. doExec/doAggregate already reset;
        // missing here meant stale params (wrong bindings) on Query reuse.
        this.context.reset();

        // count() must return total matching cardinality. Pagination and
        // sort must not leak into the counted subquery — a LIMIT inside the
        // subquery caps the count (after a prior exec() the framework
        // default LIMIT silently capped every count at
        // BUNSANE_DEFAULT_QUERY_LIMIT), and ORDER BY is wasted work under
        // COUNT(*). Save/restore so exec() after count() behaves unchanged.
        const savedLimit = this.context.limit;
        const savedOffset = this.context.offsetValue;
        const savedSorts = this.context.sortOrders;
        this.context.limit = null;
        this.context.offsetValue = 0;
        this.context.sortOrders = [];
        try {
            return await this.doCountInner();
        } finally {
            this.context.limit = savedLimit;
            this.context.offsetValue = savedOffset;
            this.context.sortOrders = savedSorts;
        }
    }

    private async doCountInner(): Promise<number> {
        // QSP: resolve coverage once. Route only when READY; shadow-compare in SHADOW.
        let qspReq: CoverageRequest | undefined;
        let qspRes: PlanResolution | undefined;
        if (qspActive() && !this.orQuery) {
            qspReq = buildCoverageRequest(this.context);
            qspRes = SurfacePlanner.instance.resolve(qspReq);
            if (qspMode() === 'route' && qspRes.surface === 'rm' && qspRes.archetype && qspRes.status === 'READY') {
                try {
                    return await this.doCountRouted(qspRes.archetype, qspReq);
                } catch (err) {
                    recordFallback('count_error');
                    logger.warn({ scope: 'qsp.route.fallback', archetype: qspRes.archetype, err }, 'QSP route count fallback to legacy');
                    // fall through to legacy below
                }
            }
            if (qspRes.triggerArchetype) {
                void ProjectionManager.instance.ensureProjection(qspRes.triggerArchetype);
            }
        }
        this._lastRouteInfo = { routed: false, surface: 'legacy' };

        const result = this.buildIdSelect();

        // Modify SQL for count
        const countSql = `SELECT COUNT(*) as count FROM (${result.sql}) AS subquery`;

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Execute directly. Bun SQL auto-prepares parameterized statements
        // per connection (prepare:true default) — the former framework-level
        // "prepared statement cache" never called a prepare API and only
        // added cache-key string building on the hot path.
        const countResult: any[] = await this.execSql<any[]>('query.count', dbConn, countSql, result.params, this.execSignal, this.execPerRequest);

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Count Debug:');
            console.log('SQL:', countSql);
            console.log('Params:', result.params);
            console.log('Component Cache Bypass:', this.skipComponentCache);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Empty-string params are legitimate for text-field filters
        // (`c.data->>'field' = ''`). UUID-typed params never reach this
        // point empty — findById guards at entry; cursor/excluded IDs come
        // from saved entities. PG emits a clear error if a UUID cast meets
        // an empty string at execution time.

        // Safely extract count from result - handle undefined/null cases
        if (!countResult || countResult.length === 0 || countResult[0] === undefined) {
            return 0;
        }

        // PostgreSQL COUNT(*) returns a value, handle both string and number
        const count = countResult[0].count;
        if (count === undefined || count === null) {
            return 0;
        }
        const finalCount = typeof count === 'string' ? parseInt(count, 10) : Number(count);
        if (qspReq && qspRes) {
            const m = qspMode();
            const shouldShadow = (m === 'shadow' && qspRes.surface === 'rm') || (m === 'route' && qspRes.status === 'SHADOW');
            if (shouldShadow) {
                try { shadowRunCount(qspReq, finalCount); } catch { /* shadow must never affect the served path */ }
            }
        }
        return finalCount;
    }

    /**
     * Calculate the sum of a numeric field across all matching entities.
     * The component must be included in the query via .with().
     * @param componentCtor The component class containing the field
     * @param field The field name to sum (must be numeric)
     * @returns Promise resolving to the sum, or 0 if no matches
     */
    public sum<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>
    ): Promise<number> {
        return this.runWithTimeout('Query sum execution', () => this.doAggregate('SUM', componentCtor, field as string));
    }

    /**
     * Calculate the average of a numeric field across all matching entities.
     * The component must be included in the query via .with().
     * @param componentCtor The component class containing the field
     * @param field The field name to average (must be numeric)
     * @returns Promise resolving to the average, or 0 if no matches
     */
    public average<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>
    ): Promise<number> {
        return this.runWithTimeout('Query average execution', () => this.doAggregate('AVG', componentCtor, field as string));
    }

    /**
     * One id-select assembly for count, group-by, aggregate, exec, and explain.
     * Does not reset the context — callers own param lifetime.
     */
    private buildIdSelect(): { sql: string; params: unknown[] } {
        const dag = new QueryDAG();
        if (this.orQuery) {
            if (this.context.componentIds.size > 0) {
                const componentNode = new ComponentInclusionNode();
                dag.setRootNode(componentNode);
                const orNode = new OrNode(this.orQuery);
                orNode.addDependency(componentNode);
                dag.addNode(orNode);
            } else {
                const orNode = new OrNode(this.orQuery);
                dag.setRootNode(orNode);
            }
        } else {
            const optimizedDag = QueryDAG.buildBasicQuery(this.context);
            for (const node of optimizedDag.getNodes()) {
                dag.addNode(node);
            }
            const root = optimizedDag.getRootNode();
            if (root) dag.setRootNode(root);
        }
        const result = dag.execute(this.context);
        return { sql: result.sql, params: result.params };
    }

    private compileMembershipSql(): { sql: string; params: unknown[] } {
        this.context.reset();
        if (this.orQuery) {
            throw new Error("Query.groupBy cannot be combined with OR queries");
        }
        return this.buildIdSelect();
    }

    private membershipExists(
        entityIdSql: string,
        typeId: string,
        filters: ReadonlyArray<{ field: string; operator: string; value: unknown }> | undefined,
    ): string {
        const legacy = getMembershipSource().isLegacy;
        const typeIdx = this.context.addParam(typeId);
        if (legacy) {
            let sql = `EXISTS (SELECT 1 FROM entity_components p WHERE p.entity_id = ${entityIdSql} AND p.type_id = $${typeIdx}::text AND p.deleted_at IS NULL)`;
            if (filters && filters.length > 0) {
                const raw = shouldUseDirectPartition()
                    ? (ComponentRegistry.getPartitionTableName(typeId) || "components")
                    : "components";
                const dataTable = assertComponentTableName(raw, "entitySort.dataTable");
                const dataTypeIdx = this.context.addParam(typeId);
                const group = buildComponentFilterGroup([...filters], "d", this.context);
                sql += ` AND EXISTS (SELECT 1 FROM ${dataTable} d WHERE d.entity_id = ${entityIdSql} AND d.type_id = $${dataTypeIdx}::text AND d.deleted_at IS NULL${group ? ` AND ${group}` : ""})`;
            }
            return sql;
        }
        const raw = shouldUseDirectPartition()
            ? (ComponentRegistry.getPartitionTableName(typeId) || "components")
            : "components";
        const table = assertComponentTableName(raw, "entitySort.table");
        const group = filters && filters.length > 0
            ? buildComponentFilterGroup([...filters], "p", this.context)
            : null;
        return `EXISTS (SELECT 1 FROM ${table} p WHERE p.entity_id = ${entityIdSql} AND p.type_id = $${typeIdx}::text AND p.deleted_at IS NULL${group ? ` AND ${group}` : ""})`;
    }

    /**
     * Entity-column sort driven by `entities` (index scan) with correlated
     * membership probes. Does not materialize the unbounded id set.
     */
    private buildEntityDrivenSortSql(): { sql: string; params: unknown[] } {
        const sorts = this.context.entitySortOrders;
        const cursor = this.context.compositeCursor;
        if (cursor && sorts.length > 1) {
            throw new Error(
                "sortedCursor() does not support multi-key entity sorts. " +
                "Only a single sortByCreatedAt() or sortByUpdatedAt() is supported with composite keyset pagination."
            );
        }

        const clauses: string[] = [];
        const hasMembership =
            this.context.componentIds.size > 0 ||
            this.orQuery !== null ||
            this.context.excludedComponentIds.size > 0;
        if (!hasMembership) {
            clauses.push("e.deleted_at IS NULL");
        }

        for (const typeId of this.context.componentIds) {
            clauses.push(this.membershipExists("e.id", typeId, this.context.componentFilters.get(typeId)));
        }
        if (this.orQuery) {
            const ors: string[] = [];
            for (const branch of this.orQuery.branches) {
                const typeId = this.context.getComponentId(branch.component);
                if (!typeId) {
                    throw new Error(`Component ${branch.component.name} is not registered.`);
                }
                ors.push(this.membershipExists("e.id", typeId, branch.filters));
            }
            clauses.push(`(${ors.join(" OR ")})`);
        }
        if (this.context.excludedComponentIds.size > 0) {
            const ids = Array.from(this.context.excludedComponentIds);
            const placeholders = ids.map((id) => `$${this.context.addParam(id)}`).join(", ");
            const table = getMembershipSource().isLegacy ? "entity_components" : "components";
            clauses.push(
                `NOT EXISTS (SELECT 1 FROM ${table} ex WHERE ex.entity_id = e.id AND ex.type_id IN (${placeholders}) AND ex.deleted_at IS NULL)`
            );
        }
        if (this.context.withId) {
            clauses.push(`e.id = $${this.context.addParam(this.context.withId)}`);
        }
        if (this.context.excludedEntityIds.size > 0) {
            const ids = Array.from(this.context.excludedEntityIds);
            const placeholders = ids.map((id) => `$${this.context.addParam(id)}`).join(", ");
            clauses.push(`e.id NOT IN (${placeholders})`);
        }

        const isBefore = cursor !== null && this.context.cursorDirection === "before";
        if (isBefore) this.reverseSortedPage = true;

        if (cursor) {
            const sort = sorts[0]!;
            const rawCol = sort.field === "updated_at" ? "e.updated_at" : "e.created_at";
            const truncCol = `date_trunc('milliseconds', ${rawCol})`;
            const direction: SortDirection = isBefore
                ? (sort.direction === "DESC" ? "ASC" : "DESC")
                : sort.direction;
            const nullsFirst = isBefore ? !sort.nullsFirst : !!sort.nullsFirst;
            if (cursor.v === null && !isBefore) {
                clauses.push("FALSE");
            } else {
                const fragment = buildKeysetCursorWhere({
                    sortExpr: truncCol,
                    entityIdCol: "e.id",
                    connective: "AND",
                    direction,
                    nullsFirst,
                    valueCast: "::timestamptz",
                    cursor,
                    addParam: (value) => this.context.addParam(value),
                    idDirection: isBefore ? "DESC" : "ASC",
                });
                clauses.push(fragment.replace(/^\s*(WHERE|AND)\s+/i, ""));
            }
        }

        const orderParts = sorts.map((s) => {
            const rawCol = s.field === "updated_at" ? "e.updated_at" : "e.created_at";
            const col = cursor ? `date_trunc('milliseconds', ${rawCol})` : rawCol;
            let dir: SortDirection = s.direction;
            let nullsFirst = !!s.nullsFirst;
            if (isBefore) {
                dir = dir === "DESC" ? "ASC" : "DESC";
                nullsFirst = !nullsFirst;
            }
            const nulls = nullsFirst ? "NULLS FIRST" : "NULLS LAST";
            return `${col} ${dir} ${nulls}`;
        });
        const idDir: SortDirection = isBefore ? "DESC" : "ASC";

        let sql = "SELECT e.id FROM entities e";
        if (clauses.length > 0) {
            sql += ` WHERE ${clauses.join(" AND ")}`;
        }
        sql += ` ORDER BY ${orderParts.join(", ")}, e.id ${idDir}`;
        if (this.context.limit !== null) {
            sql += ` LIMIT $${this.context.addParam(this.context.limit)}`;
        }
        if (!cursor && this.context.offsetValue > 0) {
            sql += ` OFFSET $${this.context.addParam(this.context.offsetValue)}`;
        }
        return { sql, params: this.context.params };
    }

    /**
     * OR + component sortBy: inner id-set, then JOIN the sort component.
     * Non-OR component sort stays in ComponentInclusionNode (leaf scan).
     */
    private buildOrComponentSortSql(): { sql: string; params: unknown[] } {
        const componentSorts = this.context.sortOrders;
        const savedLimit = this.context.limit;
        const savedOffset = this.context.offsetValue;
        const savedCursorId = this.context.cursorId;
        const savedComposite = this.context.compositeCursor;
        const savedSuppress = this.context.suppressNodeOrdering;
        const savedSorts = this.context.sortOrders;
        this.context.limit = null;
        this.context.offsetValue = 0;
        this.context.cursorId = null;
        this.context.compositeCursor = null;
        this.context.suppressNodeOrdering = true;
        this.context.sortOrders = [];
        let result: { sql: string; params: unknown[] };
        try {
            result = this.buildIdSelect();
        } finally {
            this.context.limit = savedLimit;
            this.context.offsetValue = savedOffset;
            this.context.cursorId = savedCursorId;
            this.context.compositeCursor = savedComposite;
            this.context.suppressNodeOrdering = savedSuppress;
            this.context.sortOrders = savedSorts;
        }

        if (savedComposite && componentSorts.length > 1) {
            throw new Error(
                "sortedCursor() does not support multi-key sorts. " +
                "Only a single sortBy() key is supported with composite keyset pagination on OR queries."
            );
        }

        const joins: string[] = [];
        const orderClauses: string[] = [];
        const isBefore = savedComposite !== null && this.context.cursorDirection === "before";
        if (isBefore) this.reverseSortedPage = true;

        componentSorts.forEach((s, i) => {
            const sortTypeId = ComponentRegistry.getComponentId(s.component);
            if (!sortTypeId) {
                throw new Error(`Component ${s.component} is not registered.`);
            }
            const table = shouldUseDirectPartition()
                ? (ComponentRegistry.getPartitionTableName(sortTypeId) || "components")
                : "components";
            const safeTable = assertComponentTableName(table, "orSort.componentTable");
            const alias = `s${i}`;
            const typeParamIdx = this.context.addParam(sortTypeId);
            joins.push(
                `JOIN ${safeTable} ${alias} ON ${alias}.entity_id = base.id ` +
                `AND ${alias}.type_id = $${typeParamIdx} AND ${alias}.deleted_at IS NULL`
            );
            const safeProp = assertIdentifier(s.property, "sortOrder.property");
            const numeric = isNumericProperty(s.component, s.property);
            const expr = numeric
                ? `(${alias}.data->>'${safeProp}')::numeric`
                : `${alias}.data->>'${safeProp}'`;
            let dir: SortDirection = s.direction;
            let nullsFirst = !!s.nullsFirst;
            if (isBefore && i === 0) {
                dir = dir === "DESC" ? "ASC" : "DESC";
                nullsFirst = !nullsFirst;
            }
            const nulls = nullsFirst ? "NULLS FIRST" : "NULLS LAST";
            orderClauses.push(`${expr} ${dir} ${nulls}`);
        });

        let whereClause = "";
        if (savedComposite) {
            const s = componentSorts[0]!;
            if (s.nullsFirst && !isBefore) {
                throw new Error(
                    "sortedCursor() does not support NULLS FIRST sorts. " +
                    "Use the default (NULLS LAST) or OFFSET pagination."
                );
            }
            const safeProp = assertIdentifier(s.property, "sortOrder.property");
            const numeric = isNumericProperty(s.component, s.property);
            const expr = numeric
                ? `(s0.data->>'${safeProp}')::numeric`
                : `s0.data->>'${safeProp}'`;
            const direction: SortDirection = isBefore
                ? (s.direction === "DESC" ? "ASC" : "DESC")
                : s.direction;
            const nullsFirst = isBefore ? !s.nullsFirst : !!s.nullsFirst;
            whereClause = buildKeysetCursorWhere({
                sortExpr: expr,
                entityIdCol: "base.id",
                connective: "WHERE",
                direction,
                nullsFirst,
                valueCast: numeric ? "::numeric" : "::text",
                cursor: savedComposite,
                addParam: (value) => this.context.addParam(value),
                idDirection: isBefore ? "DESC" : "ASC",
            });
        }

        const idDir: SortDirection = isBefore ? "DESC" : "ASC";
        let wrapped = `SELECT base.id FROM (${result.sql}) AS base ${joins.join(" ")}${whereClause} ORDER BY ${orderClauses.join(", ")}, base.id ${idDir}`;
        if (savedLimit !== null) {
            wrapped += ` LIMIT $${this.context.addParam(savedLimit)}`;
        }
        if (!savedComposite && savedOffset > 0) {
            wrapped += ` OFFSET $${this.context.addParam(savedOffset)}`;
        }
        return { sql: wrapped, params: this.context.params };
    }


    private partitionTable(typeId: string, ctx: string): string {
        const raw = shouldUseDirectPartition()
            ? ComponentRegistry.getPartitionTableName(typeId) || "components"
            : "components";
        return assertComponentTableName(raw, ctx);
    }

    private groupKeyName(): string {
        return this.groupBySpec?.trunc ? "bucket" : this.groupBySpec!.field;
    }

    private groupSqlExpr(alias: string, nextParam: () => number): { expr: string; params: unknown[] } {
        const spec = this.groupBySpec!;
        const json = `${alias}.data->>'${spec.field}'`;
        if (!spec.trunc) {
            return { expr: json, params: [] };
        }
        const idx = nextParam();
        const ts = `NULLIF(${json}, '')::timestamptz`;
        return {
            expr: sqlTimeBucketFromTs(ts, spec.trunc, `$${idx}`),
            params: [spec.tzOffsetMinutes],
        };
    }

    private async doCountBy(): Promise<Array<Record<string, unknown>>> {
        const spec = this.groupBySpec!;
        const savedLimit = this.context.limit;
        const savedOffset = this.context.offsetValue;
        const savedSorts = this.context.sortOrders;
        this.context.limit = null;
        this.context.offsetValue = 0;
        this.context.sortOrders = [];
        try {
            const membership = this.compileMembershipSql();
            const params: unknown[] = [...membership.params];
            const typeId = this.context.getComponentId(spec.ctor)!;
            const table = this.partitionTable(typeId, "countBy.table");
            params.push(typeId);
            const typeIdx = params.length;
            const { expr, params: gParams } = this.groupSqlExpr("g", () => {
                params.push(undefined);
                return params.length;
            });
            if (gParams.length > 0) {
                params[params.length - 1] = gParams[0];
            }
            const key = this.groupKeyName();
            const sql = `SELECT ${expr} AS "${key}", COUNT(*)::int AS count
                         FROM (${membership.sql}) AS entity_subq
                         JOIN ${table} g ON g.entity_id = entity_subq.id
                         WHERE g.type_id = $${typeIdx}
                           AND g.deleted_at IS NULL
                         GROUP BY 1`;
            const rows = await this.execSql<any[]>(
                "query.countBy",
                this.getDb(),
                sql,
                params as any[],
                this.execSignal,
                this.execPerRequest
            );
            return (rows ?? []).map((r) => ({
                [key]: r[key],
                count: r.count == null ? 0 : Number(r.count),
            }));
        } finally {
            this.context.limit = savedLimit;
            this.context.offsetValue = savedOffset;
            this.context.sortOrders = savedSorts;
        }
    }

    private jsonTextExpr(alias: string, field: string, ctx: string): string {
        assertFieldPath(field, ctx);
        if (field.includes(".")) {
            const parts = field.split(".");
            const last = parts.pop()!;
            const nested = parts.map((p) => `'${p}'`).join("->");
            return `${alias}.data->${nested}->>'${last}'`;
        }
        return `${alias}.data->>'${field}'`;
    }

    private async doSumBy(
        metricCtor: new (...args: any[]) => BaseComponent,
        field: string
    ): Promise<Array<Record<string, unknown>>> {
        const jsonPath = this.jsonTextExpr("c", field, "sumBy.field");
        return this.doGroupAgg(
            metricCtor,
            field,
            `COALESCE(SUM((${jsonPath})::numeric), 0)::numeric`,
            "query.sumBy",
            (v) => (v == null ? 0 : Number(v))
        );
    }

    private async doMinMaxBy(
        fn: "MAX" | "MIN",
        metricCtor: new (...args: any[]) => BaseComponent,
        field: string,
        cast: GroupAggCast
    ): Promise<Array<Record<string, unknown>>> {
        const jsonPath = this.jsonTextExpr("c", field, `${fn.toLowerCase()}By.field`);
        let metricSql: string;
        let coerce: (v: unknown) => unknown;
        if (cast === "numeric") {
            metricSql = `${fn}((${jsonPath})::numeric)`;
            coerce = (v) => (v == null ? 0 : Number(v));
        } else if (cast === "text") {
            metricSql = `${fn}(${jsonPath})`;
            coerce = (v) => v ?? null;
        } else {
            metricSql = `${fn}(NULLIF(${jsonPath}, '')::timestamptz)`;
            coerce = (v) => {
                if (v == null) return null;
                if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
                const d = new Date(String(v));
                return Number.isNaN(d.getTime()) ? null : d;
            };
        }
        return this.doGroupAgg(metricCtor, field, metricSql, `query.${fn.toLowerCase()}By`, coerce);
    }

    private async doAvgIntervalMinutesBy(
        metricCtor: new (...args: any[]) => BaseComponent,
        startField: string,
        endField: string
    ): Promise<Array<Record<string, unknown>>> {
        const start = this.jsonTextExpr("c", startField, "avgIntervalMinutesBy.startField");
        const end = this.jsonTextExpr("c", endField, "avgIntervalMinutesBy.endField");
        const metricSql = `AVG(EXTRACT(EPOCH FROM (NULLIF(${end}, '')::timestamptz - NULLIF(${start}, '')::timestamptz)) / 60.0)`;
        return this.doGroupAgg(
            metricCtor,
            "avgIntervalMinutes",
            metricSql,
            "query.avgIntervalMinutesBy",
            (v) => (v == null ? 0 : Number(v))
        );
    }

    private async doGroupAgg(
        metricCtor: new (...args: any[]) => BaseComponent,
        resultField: string,
        metricSql: string,
        logName: string,
        coerce: (value: unknown) => unknown
    ): Promise<Array<Record<string, unknown>>> {
        const spec = this.groupBySpec!;
        const metricTypeId = this.context.getComponentId(metricCtor);
        if (!metricTypeId) {
            throw new Error(`Component ${metricCtor.name} is not registered.`);
        }
        if (!this.context.componentIds.has(metricTypeId)) {
            throw new Error(
                `Cannot aggregate on component ${metricCtor.name} that is not included in the query.`
            );
        }
        const savedLimit = this.context.limit;
        const savedOffset = this.context.offsetValue;
        const savedSorts = this.context.sortOrders;
        this.context.limit = null;
        this.context.offsetValue = 0;
        this.context.sortOrders = [];
        try {
            const membership = this.compileMembershipSql();
            const params: unknown[] = [...membership.params];
            const groupTypeId = this.context.getComponentId(spec.ctor)!;
            const same = groupTypeId === metricTypeId;
            const metricTable = this.partitionTable(metricTypeId, `${logName}.metricTable`);
            params.push(metricTypeId);
            const metricTypeIdx = params.length;
            let groupAlias = "c";
            let extraJoin = "";
            if (!same) {
                const groupTable = this.partitionTable(groupTypeId, `${logName}.groupTable`);
                params.push(groupTypeId);
                const groupTypeIdx = params.length;
                extraJoin = `JOIN ${groupTable} g ON g.entity_id = entity_subq.id AND g.type_id = $${groupTypeIdx} AND g.deleted_at IS NULL`;
                groupAlias = "g";
            }
            const { expr, params: gParams } = this.groupSqlExpr(groupAlias, () => {
                params.push(undefined);
                return params.length;
            });
            if (gParams.length > 0) {
                params[params.length - 1] = gParams[0];
            }
            const key = this.groupKeyName();
            const sql = `SELECT ${expr} AS "${key}", ${metricSql} AS "${resultField}"
                         FROM (${membership.sql}) AS entity_subq
                         JOIN ${metricTable} c ON c.entity_id = entity_subq.id
                         ${extraJoin}
                         WHERE c.type_id = $${metricTypeIdx}
                           AND c.deleted_at IS NULL
                         GROUP BY 1`;
            const rows = await this.execSql<any[]>(
                logName,
                this.getDb(),
                sql,
                params as any[],
                this.execSignal,
                this.execPerRequest
            );
            return (rows ?? []).map((r) => ({
                [key]: r[key],
                [resultField]: coerce(r[resultField]),
            }));
        } finally {
            this.context.limit = savedLimit;
            this.context.offsetValue = savedOffset;
            this.context.sortOrders = savedSorts;
        }
    }

    /**
     * Internal method to perform aggregate operations (SUM, AVG) on component fields.
     * Uses an optimized single-pass approach by joining to the component table
     * directly within the CTE-based query.
     */
    private async doAggregate(
        aggregateType: 'SUM' | 'AVG',
        componentCtor: new (...args: any[]) => BaseComponent,
        field: string
    ): Promise<number> {
        // Get the component type ID
        const typeId = this.context.getComponentId(componentCtor);
        if (!typeId) {
            throw new Error(`Component ${componentCtor.name} is not registered.`);
        }

        // Validate that the component is in the query
        if (!this.context.componentIds.has(typeId)) {
            throw new Error(
                `Cannot aggregate on component ${componentCtor.name} that is not included in the query. ` +
                `Use .with(${componentCtor.name}) first.`
            );
        }

        // Reset context for fresh execution
        this.context.reset();

        const result = this.buildIdSelect();

        // Determine the component table name. Validate against allow-list so
        // a poisoned registry cannot inject SQL through the embedded name.
        const rawComponentTableName = shouldUseDirectPartition()
            ? (ComponentRegistry.getPartitionTableName(typeId) || 'components')
            : 'components';
        const componentTableName = assertComponentTableName(rawComponentTableName, 'doAggregate.componentTableName');

        // Validate the field path — each dotted segment must be a safe
        // identifier. Without this, a caller-supplied field with quote or
        // `->` metacharacters would corrupt the JSON path expression (C08).
        assertFieldPath(field, 'doAggregate.field');

        // Build the JSON path for the field
        let jsonPath: string;
        if (field.includes('.')) {
            const parts = field.split('.');
            const lastPart = parts.pop()!;
            const nestedPath = parts.map(p => `'${p}'`).join('->');
            jsonPath = `c.data->${nestedPath}->>'${lastPart}'`;
        } else {
            jsonPath = `c.data->>'${field}'`;
        }

        // Add the type_id parameter for the JOIN condition
        const typeIdParamIndex = this.context.addParam(typeId);

        // Build aggregate SQL by wrapping the entity query as a subquery
        // This approach works consistently regardless of CTE usage
        // The base query returns entity_id (aliased as 'id'), which we join to components
        const aggregateSql = `
SELECT ${aggregateType}((${jsonPath})::numeric) as result
FROM (${result.sql}) AS entity_subq
JOIN ${componentTableName} c ON c.entity_id = entity_subq.id
WHERE c.type_id = $${typeIdParamIndex}
AND c.deleted_at IS NULL`;

        // Get the database connection
        const dbConn = this.getDb();

        // Direct execution — see doCountInner for why the framework-level
        // prepared statement cache was removed from the hot path.
        const aggregateResult: any[] = await this.execSql<any[]>('query.aggregate', dbConn, aggregateSql, result.params, this.execSignal, this.execPerRequest);

        // Debug logging
        if (this.debug) {
            console.log(`🔍 Query ${aggregateType} Debug:`);
            console.log('SQL:', aggregateSql);
            console.log('Params:', result.params);
            console.log('Component:', componentCtor.name);
            console.log('Field:', field);
            console.log('---');
        }

        // Empty-string params are legitimate for text-field filters; see
        // comment above in doCount.

        // Extract result
        if (!aggregateResult || aggregateResult.length === 0 || aggregateResult[0] === undefined) {
            return 0;
        }

        const value = aggregateResult[0].result;
        if (value === undefined || value === null) {
            return 0;
        }
        return typeof value === 'string' ? parseFloat(value) : Number(value);
    }

    /**
     * Execute the query and return typed entities.
     *
     * `componentData` is fully loaded only when `.populate()` was called.
     * Otherwise each component property is optional.
     */
    @timed("Query.exec")
    public async exec(opts?: QueryExecOptions): Promise<TypedEntity<TComponents, TPopulated>[]> {
        this.applyExecOptions(opts);
        // Apply default LIMIT so unbounded queries cannot load entire tables.
        // Configurable via BUNSANE_DEFAULT_QUERY_LIMIT, 0 to disable.
        // Production warns once. Development throws after the fetch if the
        // cap actually binds (returned row count equals the cap).
        this.appliedDefaultLimit = false;
        if (this.context.limit === null || this.context.limit === undefined) {
            const cap = currentDefaultQueryLimit();
            if (cap > 0) {
                this.context.limit = cap;
                this.appliedDefaultLimit = true;
                if (!warnedDefaultLimit) {
                    warnedDefaultLimit = true;
                    logger.warn({ scope: 'Query.exec', defaultLimit: cap }, 'Query executed without explicit .take() — applying framework default LIMIT. Call .take(N) to suppress this warning.');
                }
            }
        }

        return this.runWithTimeout('Query execution', async () => {
            const result = await this.doExec();
            if (this._lastRouteInfo.truncatedByDefaultLimit && isVerboseErrors()) {
                const cap = currentDefaultQueryLimit();
                throw new Error(
                    `Query.exec() filled the framework default cap of ${cap} rows (BUNSANE_DEFAULT_QUERY_LIMIT) without .take(). ` +
                    `The result is truncated. Call .take(n) to page. ` +
                    `In production this is a one-time warning and getLastRouteInfo().truncatedByDefaultLimit is true.`
                );
            }
            return result.map(e => this.wrapTypedEntity(e));
        });
    }

    /**
     * Wrap an entity with typed accessors for components in this query.
     * `componentData` only contains rows `.populate()` (or a prior in-memory add) loaded.
     */
    private wrapTypedEntity(entity: Entity): TypedEntity<TComponents, TPopulated> {
        const componentCtors = this._componentCtors;

        const componentData: Record<string, unknown> = {};
        for (const ctor of componentCtors) {
            const comp = entity.getInMemory(ctor);
            if (comp) {
                componentData[ctor.name] = comp.data();
            }
        }

        const typedEntity = entity as TypedEntity<TComponents, TPopulated>;
        Object.assign(typedEntity, { componentData });

        queriedComponentsDescriptor.value = componentCtors as unknown as TComponents;
        Object.defineProperty(typedEntity, '_queriedComponents', queriedComponentsDescriptor);
        queriedComponentsDescriptor.value = undefined;

        Object.defineProperty(typedEntity, 'getTyped', getTypedDescriptor);

        return typedEntity;
    }

    /**
     * QSP route mode: serve SELECT entity_id from rm_<archetype>.
     * Fetches limit+1 when limit is set so hasNextPage can be reported without a second query.
     * Hydration mirrors the legacy doExec tail (populate / eager load).
     */
    private async doExecRouted(archetype: string, req: CoverageRequest): Promise<Entity[]> {
        const n = req.limit;
        let fetchReq = req;
        if (n !== null) {
            fetchReq = { ...req, limit: n + 1 };
        }

        // Columns needed to rebuild components from the row itself. Fetched only when hydration
        // is actually enabled — otherwise the SELECT stays exactly as narrow as before.
        const plan = qspHydrate() ? this.resolveRoutedHydrationPlan(archetype) : EMPTY_HYDRATION_PLAN;

        const { sql, params } = buildRmQuery(archetype, fetchReq, plan.columns);
        const dbConn = this.getDb();
        const rows = await this.execSql<any[]>('query.rm.route', dbConn, sql, params, this.execSignal, this.execPerRequest);

        let resultRows: any[] = rows;
        let entityIds: string[] = rows.map((r: any) => r.entity_id);
        let hasNextPage = false;
        if (n !== null && entityIds.length > n) {
            hasNextPage = true;
            entityIds = entityIds.slice(0, n);
            resultRows = rows.slice(0, n); // rows stay index-aligned with entityIds
        }

        recordRoute(archetype);
        this._lastRouteInfo = {
            routed: true,
            surface: 'rm',
            archetype,
            hasNextPage,
            ...(this.appliedDefaultLimit && currentDefaultQueryLimit() > 0 && entityIds.length >= currentDefaultQueryLimit()
                ? { truncatedByDefaultLimit: true }
                : {}),
        };

        if (entityIds.length === 0) {
            return [];
        }

        return this.hydrateEntityIds(entityIds, resultRows, plan);
    }

    /**
     * QSP route mode count via rm_.
     * - exact (default) / n_plus_1: count(*) — n_plus_1's "no second query" benefit is
     *   realized at exec-time via hasNextPage; a bare .count() has no page so returns exact.
     * - estimate: EXPLAIN (FORMAT JSON) Plan Rows on the filter SELECT.
     */
    private async doCountRouted(archetype: string, req: CoverageRequest): Promise<number> {
        const dbConn = this.getDb();
        const strat = qspCountStrategy();

        if (strat === 'estimate') {
            const { sql, params } = buildRmEstimateQuery(archetype, req);
            const plan = await this.execSql<any[]>('query.rm.estimate', 
                dbConn,
                `EXPLAIN (FORMAT JSON) ${sql}`,
                params,
                this.execSignal,
                this.execPerRequest
            );
            const rowsEst = extractExplainPlanRows(plan);
            recordRoute(archetype);
            this._lastRouteInfo = { routed: true, surface: 'rm', archetype };
            return rowsEst;
        }

        // 'exact' (default) AND 'n_plus_1' for a bare count() both use exact count(*).
        const { sql, params } = buildRmCountQuery(archetype, req);
        const rows = await this.execSql<any[]>('query.rm.rows', dbConn, sql, params, this.execSignal, this.execPerRequest);
        recordRoute(archetype);
        this._lastRouteInfo = { routed: true, surface: 'rm', archetype };
        return Number(rows[0]?.count ?? 0);
    }

    /**
     * Hydration plan for a routed query. Returns the empty plan (row-hydrate nothing, behave
     * exactly as before) whenever the descriptor is missing or the gates exclude everything.
     */
    private resolveRoutedHydrationPlan(archetype: string): RmHydrationPlan {
        const descriptor = ProjectionManager.instance.getDescriptor(archetype);
        if (!descriptor) return EMPTY_HYDRATION_PLAN;
        const fieldState = PlannerCache.instance.getState(archetype)?.fieldState ?? {};
        return resolveHydrationPlan(archetype, descriptor, fieldState);
    }

    /**
     * Hydrate Entity[] from ordered ids — same shape as the legacy doExec tail.
     *
     * When `rows` and a non-empty `plan` are supplied, components covered by the plan are
     * rebuilt from the rm_ row and the follow-up loads are reduced to the DELTA. Skipping that
     * reduction would make row hydration pointless: populateComponents re-fetches and
     * OVERWRITES the row-built objects, so the query would do strictly more work than before.
     */
    private async hydrateEntityIds(
        entityIds: string[],
        rows?: any[],
        plan?: RmHydrationPlan
    ): Promise<Entity[]> {
        const canHydrate = !!(rows && plan && plan.components.size > 0 && rows.length === entityIds.length);

        const entityMap = new Map<string, Entity>();
        // A component counts as satisfied only if it hydrated for EVERY entity. A single row
        // missing its id column would otherwise remove that component from the delta while one
        // entity still lacks it — returning an entity silently missing a requested component.
        const hydratedCounts = new Map<string, number>();

        const buildBare = () => {
            entityMap.clear();
            hydratedCounts.clear();
            for (const id of entityIds) {
                const entity = new Entity(id);
                entity.setPersisted(true);
                entity.setDirty(false);
                entityMap.set(id, entity);
            }
        };

        if (canHydrate) {
            try {
                for (let i = 0; i < entityIds.length; i++) {
                    const id = entityIds[i]!;
                    const entity = new Entity(id);
                    entity.setPersisted(true);
                    entity.setDirty(false);
                    for (const name of hydrateEntityFromRow(entity, rows![i]!, plan!)) {
                        hydratedCounts.set(name, (hydratedCounts.get(name) ?? 0) + 1);
                    }
                    entityMap.set(id, entity);
                }
            } catch (err) {
                // Mirror the route-level fallback: never fail a read because hydration broke.
                recordFallback('hydrate_error');
                logger.warn({ scope: 'qsp.hydrate.fallback', err }, 'QSP row hydration fallback to component load');
                buildBare();
            }
        } else {
            buildBare();
        }

        const storage = getMetadataStorage();
        const satisfiedTypeIds = new Set<string>();
        for (const [name, count] of hydratedCounts) {
            if (count !== entityIds.length) continue;
            const typeId = storage.getComponentId(name);
            if (typeId) satisfiedTypeIds.add(typeId);
        }

        if (this.shouldPopulate && this.context.componentIds.size > 0) {
            const delta = Array.from(this.context.componentIds).filter(t => !satisfiedTypeIds.has(t));
            if (delta.length > 0) {
                await this.populateComponents(entityMap, delta);
            }
        }

        if (this.context.eagerComponents.size > 0) {
            const delta = Array.from(this.context.eagerComponents).filter(t => !satisfiedTypeIds.has(t));
            if (delta.length > 0) {
                await Entity.LoadComponents(Array.from(entityMap.values()), delta, this.skipComponentCache);
            }
        }

        return entityIds.map(id => entityMap.get(id)!);
    }

    private async doExec(): Promise<Entity[]> {
        // Reset context for fresh execution
        this.context.reset();

        // Entity-column sort (sortByCreatedAt/sortByUpdatedAt) and component
        // sortBy() cannot be combined: the outer wrapper re-orders solely by
        // the entity column, silently overriding the component sort.
        if (this.context.entitySortOrders.length > 0 && this.context.sortOrders.length > 0) {
            throw new Error(
                'sortByCreatedAt()/sortByUpdatedAt() cannot be combined with sortBy() in the same query. ' +
                'Use one or the other.'
            );
        }

        // RP-06b: plain cursor(id) walks entity_id order — wrong page boundaries
        // under component sortBy. Prefer sortedCursor() (composite keyset).
        if (this.context.cursorId !== null && this.context.sortOrders.length > 0) {
            throw new Error(
                'cursor(entityId) cannot be combined with sortBy(). ' +
                'Use sortedCursor(token) for composite keyset pagination over the sort key, ' +
                'or remove sortBy() to page by entity_id.'
            );
        }

        // QSP: resolve coverage once (before pagination is neutralized below). Route only when
        // READY; shadow-compare in SHADOW. On any route error fall through to the legacy body unchanged.
        // QSP does its own LIMIT n+1 inside doExecRouted — do not bump limit here first.
        let qspReq: CoverageRequest | undefined;
        let qspRes: PlanResolution | undefined;
        if (qspActive() && !this.orQuery) {
            qspReq = buildCoverageRequest(this.context);
            qspRes = SurfacePlanner.instance.resolve(qspReq);
            if (qspMode() === 'route' && qspRes.surface === 'rm' && qspRes.archetype && qspRes.status === 'READY') {
                try {
                    return await this.doExecRouted(qspRes.archetype, qspReq);
                } catch (err) {
                    recordFallback('exec_error');
                    logger.warn({ scope: 'qsp.route.fallback', archetype: qspRes.archetype, err }, 'QSP route exec fallback to legacy');
                    // fall through to legacy below; legacy body runs UNCHANGED
                }
            }
            if (qspRes.triggerArchetype) {
                void ProjectionManager.instance.ensureProjection(qspRes.triggerArchetype);
            }
        }

        // RP-01: explicit .take(N) → fetch N+1 so hasNextPage is free (no count()).
        // Only on the legacy path (after QSP). Default LIMIT does not set explicitTake.
        this.nPlus1PageSize = null;
        if (this.explicitTake && this.context.limit !== null && this.context.limit >= 0) {
            this.nPlus1PageSize = this.context.limit;
            this.context.limit = this.context.limit + 1;
        }

        // Entity-column sort drives from entities (EXISTS probes + LIMIT).
        // OR + component sortBy still wraps the id-set. Non-OR component
        // sortBy stays inside ComponentInclusionNode's leaf scan.
        this.reverseSortedPage = false;
        const result = this.context.entitySortOrders.length > 0
            ? this.buildEntityDrivenSortSql()
            : (this.orQuery && this.context.sortOrders.length > 0)
                ? this.buildOrComponentSortSql()
                : this.buildIdSelect();
        // Non-OR component sortBy('before') fetches reversed inside
        // ComponentInclusionNode. Reuse the same post-trim row flip as
        // entity-sort / OR-sort. Multi-key keyset still throws in the node.
        if (
            this.context.entitySortOrders.length === 0 &&
            !(this.orQuery && this.context.sortOrders.length > 0) &&
            this.context.compositeCursor !== null &&
            this.context.cursorDirection === 'before' &&
            this.context.sortOrders.length === 1
        ) {
            this.reverseSortedPage = true;
        }


        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Debug:');
            console.log('SQL:', result.sql);
            console.log('Params:', result.params);
            console.log('OR Query:', !!this.orQuery);
            console.log('Component Cache Bypass:', this.skipComponentCache);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Empty-string params are legitimate for text-field filters
        // (`c.data->>'field' = ''`). UUID-typed params never reach this
        // point empty — findById guards at entry; cursor/excluded IDs
        // originate from saved entities. PG emits a clear error at
        // execution time if a UUID cast meets an empty string.

        // Validate parameters before execution (dev only — skipped in production)
        if (DEBUG_PARAMS) {
            for (let i = 0; i < result.params.length; i++) {
                if (result.params[i] === undefined || result.params[i] === null) {
                    console.error(`❌ Query parameter $${i + 1} is undefined/null`);
                    console.error(`SQL: ${result.sql}`);
                    console.error(`All params: ${JSON.stringify(result.params)}`);
                    throw new Error(`Query parameter $${i + 1} is undefined/null. SQL: ${result.sql.substring(0, 100)}...`);
                }
            }
        }

        // Execute directly. Bun SQL auto-prepares parameterized statements
        // per connection (prepare:true default), so server-side plan reuse
        // already happens at the driver layer. The former framework-level
        // "prepared statement cache" stored a placeholder object and
        // re-executed db.unsafe anyway — pure cache-key/bookkeeping overhead
        // on every exec.
        const entities: any[] = await this.execSql<any[]>('query.entities', dbConn, result.sql, result.params, this.execSignal, this.execPerRequest);

        // Convert to Entity objects
        let entityIds: string[] = entities.map((row: any) => row.id);

        // RP-01: trim the extra row and report hasNextPage (legacy path).
        // 'before' fetches in reverse order; drop the extra row first, then
        // restore the caller's sort direction.
        let hasNextPage: boolean | undefined;
        if (this.nPlus1PageSize !== null) {
            hasNextPage = entityIds.length > this.nPlus1PageSize;
            if (hasNextPage) {
                entityIds = entityIds.slice(0, this.nPlus1PageSize);
            }
            this.context.limit = this.nPlus1PageSize;
            this.nPlus1PageSize = null;
        }
        if (this.reverseSortedPage) {
            entityIds.reverse();
            this.reverseSortedPage = false;
        }
        const defaultCap = currentDefaultQueryLimit();
        const capBound = this.appliedDefaultLimit && defaultCap > 0 && entityIds.length >= defaultCap;
        this._lastRouteInfo = {
            routed: false,
            surface: 'legacy',
            ...(hasNextPage !== undefined ? { hasNextPage } : {}),
            ...(capBound ? { truncatedByDefaultLimit: true } : {}),
        };

        if (qspReq && qspRes) {
            const m = qspMode();
            const shouldShadow = (m === 'shadow' && qspRes.surface === 'rm') || (m === 'route' && qspRes.status === 'SHADOW');
            if (shouldShadow) {
                try { shadowRunExec(qspReq, entityIds.slice()); } catch { /* shadow must never affect the served path */ }
            }
        }

        if (entityIds.length === 0) {
            return [];
        }

        // Create Entity objects
        const entityMap = new Map<string, Entity>();
        for (const id of entityIds) {
            const entity = new Entity(id);
            entity.setPersisted(true);
            entity.setDirty(false);
            entityMap.set(id, entity);
        }

        // Populate entities with components if requested
        if (this.shouldPopulate && this.context.componentIds.size > 0) {
            await this.populateComponents(entityMap);
        }

        // Eagerly load specific components if requested
        if (this.context.eagerComponents.size > 0) {
            const entitiesArray = Array.from(entityMap.values());
            await Entity.LoadComponents(entitiesArray, Array.from(this.context.eagerComponents), this.skipComponentCache);
        }

        // Return entities in the same order as the query results
        const finalEntities = entityIds.map(id => entityMap.get(id)!);

        return finalEntities;
    }

    /**
     * Bulk fetch and attach components to entities
     * @private
     */
    private async populateComponents(entityMap: Map<string, Entity>, onlyTypeIds?: string[]): Promise<void> {
        const entityIds = Array.from(entityMap.keys());
        // onlyTypeIds narrows the fetch to components not already hydrated from an rm_ row.
        const componentTypeIds = onlyTypeIds ?? Array.from(this.context.componentIds);

        if (entityIds.length === 0 || componentTypeIds.length === 0) {
            return;
        }

        const entityIdList = inList(entityIds, 1);
        const params: unknown[] = [...entityIdList.params];
        let next = entityIdList.newParamIndex;
        const selects: string[] = [];

        if (shouldUseDirectPartition()) {
            const parentTypeIds: string[] = [];
            for (const typeId of componentTypeIds) {
                const raw = ComponentRegistry.getPartitionTableName(typeId);
                if (!raw) {
                    parentTypeIds.push(typeId);
                    continue;
                }
                const table = assertComponentTableName(raw, "Query.populate.partitionTable");
                params.push(typeId);
                const typeIdx = next;
                next += 1;
                selects.push(
                    `SELECT id, entity_id, type_id, data, created_at, updated_at FROM ${table} WHERE entity_id IN ${entityIdList.sql} AND type_id = $${typeIdx} AND deleted_at IS NULL`
                );
            }
            if (parentTypeIds.length > 0) {
                const typeIdList = inList(parentTypeIds, next);
                params.push(...typeIdList.params);
                selects.push(
                    `SELECT id, entity_id, type_id, data, created_at, updated_at FROM components WHERE entity_id IN ${entityIdList.sql} AND type_id IN ${typeIdList.sql} AND deleted_at IS NULL`
                );
            }
        } else {
            const typeIdList = inList(componentTypeIds, next);
            params.push(...typeIdList.params);
            selects.push(
                `SELECT id, entity_id, type_id, data, created_at, updated_at FROM components WHERE entity_id IN ${entityIdList.sql} AND type_id IN ${typeIdList.sql} AND deleted_at IS NULL`
            );
        }

        const dbConn = this.getDb();
        const sql = selects.length === 1 ? selects[0]! : selects.join(" UNION ALL ");
        const components = await this.execSql<Array<{
            id: string;
            entity_id: string;
            type_id: string;
            data: unknown;
            created_at: Date | string;
            updated_at: Date | string;
        }>>("query.components", dbConn, sql, params, this.execSignal, this.execPerRequest);

        for (const row of components) {
            const entity = entityMap.get(row.entity_id);
            if (!entity) continue;

            const ComponentCtor = ComponentRegistry.getConstructor(row.type_id);
            if (!ComponentCtor) {
                logger.warn(`Component constructor not found for type_id: ${row.type_id}`);
                continue;
            }

            const component = hydrateComponentRow(ComponentCtor, {
                id: row.id,
                data: row.data,
                typeId: row.type_id,
            });
            const attach = entity as Entity & { addComponent(component: BaseComponent): void };
            attach.addComponent(component);
        }

        this.warmComponentCache(components, entityIds, componentTypeIds);
    }

    /**
     * Fire-and-forget warm of the L1/L2 component cache from populate()
     * results, so subsequent `entity.get(X)` calls (same or later request)
     * hit cache instead of re-querying. Previously populate() bypassed the
     * cache entirely — only the DataLoader read path warmed it.
     *
     * Tracked via Entity.trackCacheOp so shutdown/tests can drain it.
     * Skipped for large result sets to avoid hammering the cache provider
     * with bulk-scan output.
     */
    private warmComponentCache(components: any[], entityIds: string[], componentTypeIds: string[]): void {
        const WARM_CACHE_MAX = 1000;
        if (this.skipComponentCache || this.trx) return;
        if (components.length === 0 || components.length > WARM_CACHE_MAX) return;

        Entity.trackCacheOp((async () => {
            try {
                const { CacheManager } = await import('../core/cache/CacheManager');
                const cacheManager = CacheManager.getInstance();
                const config = cacheManager.getConfig();
                if (!config.enabled || !config.component?.enabled) return;

                // Requested (entity × type) pairs let the cache tombstone
                // known-absent components. Only built when the pair count is
                // bounded — tombstoning a huge scan is not worth the writes.
                let requested: Array<{ entityId: string; typeId: string }> | undefined;
                if (entityIds.length * componentTypeIds.length <= WARM_CACHE_MAX) {
                    requested = [];
                    for (const entityId of entityIds) {
                        for (const typeId of componentTypeIds) {
                            requested.push({ entityId, typeId });
                        }
                    }
                }

                await cacheManager.setComponentsWriteThrough(
                    components.map((row: any) => ({
                        id: row.id,
                        entityId: row.entity_id,
                        typeId: row.type_id,
                        data: row.data,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                        deletedAt: null,
                    })),
                    requested,
                    config.component.ttl,
                );
            } catch (error) {
                logger.warn({ scope: 'cache', component: 'Query', msg: 'populate() component cache warm failed', error });
            }
        })());
    }

    /**
     * Execute query with EXPLAIN ANALYZE for performance debugging
     * Returns the query plan and execution statistics
     */
    public async explainAnalyze(buffers: boolean = true, opts?: QueryExecOptions): Promise<string> {
        this.applyExecOptions(opts);
        // Reset context for fresh execution
        this.context.reset();

        // Same API guards as doExec (RP-06b).
        if (this.context.cursorId !== null && this.context.sortOrders.length > 0) {
            throw new Error(
                'cursor(entityId) cannot be combined with sortBy(). ' +
                'Use sortedCursor(token) for composite keyset pagination over the sort key, ' +
                'or remove sortBy() to page by entity_id.'
            );
        }

        const result = this.context.entitySortOrders.length > 0
            ? this.buildEntityDrivenSortSql()
            : (this.orQuery && this.context.sortOrders.length > 0)
                ? this.buildOrComponentSortSql()
                : this.buildIdSelect();

        // Create EXPLAIN ANALYZE query
        const explainSql = `EXPLAIN (ANALYZE${buffers ? ', BUFFERS' : ''}) ${result.sql}`;

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query EXPLAIN ANALYZE Debug:');
            console.log('SQL:', explainSql);
            console.log('Params:', result.params);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Execute the EXPLAIN ANALYZE query
        const explainResult = await this.execSql<any[]>('query.explain', dbConn, explainSql, result.params, this.execSignal, this.execPerRequest);

        // Format the result
        return explainResult.map((row: any) => row['QUERY PLAN']).join('\n');
    }

    static filterOp = FilterOp;

    public static filter<F extends string>(field: F, operator: FilterOperator, value: unknown): QueryFilter & { field: F } {
        return { field, operator, value };
    }

    public static typedFilter<T extends BaseComponent>(
        componentCtor: new (...args: never[]) => T,
        field: keyof ComponentDataType<T> & string,
        operator: FilterOperator,
        value: unknown
    ): QueryFilter & { field: keyof ComponentDataType<T> & string } {
        void componentCtor;
        return { field, operator, value };
    }

    public static filters<const F extends readonly QueryFilter[]>(...filters: F): { filters: F } {
        return { filters };
    }
}

/**
 * OR function for combining component filters
 * Creates an OrQuery that matches entities satisfying ANY of the branches
 */
export function or(branches: ReadonlyArray<{
    component: ComponentConstructor;
    filters?: ReadonlyArray<QueryFilter>;
}>): OrQuery {
    return new OrQuery(branches.map((branch) => ({
        component: branch.component,
        filters: branch.filters ? [...branch.filters] : undefined,
    })));
}
export { Query };
export type { TimeTrunc } from "./timeBucket";