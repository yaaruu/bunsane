export type ProjectionSqlType = 'text' | 'numeric' | 'timestamptz' | 'boolean' | 'uuid';

/** Synthetic field name for a component-id column. Never a real @CompData key. */
export const COMPONENT_ID_FIELD = '__cid';

export interface ProjectedColumn {
    component: string;
    field: string;
    sqlType: ProjectionSqlType;
    columnName: string;
    /**
     * 'field' (default) projects a @CompData value out of components.data.
     * 'component_id' projects components.id itself — required to rebuild a component that can
     * still be safely mutated and saved, since the upsert conflicts on (id, type_id).
     */
    kind?: 'field' | 'component_id';
}

export type ProjectionStatus = 'DISABLED' | 'BACKFILLING' | 'SHADOW' | 'READY';

export type FieldReadiness = 'FILLING' | 'READY';
export type FieldState = Record<string, FieldReadiness>;

export interface ProjectionDescriptor {
    archetype: string;
    columns: ProjectedColumn[];
    shapeHash: string;
    shapeVersion: number;
}
