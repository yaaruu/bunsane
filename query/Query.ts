import {ComponentRegistry , type BaseComponent, type ComponentDataType } from "../core/components";
import { Entity } from "../core/Entity";
import { logger } from "../core/Logger";
import db, { QUERY_TIMEOUT_MS } from "../database";
import { timed } from "../core/Decorators";
import { inList } from "../database/sqlHelpers";
import { QueryContext, QueryDAG, SourceNode, ComponentInclusionNode } from "./index";
import { OrQuery } from "./OrQuery";
import { OrNode } from "./OrNode";
import { preparedStatementCache } from "../database/PreparedStatementCache";
import { timedUnsafe, type PerRequestCounters } from "../database/instrumentedDb";
import { getMetadataStorage } from "../core/metadata";
import { shouldUseDirectPartition } from "../core/Config";
import type { SQL } from "bun";
import type { ComponentConstructor, TypedEntity, ComponentRecord } from "../types/query.types";
import { assertComponentTableName, assertFieldPath } from "./SqlIdentifier";
import { getMembershipSource } from "./membershipSource";

// Parsed once at module load instead of on every exec() (process.env read +
// parseInt was on the query hot path). 0 disables the default limit.
const DEFAULT_QUERY_LIMIT = parseInt(process.env.BUNSANE_DEFAULT_QUERY_LIMIT ?? '10000', 10);
let warnedDefaultLimit = false;

// Gated once — dev keeps param diagnostics, production skips the loop entirely.
const DEBUG_PARAMS = process.env.NODE_ENV !== 'production';

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

export type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "ILIKE" | "IN" | "NOT IN" | string;

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
    CONTAINS: "CONTAINS" as FilterOperator,
    CONTAINED_BY: "CONTAINED_BY" as FilterOperator,
    HAS_ANY: "HAS_ANY" as FilterOperator,
    HAS_ALL: "HAS_ALL" as FilterOperator,
}

export interface QueryFilter {
    field: string;
    operator: FilterOperator;
    value: any;
}

export interface QueryFilterOptions {
    filters: QueryFilter[];
}

export type SortDirection = "ASC" | "DESC";

export interface SortOrder {
    component: string;
    property: string;
    direction: SortDirection;
    nullsFirst?: boolean;
}

export interface ComponentWithFilters {
    component: new (...args: any[]) => BaseComponent;
    filters?: QueryFilter[];
}

export interface QueryCacheOptions {
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

/**
 * New Query class that uses DAG internally for better modularity and extensibility.
 *
 * Generic type parameter `TComponents` tracks component types added via `.with()`,
 * enabling type-safe access to component data after query execution.
 *
 * @example
 * ```typescript
 * const entities = await new Query()
 *   .with(Position)
 *   .with(Velocity)
 *   .exec();
 * // entities is TypedEntity<[typeof Position, typeof Velocity]>[]
 * ```
 */
class Query<TComponents extends readonly ComponentConstructor[] = []> {
    private context: QueryContext;
    private debug: boolean = false;
    private orQuery: OrQuery | null = null;
    private shouldPopulate: boolean = false;
    private trx: SQL | undefined;
    private skipPreparedCache: boolean = false;
    private skipComponentCache: boolean = false;
    private execSignal?: AbortSignal;
    private execPerRequest?: PerRequestCounters;

    /** Component constructors added to this query for type-safe access */
    private _componentCtors: ComponentConstructor[] = [];

