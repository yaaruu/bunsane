import { ComponentRegistry, type BaseComponent } from "../core/components";
import type { SQL } from "bun";

export interface QueryFilter {
    field: string;
    operator: string;
    value: any;
}

export interface SortOrder {
    component: string;
    property: string;
    direction: "ASC" | "DESC";
    nullsFirst?: boolean;
}

/**
 * Sort by a native column on the `entities` table (created_at / updated_at).
 * The column always exists. List reads are planned in query/entitySort.ts
 * (index-ordered id select, or an adaptive membership probe) — not an outer
 * ORDER BY over a resolved id-set. `.cursor(id)` with an entity sort throws;
 * use `sortedCursor()`.
 */
export type EntitySortField = "created_at" | "updated_at";

export interface EntitySortOrder {
    field: EntitySortField;
    direction: "ASC" | "DESC";
    nullsFirst?: boolean;
}

/**
 * Opaque keyset payload. Legacy single-key tokens only have `v` + `id`.
 * Multi-key tokens also carry `vs` (every sort value, in sortBy order).
 * `v` is always the first key so older readers keep working.
 */
export interface SortedCursor {
    v: string | null;
    vs?: (string | null)[];
    id: string;
}

/** Sort values carried by a cursor. Legacy tokens synthesize `[v]`. */
export function sortedCursorValues(cursor: SortedCursor): (string | null)[] {
    if (cursor.vs && cursor.vs.length > 0) return cursor.vs;
    return [cursor.v];
}

export class QueryContext {
    public params: any[] = [];
    public paramIndex: number = 1;
    public tableAliases: Map<string, string> = new Map();
    public sqlFragments: string[] = [];
    public componentIds: Set<string> = new Set();
    public excludedComponentIds: Set<string> = new Set();
    public componentFilters: Map<string, QueryFilter[]> = new Map();
    public sortOrders: SortOrder[] = [];
    // Native entities-table sorts (created_at/updated_at). SQL nodes do not
    // apply them — Query.doExec dispatches to query/entitySort.ts. count()
    // does not build that statement, so entity sorts do not change cardinality.
    public entitySortOrders: EntitySortOrder[] = [];
    public excludedEntityIds: Set<string> = new Set();
    public withId: string | null = null;
    public limit: number | null = null;
    public offsetValue: number = 0;

    // Cursor-based pagination (more efficient than OFFSET for large datasets)
    public cursorId: string | null = null;
    public cursorDirection: 'after' | 'before' = 'after';

    /**
     * Composite keyset cursor for sorted queries.
     * Encodes both the last row's sort value and its entity_id so the
     * predicate can be `(sort_expr, entity_id) > ($v, $id)` (or `<` for DESC).
     * Only set via Query.sortedCursor(); plain .cursor() never sets this.
     */
    public compositeCursor: SortedCursor | null = null;
    public hasCTE: boolean = false;
    public cteName: string = "";
    public eagerComponents: Set<string> = new Set();
    public paginationAppliedInCTE: boolean = false;
    /**
     * True when field filters for required components were already applied
     * inside the driving-leaf scan or its EXISTS semi-joins (CTENode or
     * ComponentInclusionNode). Downstream EXISTS/LATERAL filter application
     * must skip those filters to avoid double predicates and duplicate params.
     */
    public filtersAppliedInMembership: boolean = false;
    // Set by Query when an OrQuery participates. OrNode embeds its
    // ComponentInclusionNode dependency's SQL as a base set, so base-level
    // optimizations that bake in ORDER BY/LIMIT (sort-driven scan) must be
    // suppressed.
    public hasOrQuery: boolean = false;

    // Set by Query.doExec while building an OR query whose final ordering is
    // applied by an outer sort wrapper (entity-column or component sortBy).
    // OrNode honours it by skipping its own `ORDER BY entity_id` so the inner
    // id-set is not sorted twice (the outer wrapper re-orders the full set).
    public suppressNodeOrdering: boolean = false;

    private trx: SQL | undefined;
    constructor(trx?: SQL) {
        this.trx = trx;
    }

    /**
     * Get the database connection (transaction or default db)
     */
    public getDb(): SQL | undefined {
        return this.trx;
    }

    public getNextAlias(prefix: string = "t"): string {
        const count = this.tableAliases.size;
        const alias = `${prefix}${count}`;
        this.tableAliases.set(alias, alias);
        return alias;
    }

    public addParam(value: any): number {
        this.params.push(value);
        return this.paramIndex++;
    }

    /**
     * Reset the context for reuse (clears params and resets paramIndex)
     */
    public reset(): void {
        this.params = [];
        this.paramIndex = 1;
        this.tableAliases.clear();
        this.sqlFragments = [];
        // Execution flags rebuilt per DAG run — must not leak across exec/count.
        this.hasCTE = false;
        this.cteName = "";
        this.paginationAppliedInCTE = false;
        this.filtersAppliedInMembership = false;
        this.suppressNodeOrdering = false;
    }

    public addParams(values: any[]): number[] {
        const indices: number[] = [];
        for (const value of values) {
            indices.push(this.addParam(value));
        }
        return indices;
    }

    public addSqlFragment(fragment: string): void {
        this.sqlFragments.push(fragment);
    }

    public getComponentId(componentCtor: new (...args: any[]) => BaseComponent): string | undefined {
        return ComponentRegistry.getComponentId(componentCtor.name);
    }



    public clone(): QueryContext {
        const clone = new QueryContext();
        clone.params = [...this.params];
        clone.paramIndex = this.paramIndex;
        clone.tableAliases = new Map(this.tableAliases);
        clone.sqlFragments = [...this.sqlFragments];
        clone.componentIds = new Set(this.componentIds);
        clone.excludedComponentIds = new Set(this.excludedComponentIds);
        clone.componentFilters = new Map(this.componentFilters);
        clone.sortOrders = [...this.sortOrders];
        clone.entitySortOrders = [...this.entitySortOrders];
        clone.excludedEntityIds = new Set(this.excludedEntityIds);
        clone.withId = this.withId;
        clone.limit = this.limit;
        clone.offsetValue = this.offsetValue;
        clone.cursorId = this.cursorId;
        clone.cursorDirection = this.cursorDirection;
        clone.compositeCursor = this.compositeCursor ? { ...this.compositeCursor } : null;
        clone.hasCTE = this.hasCTE;
        clone.cteName = this.cteName;
        clone.eagerComponents = new Set(this.eagerComponents);
        clone.paginationAppliedInCTE = this.paginationAppliedInCTE;
        clone.hasOrQuery = this.hasOrQuery;
        clone.suppressNodeOrdering = this.suppressNodeOrdering;
        return clone;
    }
}