import type { BaseComponent, ComponentDataType } from "../core/Components";
import ComponentRegistry from "../core/ComponentRegistry";

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

export class QueryContext {
    public params: any[] = [];
    public paramIndex: number = 1;
    public tableAliases: Map<string, string> = new Map();
    public sqlFragments: string[] = [];
    public componentIds: Set<string> = new Set();
    public excludedComponentIds: Set<string> = new Set();
    public componentFilters: Map<string, QueryFilter[]> = new Map();
    public sortOrders: SortOrder[] = [];
    public excludedEntityIds: Set<string> = new Set();
    public withId: string | null = null;
    public limit: number | null = null;
    public offsetValue: number = 0;
    public hasCTE: boolean = false;
    public cteName: string = "";

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
            .map(([typeId, filters]) => `${typeId}:${filters.map(f => `${f.field}${f.operator}`).sort().join('|')}`)
            .sort()
            .join(';');
        const sorts = this.sortOrders
            .map(s => `${s.component}.${s.property}:${s.direction}`)
            .sort()
            .join(',');

        const key = `${components}|${excludedComponents}|${filters}|${sorts}|${this.hasCTE}|${this.cteName}`;
        return key;
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
        clone.excludedEntityIds = new Set(this.excludedEntityIds);
        clone.withId = this.withId;
        clone.limit = this.limit;
        clone.offsetValue = this.offsetValue;
        clone.hasCTE = this.hasCTE;
        clone.cteName = this.cteName;
        return clone;
    }
}