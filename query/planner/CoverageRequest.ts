export type CoverageOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "IN" | "NOT IN";

export interface CoverageFilter {
    typeId: string;
    component: string;
    field: string;
    operator: string;
    value: any;
}

export interface CoverageSort {
    kind: 'component' | 'entity';
    component?: string;
    field: string;
    direction: 'ASC' | 'DESC';
    nullsFirst: boolean;
}

export interface CoverageCursor {
    kind: 'keyset' | 'id';
    v?: string | null;
    id: string;
    direction: 'after' | 'before';
}

export interface CoverageRequest {
    requiredComponentIds: string[];
    requiredComponentNames: string[];
    filters: CoverageFilter[];
    sorts: CoverageSort[];
    cursor?: CoverageCursor;
    excludedComponentIds: string[];
    excludedEntityIds: string[];
    withId: string | null;
    hasOrQuery: boolean;
    limit: number | null;
    offset: number;
}
