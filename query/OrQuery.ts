import type { BaseComponent } from "../core/Components";
import type { QueryFilter } from "./Query";

export interface OrBranch {
    component: new (...args: any[]) => BaseComponent;
    filters?: QueryFilter[];
}

/**
 * Represents an OR query with multiple branches
 * Each branch specifies a component and optional filters
 * An entity matches if it satisfies ANY of the branches
 */
export class OrQuery {
    public branches: OrBranch[];

    constructor(branches: OrBranch[]) {
        if (!branches || branches.length === 0) {
            throw new Error("OR query must have at least one branch");
        }
        this.branches = branches;
    }

    /**
     * Get all component types used in this OR query
     */
    public getComponentTypes(): Set<string> {
        const types = new Set<string>();
        for (const branch of this.branches) {
            // We'll resolve component IDs when we have access to ComponentRegistry
            types.add(branch.component.name);
        }
        return types;
    }

    /**
     * Check if this OR query has any filters
     */
    public hasFilters(): boolean {
        return this.branches.some(branch => branch.filters && branch.filters.length > 0);
    }
}