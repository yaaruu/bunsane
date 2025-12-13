interface StudioTableQueryParams {
    limit?: number;
    offset?: number;
    search?: string;
}

interface StudioArcheTypeQueryParams {
    limit?: number;
    offset?: number;
    search?: string;
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
}

interface ArcheTypeEntityRecord {
    entityId: string;
    components: Record<string, unknown>;
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
};