    constructor(trx?: SQL) {
        this.trx = trx;
        this.context = new QueryContext(trx);
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

    public async findOneById(id: string, opts?: QueryExecOptions): Promise<TypedEntity<TComponents> | null> {
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
        componentCtor: new (...args: any[]) => T,
        options?: QueryFilterOptions
    ): Query<readonly [...TComponents, new (...args: any[]) => T]>;
    public with(components: ComponentWithFilters[]): this;
    public with(orQuery: OrQuery): this;
    public with<T extends BaseComponent>(
        componentCtorOrComponentsOrOrQuery: (new (...args: any[]) => T) | ComponentWithFilters[] | OrQuery,
        options?: QueryFilterOptions
    ): Query<readonly [...TComponents, new (...args: any[]) => T]> | this {
        if (componentCtorOrComponentsOrOrQuery instanceof OrQuery) {
            // Handle OR query
            this.orQuery = componentCtorOrComponentsOrOrQuery;
            // Suppress base-level scan optimizations that bake ORDER/LIMIT
            // into the SQL OrNode later embeds as its base set.
            this.context.hasOrQuery = true;
            return this;
        }

        if (Array.isArray(componentCtorOrComponentsOrOrQuery)) {
            // Handle array of components with filters
            for (const item of componentCtorOrComponentsOrOrQuery) {
                const typeId = this.context.getComponentId(item.component);
                if (!typeId) {
                    throw new Error(`Component ${item.component.name} is not registered.`);
                }
                this.context.componentIds.add(typeId);
                this._componentCtors.push(item.component);

                if (item.filters && item.filters.length > 0) {
                    this.context.componentFilters.set(typeId, item.filters);
                }
            }
        } else {
            // Handle single component
            const typeId = this.context.getComponentId(componentCtorOrComponentsOrOrQuery);
            if (!typeId) {
                throw new Error(`Component ${componentCtorOrComponentsOrOrQuery.name} is not registered.`);
            }
            this.context.componentIds.add(typeId);
            this._componentCtors.push(componentCtorOrComponentsOrOrQuery);

            if (options?.filters && options.filters.length > 0) {
                this.context.componentFilters.set(typeId, options.filters);
            }
        }

        return this as unknown as Query<readonly [...TComponents, new (...args: any[]) => T]>;
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

    public populate(): this {
        this.shouldPopulate = true;
        return this;
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
        return this;
    }

    public offset(offset: number): this {
        this.context.offsetValue = offset;
        return this;
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
            direction,
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
        if (!options) {
            // Default behavior: bypass prepared statement cache
            this.skipPreparedCache = true;
        } else {
            if (options.preparedStatement === true) {
                this.skipPreparedCache = true;
            }
            if (options.component === true) {
                this.skipComponentCache = true;
            }
        }
        return this;
    }

    public count(opts?: QueryExecOptions): Promise<number> {
        this.applyExecOptions(opts);
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query count execution timeout`);
                reject(new Error(`Query count execution timeout after ${QUERY_TIMEOUT_MS / 1000} seconds`));
            }, QUERY_TIMEOUT_MS);
            (timeout as unknown as { unref?: () => void }).unref?.();
            this.doCount()
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
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

        const result = await timedUnsafe<any[]>(dbConn, sql, params, this.execSignal, this.execPerRequest);

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
        // Build the DAG
        const dag = new QueryDAG();

        // Check if we have an OR query
        if (this.orQuery) {
            // For OR queries, we need to ensure entities have all required components first
            if (this.context.componentIds.size > 0) {
                // ComponentInclusionNode is the root, OrNode is the leaf
                const componentNode = new ComponentInclusionNode();
                dag.setRootNode(componentNode);

                // OrNode filters on top of the base requirements
                const orNode = new OrNode(this.orQuery);
                orNode.addDependency(componentNode);
                dag.addNode(orNode);
            } else {
                // No base requirements, OrNode is both root and leaf
                const orNode = new OrNode(this.orQuery);
                dag.setRootNode(orNode);
            }
        } else {
            // Use buildBasicQuery for regular AND logic (includes CTE optimization)
            const optimizedDag = QueryDAG.buildBasicQuery(this.context);
            // Copy nodes from optimized DAG to our DAG
            for (const node of optimizedDag.getNodes()) {
                dag.addNode(node);
            }
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG
        const result = dag.execute(this.context);

        // Modify SQL for count
        const countSql = `SELECT COUNT(*) as count FROM (${result.sql}) AS subquery`;

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Execute directly. Bun SQL auto-prepares parameterized statements
        // per connection (prepare:true default) — the former framework-level
        // "prepared statement cache" never called a prepare API and only
        // added cache-key string building on the hot path.
        const countResult: any[] = await timedUnsafe<any[]>(dbConn, countSql, result.params, this.execSignal, this.execPerRequest);

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Count Debug:');
            console.log('SQL:', countSql);
            console.log('Params:', result.params);
            console.log('Prepared Cache Bypass:', this.skipPreparedCache);
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
        return typeof count === 'string' ? parseInt(count, 10) : Number(count);
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
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query sum execution timeout`);
                reject(new Error(`Query sum execution timeout after ${QUERY_TIMEOUT_MS / 1000} seconds`));
            }, QUERY_TIMEOUT_MS);
            (timeout as unknown as { unref?: () => void }).unref?.();
            this.doAggregate('SUM', componentCtor, field as string)
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
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
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query average execution timeout`);
                reject(new Error(`Query average execution timeout after ${QUERY_TIMEOUT_MS / 1000} seconds`));
            }, QUERY_TIMEOUT_MS);
            (timeout as unknown as { unref?: () => void }).unref?.();
            this.doAggregate('AVG', componentCtor, field as string)
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
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

        // Build the DAG
        const dag = new QueryDAG();

        // Check if we have an OR query
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
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG to get the base query
        const result = dag.execute(this.context);

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
        const aggregateResult: any[] = await timedUnsafe<any[]>(dbConn, aggregateSql, result.params, this.execSignal, this.execPerRequest);

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
     * When components are added via `.with()`, the returned entities have:
     * - `getTyped(Ctor)`: Type-safe async getter (returns non-null since query guarantees existence)
     * - `componentData`: Synchronous access to already-loaded component data
     *
     * @returns Promise resolving to array of TypedEntity with accumulated component types
     */
    @timed("Query.exec")
    public async exec(opts?: QueryExecOptions): Promise<TypedEntity<TComponents>[]> {
        this.applyExecOptions(opts);
        // Apply default LIMIT so unbounded queries cannot load entire tables
        // into memory. Configurable via BUNSANE_DEFAULT_QUERY_LIMIT, 0 to
        // disable. When the default is applied without an explicit .take(),
        // warn once at execution so developers notice runaway queries
        // (H-QUERY-1).
        if (this.context.limit === null || this.context.limit === undefined) {
            if (DEFAULT_QUERY_LIMIT > 0) {
                this.context.limit = DEFAULT_QUERY_LIMIT;
                // Warn once per process — this fires on every unbounded query,
                // so logging per-call floods logs and allocates on the hot path.
                if (!warnedDefaultLimit) {
                    warnedDefaultLimit = true;
                    logger.warn({ scope: 'Query.exec', defaultLimit: DEFAULT_QUERY_LIMIT }, 'Query executed without explicit .take() — applying framework default LIMIT. Call .take(N) to suppress this warning.');
                }
            }
        }

        return new Promise<TypedEntity<TComponents>[]>((resolve, reject) => {
            // Add timeout to prevent hanging queries
            const timeout = setTimeout(() => {
                logger.error(`Query execution timeout`);
                reject(new Error(`Query execution timeout after ${QUERY_TIMEOUT_MS / 1000} seconds`));
            }, QUERY_TIMEOUT_MS); // 30 second timeout
            // unref: at high QPS thousands of these are live concurrently;
            // they must not hold the event loop open nor add ref'd-timer churn.
            (timeout as unknown as { unref?: () => void }).unref?.();

            this.doExec()
                .then(result => {
                    clearTimeout(timeout);
                    // Wrap entities with typed accessors
                    const typedEntities = result.map(e => this.wrapTypedEntity(e));
                    resolve(typedEntities);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    /**
     * Wrap an entity with typed accessors for components in this query.
     * Provides both async getTyped() and synchronous componentData access.
     */
    private wrapTypedEntity(entity: Entity): TypedEntity<TComponents> {
        const componentCtors = this._componentCtors;

        // Build synchronous component data record from already-loaded components
        const componentData: Record<string, any> = {};
        for (const ctor of componentCtors) {
            const comp = entity.getInMemory(ctor);
            if (comp) {
                componentData[ctor.name] = (comp as any).data();
            }
        }

        // Create typed entity wrapper
        const typedEntity = entity as TypedEntity<TComponents>;

        // Plain assignment — enumerable: true matches prior behavior; no defineProperty overhead.
        (typedEntity as any).componentData = componentData as ComponentRecord<TComponents>;

        // _queriedComponents must stay non-enumerable (hidden from Object.keys / spreads).
        queriedComponentsDescriptor.value = componentCtors as unknown as TComponents;
        Object.defineProperty(typedEntity, '_queriedComponents', queriedComponentsDescriptor);
        queriedComponentsDescriptor.value = undefined; // don't retain ref

        // Shared function — one allocation per module, not per row.
        Object.defineProperty(typedEntity, 'getTyped', getTypedDescriptor);

        return typedEntity;
    }

    private async doExec(): Promise<Entity[]> {
        // Reset context for fresh execution
        this.context.reset();

        // Composite keyset cursors are incompatible with OR queries (OrNode always
        // emits ORDER BY entity_id only — documented gap #3 in QUERY_SORT_PAGINATION_PLAN).
        if (this.context.compositeCursor && this.orQuery) {
            throw new Error(
                'sortedCursor() cannot be combined with OR queries (.with(or(...))). ' +
                'OR + sortBy ordering is a known limitation (gap #3). Use OFFSET pagination instead.'
            );
        }

        // Entity-column sort (sortByCreatedAt/sortByUpdatedAt) and component
        // sortBy() cannot be combined: the outer wrapper re-orders solely by
        // the entity column, silently overriding the component sort.
        if (this.context.entitySortOrders.length > 0 && this.context.sortOrders.length > 0) {
            throw new Error(
                'sortByCreatedAt()/sortByUpdatedAt() cannot be combined with sortBy() in the same query. ' +
                'Use one or the other.'
            );
        }

        // Native entity-column sort (created_at/updated_at) is applied as an
        // outer ORDER BY over the resolved id-set. The inner nodes must emit
        // the FULL set with no ordering/pagination of their own, else their
        // LIMIT would truncate the wrong rows before we re-order. Stash and
        // neutralize pagination for the inner build; restore + re-apply in the
        // wrapper below.
        const entitySorts = this.context.entitySortOrders;
        const useEntitySort = entitySorts.length > 0;
        let savedLimit: number | null = null;
        let savedOffset = 0;
        let savedCursorId: string | null = null;
        let savedCompositeCursor: { v: string | null; id: string } | null = null;
        if (useEntitySort) {
            savedLimit = this.context.limit;
            savedOffset = this.context.offsetValue;
            savedCursorId = this.context.cursorId;
            savedCompositeCursor = this.context.compositeCursor;
            this.context.limit = null;
            this.context.offsetValue = 0;
            this.context.cursorId = null;
            this.context.compositeCursor = null;
        }

        // Inner DAG build + entity-sort wrapper run with pagination
        // neutralized (above). Restore in `finally` so a throw mid-build —
        // including the entity-sort guards below — can never leave a reused
        // Query instance with limit/offset/cursor nulled.
        let result: { sql: string; params: any[]; context: QueryContext };
        try {
            // Build the DAG
            const dag = new QueryDAG();

            // Check if we have an OR query
            if (this.orQuery) {
                // For OR queries, we need to ensure entities have all required components first
                if (this.context.componentIds.size > 0) {
                    // ComponentInclusionNode is the root, OrNode is the leaf
                    const componentNode = new ComponentInclusionNode();
                    dag.setRootNode(componentNode);

                    // OrNode filters on top of the base requirements
                    const orNode = new OrNode(this.orQuery);
                    orNode.addDependency(componentNode);
                    dag.addNode(orNode);
                } else {
                    // No base requirements, OrNode is both root and leaf
                    const orNode = new OrNode(this.orQuery);
                    dag.setRootNode(orNode);
                }
            } else {
                // Use buildBasicQuery for regular AND logic (includes CTE optimization)
                const optimizedDag = QueryDAG.buildBasicQuery(this.context);
                // Copy nodes from optimized DAG to our DAG
                for (const node of optimizedDag.getNodes()) {
                    dag.addNode(node);
                }
                if (optimizedDag.getRootNode()) {
                    dag.setRootNode(optimizedDag.getRootNode()!);
                }
            }

            // Execute the DAG
            result = dag.execute(this.context);

            // Wrap the resolved id-set with an outer ORDER BY on the native
            // entities column(s). result.params === this.context.params (same
            // ref), so pushing pagination params keeps placeholders sequential.
            if (useEntitySort) {
                if (savedCompositeCursor && entitySorts.length > 1) {
                    throw new Error(
                        'sortedCursor() does not support multi-key entity sorts. ' +
                        'Only a single sortByCreatedAt() or sortByUpdatedAt() is supported with composite keyset pagination.'
                    );
                }

                const orderClauses = entitySorts.map(s => {
                    // Hard-mapped allow-list — never interpolate raw input.
                    const col = s.field === "updated_at" ? "updated_at" : "created_at";
                    const nulls = s.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
                    const dir = s.direction === "DESC" ? "DESC" : "ASC";
                    return `e.${col} ${dir} ${nulls}`;
                }).join(", ");

                let whereClause = '';
                if (savedCompositeCursor) {
                    const isBefore = this.context.cursorDirection === 'before';
                    if (isBefore) {
                        // 'before' for sorted entity-column cursors is not yet implemented:
                        // it requires reversing ORDER BY and post-reversing rows in JS.
                        // Throw a clear error rather than returning silently wrong pages.
                        throw new Error(
                            "sortedCursor(token, 'before') is not supported for sortByCreatedAt()/sortByUpdatedAt(). " +
                            'Use OFFSET pagination or walk pages forward only.'
                        );
                    }

                    // Composite keyset for native entity-column sort.
                    // We truncate both sides to milliseconds so the JS Date (ms precision)
                    // matches the stored TIMESTAMPTZ value. Without truncation, a stored
                    // microsecond timestamp (e.g. 00:00:01.000123) always compares GREATER
                    // than the ms-truncated cursor (00:00:01.000), causing already-seen
                    // rows to re-qualify on every subsequent page.
                    //
                    // ORDER BY: date_trunc('milliseconds', col) <dir> NULLS x, base.id ASC
                    // ASC+after:  (trunc_col, id) > ($v, $id)
                    // DESC+after: trunc_col < $v OR (trunc_col = $v AND id > $id)
                    const s = entitySorts[0]!;
                    const rawCol = s.field === "updated_at" ? "e.updated_at" : "e.created_at";
                    const col = `date_trunc('milliseconds', ${rawCol})`;
                    const isDesc = s.direction === "DESC";
                    const { v, id: cursorId } = savedCompositeCursor;

                    if (v === null) {
                        // After the last non-null row under NULLS LAST: for ASC the NULL
                        // region follows all non-null rows — they've all been seen, so
                        // nothing remains (entities.created_at is NOT NULL in practice,
                        // but handle generically).
                        whereClause = ' WHERE FALSE';
                    } else if (!isDesc) {
                        // ASC+after: row-comparison on truncated timestamp + id tiebreak.
                        // Include NULL-timestamped rows too (NULLS LAST → they appear at
                        // the very end, AFTER all non-null rows, so they have not yet been
                        // visited when we are past a non-null cursor value).
                        const vIdx = result.params.push(v);
                        const idGtIdx = result.params.push(cursorId);
                        whereClause = ` WHERE ((${col}, base.id) > ($${vIdx}::timestamptz, $${idGtIdx}::uuid) OR ${rawCol} IS NULL)`;
                    } else {
                        // DESC+after: values come in decreasing order; "after" the cursor
                        // means smaller truncated timestamp, or same + larger id.
                        const vLtIdx = result.params.push(v);
                        const vEqIdx = result.params.push(v);
                        const idGtIdx = result.params.push(cursorId);
                        whereClause = ` WHERE (${col} < $${vLtIdx}::timestamptz OR (${col} = $${vEqIdx}::timestamptz AND base.id > $${idGtIdx}::uuid))`;
                    }
                }

                // Mirror the ORDER BY truncation in the sort clause so the cursor
                // comparison and the ORDER BY operate on the same precision.
                const truncatedOrderClauses = entitySorts.map(s => {
                    const rawCol = s.field === "updated_at" ? "e.updated_at" : "e.created_at";
                    const col = `date_trunc('milliseconds', ${rawCol})`;
                    const nulls = s.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
                    const dir = s.direction === "DESC" ? "DESC" : "ASC";
                    return `${col} ${dir} ${nulls}`;
                }).join(", ");
                const effectiveOrderClauses = savedCompositeCursor ? truncatedOrderClauses : orderClauses;

                let wrapped = `SELECT base.id FROM (${result.sql}) AS base
                    JOIN entities e ON e.id = base.id${whereClause}
                    ORDER BY ${effectiveOrderClauses}, base.id ASC`;

                if (savedLimit !== null) {
                    result.params.push(savedLimit);
                    wrapped += ` LIMIT $${result.params.length}`;
                }
                // Only add OFFSET when not using cursor-based pagination
                if (!savedCompositeCursor && (savedOffset > 0 || savedLimit !== null)) {
                    result.params.push(savedOffset);
                    wrapped += ` OFFSET $${result.params.length}`;
                }

                result.sql = wrapped;
            }
        } finally {
            if (useEntitySort) {
                // Restore so the Query instance stays reusable, even if the
                // DAG build/execute or an entity-sort guard threw above.
                this.context.limit = savedLimit;
                this.context.offsetValue = savedOffset;
                this.context.cursorId = savedCursorId;
                this.context.compositeCursor = savedCompositeCursor;
            }
        }

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Debug:');
            console.log('SQL:', result.sql);
            console.log('Params:', result.params);
            console.log('OR Query:', !!this.orQuery);
            console.log('Prepared Cache Bypass:', this.skipPreparedCache);
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
        const entities: any[] = await timedUnsafe<any[]>(dbConn, result.sql, result.params, this.execSignal, this.execPerRequest);

        // Convert to Entity objects
        const entityIds: string[] = entities.map((row: any) => row.id);

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
    private async populateComponents(entityMap: Map<string, Entity>): Promise<void> {
        const entityIds = Array.from(entityMap.keys());
        const componentTypeIds = Array.from(this.context.componentIds);

        if (entityIds.length === 0 || componentTypeIds.length === 0) {
            return;
        }

        // Bulk fetch all components for all entities and all requested component types
        const entityIdList = inList(entityIds, 1);
        const typeIdList = inList(componentTypeIds, entityIdList.newParamIndex);

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // created_at/updated_at included so results can warm the component
        // cache below with full ComponentData entries.
        let components: any[];
        if (shouldUseDirectPartition() && componentTypeIds.length === 1) {
            // Single component type - use direct partition if available
            const partitionTableName = ComponentRegistry.getPartitionTableName(componentTypeIds[0]!);
            if (partitionTableName) {
                components = await timedUnsafe<any[]>(dbConn, `
                    SELECT id, entity_id, type_id, data, created_at, updated_at
                    FROM ${partitionTableName}
                    WHERE entity_id IN ${entityIdList.sql}
                    AND type_id IN ${typeIdList.sql}
                    AND deleted_at IS NULL
                `, [...entityIdList.params, ...typeIdList.params], this.execSignal, this.execPerRequest);
            } else {
                // Fallback to parent table
                components = await timedUnsafe<any[]>(dbConn, `
                    SELECT id, entity_id, type_id, data, created_at, updated_at
                    FROM components
                    WHERE entity_id IN ${entityIdList.sql}
                    AND type_id IN ${typeIdList.sql}
                    AND deleted_at IS NULL
                `, [...entityIdList.params, ...typeIdList.params], this.execSignal, this.execPerRequest);
            }
        } else {
            // Multiple types or direct partition disabled - use parent table
            components = await timedUnsafe<any[]>(dbConn, `
                SELECT id, entity_id, type_id, data, created_at, updated_at
                FROM components
                WHERE entity_id IN ${entityIdList.sql}
                AND type_id IN ${typeIdList.sql}
                AND deleted_at IS NULL
            `, [...entityIdList.params, ...typeIdList.params], this.execSignal, this.execPerRequest);
        }

        // Get metadata storage for Date deserialization
        const storage = getMetadataStorage();

        // Group components by entity_id and attach them to entities
        for (const row of components) {
            const entity = entityMap.get(row.entity_id);
            if (!entity) continue;

            // Get the component constructor from registry
            const ComponentCtor = ComponentRegistry.getConstructor(row.type_id);
            if (!ComponentCtor) {
                logger.warn(`Component constructor not found for type_id: ${row.type_id}`);
                continue;
            }

            // Create component instance
            const component = new ComponentCtor();
            
            // Parse and assign component data
            const componentData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            Object.assign(component, componentData);

            // Deserialize Date properties
            const props = storage.componentProperties.get(row.type_id);
            if (props) {
                for (const prop of props) {
                    if (prop.propertyType === Date && typeof (component as any)[prop.propertyKey] === 'string') {
                        (component as any)[prop.propertyKey] = new Date((component as any)[prop.propertyKey]);
                    }
                }
            }

            // Set component metadata
            component.id = row.id;
            component.setPersisted(true);
            component.setDirty(false);

            // Add component to entity (using protected method)
            (entity as any).addComponent(component);
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

        // Build the DAG (same as exec)
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
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG
        const result = dag.execute(this.context);

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
        const explainResult = await timedUnsafe<any[]>(dbConn, explainSql, result.params, this.execSignal, this.execPerRequest);

        // Format the result
        return explainResult.map((row: any) => row['QUERY PLAN']).join('\n');
    }

    /**
     * Get prepared statement cache statistics.
     * @deprecated The framework-level prepared statement cache is no longer
     * used on the query hot path (Bun SQL auto-prepares at the driver
     * layer). Stats remain for API compatibility and report an idle cache.
     */
    public static getCacheStats() {
        return preparedStatementCache.getStats();
    }

    static filterOp = FilterOp;

    public static filter(field: string, operator: FilterOperator, value: any): QueryFilter {
        return { field, operator, value };
    }

    public static typedFilter<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>,
        operator: FilterOperator,
        value: any
    ): QueryFilter {
        return { field: field as string, operator, value };
    }

    public static filters(...filters: QueryFilter[]): QueryFilterOptions {
        return { filters };
    }
}

/**
 * OR function for combining component filters
 * Creates an OrQuery that matches entities satisfying ANY of the branches
 */
export function or(branches: ComponentWithFilters[]): OrQuery {
    return new OrQuery(branches);
}

export { Query };