import { ComponentRegistry, type BaseComponent, type ComponentDataType } from "../core/components";
import { FilterBuilderRegistry } from "./FilterBuilderRegistry";
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
 * Unlike SortOrder, this needs no component and no `.with()` — the column
 * always exists and is indexed-friendly. Applied as an outer ORDER BY in
 * Query.doExec, invisible to the SQL planner nodes.
 */
export type EntitySortField = "created_at" | "updated_at";

export interface EntitySortOrder {
    field: EntitySortField;
    direction: "ASC" | "DESC";
    nullsFirst?: boolean;
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
    // Native entities-table sorts (created_at/updated_at). Separate channel:
    // the SQL nodes never read it — Query.doExec wraps the id-set with a
    // JOIN entities ... ORDER BY. Keeps the component sort paths untouched.
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
    public compositeCursor: { v: string | null; id: string } | null = null;
    public hasCTE: boolean = false;
    public cteName: string = "";
    public eagerComponents: Set<string> = new Set();
    public paginationAppliedInCTE: boolean = false;
    // Set by Query when an OrQuery participates. OrNode embeds its
    // ComponentInclusionNode dependency's SQL as a base set, so base-level
    // optimizations that bake in ORDER BY/LIMIT (sort-driven scan) must be
    // suppressed.
    public hasOrQuery: boolean = false;

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

    /**
     * Generate a cache key fingerprint for prepared statement caching
     */
    public generateCacheKey(): string {
        // Create a deterministic fingerprint of the query structure
        const components = Array.from(this.componentIds).sort().join(',');
        const excludedComponents = Array.from(this.excludedComponentIds).sort().join(',');
        const filters = Array.from(this.componentFilters.entries())
            .map(([typeId, filters]) => `${typeId}:${filters.map(f => {
                // For IN/NOT IN operators, include array length in cache key
                // This ensures different array lengths produce different cache keys
                // preventing prepared statement parameter count mismatches
                if ((f.operator === 'IN' || f.operator === 'NOT IN') && Array.isArray(f.value)) {
                    return `${f.field}${f.operator}[${f.value.length}]`;
                }
                return `${f.field}${f.operator}`;
            }).sort().join('|')}`)
            .sort()
            .join(';');
        const sorts = this.sortOrders
            .map(s => `${s.component}.${s.property}:${s.direction}`)
            .sort()
            .join(',');
        const entitySorts = this.entitySortOrders
            .map(s => `@${s.field}:${s.direction}:${s.nullsFirst ? 'nf' : 'nl'}`)
            .join(',');

        // Extract custom filter operators for cache key differentiation
        const customOperators = this.extractCustomOperators();
        const customOps = customOperators.length > 0 ? `customOps:${customOperators.sort().join(',')}` : '';

        // Include pagination in cache key to prevent prepared statement collision
        // when same query is executed with different pagination settings
        const paginationKey = `limit:${this.limit !== null ? 'yes' : 'no'}|offset:${this.offsetValue > 0 ? 'yes' : 'no'}|cursor:${this.cursorId !== null ? this.cursorDirection : 'no'}`;

        // Include excluded entity IDs count for cache key differentiation
        const excludedEntityCount = this.excludedEntityIds.size;
        const excludedEntitiesKey = excludedEntityCount > 0 ? `|excludedEntities:${excludedEntityCount}` : '';

        const key = `${components}|${excludedComponents}|${filters}|${sorts}|${entitySorts}|${this.hasCTE}|${this.cteName}|${customOps}|${paginationKey}${excludedEntitiesKey}`;
        return key;
    }

    /**
     * Extract custom filter operators from component filters
     * Used for cache key generation to differentiate queries with custom filters
     */
    private extractCustomOperators(): string[] {
        const customOperators: string[] = [];

        for (const filters of this.componentFilters.values()) {
            for (const filter of filters) {
                if (FilterBuilderRegistry.has(filter.operator)) {
                    customOperators.push(filter.operator);
                }
            }
        }

        return customOperators;
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
        return clone;
    }
}