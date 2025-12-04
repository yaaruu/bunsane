import db from "database";
import { getSerializedMetadataStorage } from "core/metadata";
import { findIndicatorComponentName } from "./utils";

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

export async function handleStudioTableRequest(
    tableName: string,
    params: StudioTableQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search ?? "";

    try {
        const columnsResult = await db`
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_name = ${tableName}
            AND table_schema = 'public'
            ORDER BY ordinal_position
        `;

        if (columnsResult.length === 0) {
            return new Response(
                JSON.stringify({ error: `Table '${tableName}' not found` }),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const primaryKeyResult = await db`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu 
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = ${tableName}
            AND tc.table_schema = 'public'
        `;
        const primaryKeyColumns = new Set(
            primaryKeyResult.map((row: { column_name: string }) => row.column_name)
        );

        const columns: TableColumn[] = columnsResult.map((col: {
            column_name: string;
            data_type: string;
            is_nullable: string;
        }) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            primary: primaryKeyColumns.has(col.column_name),
        }));

        const textColumns = columnsResult
            .filter((col: { data_type: string }) =>
                ["character varying", "text", "varchar", "char", "uuid"].includes(col.data_type)
            )
            .map((col: { column_name: string }) => col.column_name);

        let rows: TableRowData[];
        let totalResult: { count: number }[];

        if (searchTerm && textColumns.length > 0) {
            const searchPattern = `%${searchTerm}%`;
            const searchConditions = textColumns
                .map((col: string) => `"${col}"::text ILIKE $1`)
                .join(" OR ");

            rows = await db.unsafe(
                `SELECT * FROM "${tableName}" 
                 WHERE ${searchConditions}
                 ORDER BY created_at DESC NULLS LAST
                 LIMIT $2 OFFSET $3`,
                [searchPattern, limit, offset]
            );

            totalResult = await db.unsafe(
                `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${searchConditions}`,
                [searchPattern]
            );
        } else {
            rows = await db.unsafe(
                `SELECT * FROM "${tableName}" 
                 ORDER BY created_at DESC NULLS LAST
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            totalResult = await db.unsafe(
                `SELECT COUNT(*) as count FROM "${tableName}"`
            );
        }

        const total = Number(totalResult[0]?.count ?? 0);

        const responseData: StudioTableResponse = {
            name: tableName,
            columns,
            rows,
            total,
            limit,
            offset,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to fetch table data: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}

export function handleStudioArcheTypeRequest(archeTypeName: string): Response {
    const mockArcheTypeData = {
        name: archeTypeName,
        components: [
            { name: "PositionComponent", properties: ["x", "y", "z"] },
            { name: "VelocityComponent", properties: ["vx", "vy", "vz"] },
        ],
        entityCount: 128,
        metadata: {
            createdAt: new Date().toISOString(),
            version: "1.0.0",
        },
    };

    return new Response(JSON.stringify(mockArcheTypeData), {
        headers: { "Content-Type": "application/json" },
    });
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

export async function handleStudioArcheTypeRecordsRequest(
    archeTypeName: string,
    params: StudioArcheTypeQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search ?? "";

    try {
        const metadataStorage = getSerializedMetadataStorage();
        const archeTypeFields: ArcheTypeField[] | undefined = metadataStorage.archeTypes[archeTypeName];

        if (!archeTypeFields || archeTypeFields.length === 0) {
            return new Response(
                JSON.stringify({ error: `ArcheType '${archeTypeName}' not found` }),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const indicatorComponentName = findIndicatorComponentName(archeTypeName, archeTypeFields);

        if (!indicatorComponentName) {
            return new Response(
                JSON.stringify({ error: `No indicator component found for '${archeTypeName}'` }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const requiredComponentNames = archeTypeFields.map(field => field.componentName);
        const requiredComponentCount = requiredComponentNames.length;

        const componentPlaceholders = requiredComponentNames
            .map((_, index) => `$${index + 1}`)
            .join(", ");

        let entityIdsResult: { entity_id: string }[];
        let totalResult: { count: number }[];

        const batchSize = limit * 3;
        let currentOffset = offset;
        const validEntities: ArcheTypeEntityRecord[] = [];
        let hasMoreData = true;

        while (validEntities.length < limit && hasMoreData) {
            if (searchTerm) {
                const searchPattern = `%${searchTerm}%`;
                const searchParamIndex = requiredComponentNames.length + 1;

                entityIdsResult = await db.unsafe(
                    `SELECT entity_id FROM (
                         SELECT c.entity_id, MAX(c.created_at) as max_created_at
                         FROM components c
                         WHERE c.name = $1
                         AND c.deleted_at IS NULL
                         AND c.data::text ILIKE $${searchParamIndex}
                         GROUP BY c.entity_id
                         ORDER BY max_created_at DESC
                         LIMIT $${searchParamIndex + 1} OFFSET $${searchParamIndex + 2}
                     ) sub`,
                    [indicatorComponentName, searchPattern, batchSize, currentOffset]
                );
            } else {
                entityIdsResult = await db.unsafe(
                    `SELECT entity_id FROM (
                         SELECT c.entity_id, MAX(c.created_at) as max_created_at
                         FROM components c
                         WHERE c.name = $1
                         AND c.deleted_at IS NULL
                         GROUP BY c.entity_id
                         ORDER BY max_created_at DESC
                         LIMIT $2 OFFSET $3
                     ) sub`,
                    [indicatorComponentName, batchSize, currentOffset]
                );
            }

            if (entityIdsResult.length === 0) {
                hasMoreData = false;
                break;
            }

            const entityIds = entityIdsResult.map(row => row.entity_id);

            const entityIdPlaceholders = entityIds
                .map((_, index) => `$${index + 1}`)
                .join(", ");
            const componentNameStartIndex = entityIds.length + 1;
            const componentNamePlaceholders = requiredComponentNames
                .map((_, index) => `$${componentNameStartIndex + index}`)
                .join(", ");

            const componentsResult = await db.unsafe(
                `SELECT c.entity_id, c.name, c.data
                 FROM components c
                 WHERE c.entity_id IN (${entityIdPlaceholders})
                 AND c.name IN (${componentNamePlaceholders})
                 AND c.deleted_at IS NULL`,
                [...entityIds, ...requiredComponentNames]
            );

            const entityComponentsMap = new Map<string, Map<string, unknown>>();

            for (const row of componentsResult) {
                const entityId = row.entity_id as string;
                const componentName = row.name as string;
                const componentData = row.data as unknown;

                if (!entityComponentsMap.has(entityId)) {
                    entityComponentsMap.set(entityId, new Map());
                }
                entityComponentsMap.get(entityId)!.set(componentName, componentData);
            }

            for (const entityId of entityIds) {
                const componentsMap = entityComponentsMap.get(entityId);

                if (componentsMap && componentsMap.size === requiredComponentCount) {
                    const allComponentsPresent = requiredComponentNames.every(
                        name => componentsMap.has(name)
                    );

                    if (allComponentsPresent) {
                        const componentsObject: Record<string, unknown> = {};
                        for (const [name, data] of componentsMap) {
                            componentsObject[name] = data;
                        }

                        validEntities.push({
                            entityId,
                            components: componentsObject,
                        });

                        if (validEntities.length >= limit) {
                            break;
                        }
                    }
                }
            }

            currentOffset += batchSize;

            if (entityIdsResult.length < batchSize) {
                hasMoreData = false;
            }
        }

        if (searchTerm) {
            const searchPattern = `%${searchTerm}%`;
            totalResult = await db.unsafe(
                `SELECT COUNT(DISTINCT c.entity_id) as count
                 FROM components c
                 WHERE c.name = $1
                 AND c.deleted_at IS NULL
                 AND c.data::text ILIKE $2`,
                [indicatorComponentName, searchPattern]
            );
        } else {
            totalResult = await db.unsafe(
                `SELECT COUNT(DISTINCT c.entity_id) as count
                 FROM components c
                 WHERE c.name = $1
                 AND c.deleted_at IS NULL`,
                [indicatorComponentName]
            );
        }

        const total = Number(totalResult[0]?.count ?? 0);

        const responseData: StudioArcheTypeResponse = {
            name: archeTypeName,
            fields: archeTypeFields,
            indicatorComponent: indicatorComponentName,
            entities: validEntities,
            total,
            limit,
            offset,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to fetch archetype data: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
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

export async function handleStudioTableDeleteRequest(
    tableName: string,
    requestBody: DeleteTableRowsRequest
): Promise<Response> {
    const { ids } = requestBody;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return new Response(
            JSON.stringify({ error: "ids array is required and must not be empty" }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    try {
        const idPlaceholders = ids.map((_, index) => `$${index + 1}`).join(", ");

        const result = await db.unsafe(
            `DELETE FROM "${tableName}" WHERE id IN (${idPlaceholders})`,
            ids
        );

        const deletedCount = typeof result === "object" && result !== null && "count" in result
            ? Number(result.count)
            : ids.length;

        const responseData: DeleteResponse = {
            success: true,
            deletedCount,
            message: `Successfully deleted ${deletedCount} row(s) from ${tableName}`,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to delete rows: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}

export async function handleStudioArcheTypeDeleteRequest(
    archeTypeName: string,
    requestBody: DeleteArcheTypeEntitiesRequest
): Promise<Response> {
    const { entityIds } = requestBody;

    if (!entityIds || !Array.isArray(entityIds) || entityIds.length === 0) {
        return new Response(
            JSON.stringify({ error: "entityIds array is required and must not be empty" }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    try {
        const idPlaceholders = entityIds.map((_, index) => `$${index + 1}`).join(", ");

        // Delete in correct order to avoid foreign key constraint violations
        // 1. Delete from entity_components (junction table)
        await db.unsafe(
            `DELETE FROM entity_components WHERE entity_id IN (${idPlaceholders})`,
            entityIds
        );

        // 2. Delete from components
        await db.unsafe(
            `DELETE FROM components WHERE entity_id IN (${idPlaceholders})`,
            entityIds
        );

        // 3. Delete from entities
        await db.unsafe(
            `DELETE FROM entities WHERE id IN (${idPlaceholders})`,
            entityIds
        );

        const responseData: DeleteResponse = {
            success: true,
            deletedCount: entityIds.length,
            message: `Successfully deleted ${entityIds.length} entity(ies) of type ${archeTypeName}`,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to delete entities: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}

const studioEndpoint = {
    handleStudioTableRequest,
    handleStudioArcheTypeRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioTableDeleteRequest,
    handleStudioArcheTypeDeleteRequest,
};

export default studioEndpoint;
