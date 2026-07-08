export type ProjectionSqlType = 'text' | 'numeric' | 'timestamptz' | 'boolean';

export interface ProjectedColumn {
    component: string;
    field: string;
    sqlType: ProjectionSqlType;
    columnName: string;
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
