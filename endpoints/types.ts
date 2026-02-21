interface StudioTableQueryParams {
    limit?: number;
    offset?: number;
    search?: string;
}

interface StudioArcheTypeQueryParams {
    limit?: number;
    offset?: number;
    search?: string;
    include_deleted?: boolean;
}

interface TableColumn {
    name: string;
    type: string;
    nullable: boolean;
    primary: boolean;
}

interface TableRowData {
    [key: string]: unknown;
}

interface StudioTableResponse {
    name: string;
    columns: TableColumn[];
    rows: TableRowData[];
    total: number;
    limit: number;
    offset: number;
}

interface ArcheTypeField {
    fieldName: string;
    componentName: string;
    fieldLabel: string;
    nullable?: boolean;
}

interface ArcheTypeEntityRecord {
    entityId: string;
    components: Record<string, unknown>;
    deleted_at?: string | null;
}

interface StudioArcheTypeResponse {
    name: string;
    fields: ArcheTypeField[];
    indicatorComponent: string | null;
    entities: ArcheTypeEntityRecord[];
    total: number;
    limit: number;
    offset: number;
}

interface DeleteTableRowsRequest {
    ids: string[];
}

interface DeleteArcheTypeEntitiesRequest {
    entityIds: string[];
}

interface DeleteResponse {
    success: boolean;
    deletedCount: number;
    message: string;
}

interface EntityComponent {
    id: string;
    name: string;
    type_id: string;
    data: unknown;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}

interface EntityInspectorResponse {
    entity: {
        id: string;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
    };
    components: EntityComponent[];
}

interface ComponentTypeStats {
    name: string;
    count: number;
}

interface ArcheTypeStats {
    name: string;
    entityCount: number;
    componentCount: number;
}

interface StudioStatsResponse {
    entities: {
        active: number;
        deleted: number;
        total: number;
    };
    componentTypes: ComponentTypeStats[];
    archetypes: ArcheTypeStats[];
}

interface ComponentTypeInfo {
    name: string;
    entityCount: number;
    partitionTable: string;
    fields: string[];
}

interface StudioComponentsResponse {
    components: ComponentTypeInfo[];
}

interface StudioQueryRequest {
    sql: string;
}

interface StudioQueryResponse {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    duration: number;
}

export type {
    StudioTableQueryParams,
    StudioArcheTypeQueryParams,
    TableColumn,
    TableRowData,
    StudioTableResponse,
    ArcheTypeField,
    ArcheTypeEntityRecord,
    StudioArcheTypeResponse,
    DeleteTableRowsRequest,
    DeleteArcheTypeEntitiesRequest,
    DeleteResponse,
    EntityComponent,
    EntityInspectorResponse,
    ComponentTypeStats,
    ArcheTypeStats,
    StudioStatsResponse,
    ComponentTypeInfo,
    StudioComponentsResponse,
    StudioQueryRequest,
    StudioQueryResponse,
};