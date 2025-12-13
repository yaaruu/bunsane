import { getSerializedMetadataStorage } from "../core/metadata";
import { findIndicatorComponentName } from "../studio/utils";
import db from "../database";
import type {
    StudioArcheTypeQueryParams,
    StudioArcheTypeResponse,
    DeleteArcheTypeEntitiesRequest,
    DeleteResponse,
    ArcheTypeField,
    ArcheTypeEntityRecord,
} from "./types";

export async function handleStudioArcheTypeRecordsRequest(
    archeTypeName: string,
    params: StudioArcheTypeQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search ?? "";

    try {
        const metadataStorage = getSerializedMetadataStorage();
        const archeTypeFields: ArcheTypeField[] | undefined =
            metadataStorage.archeTypes[archeTypeName];

        if (!archeTypeFields || archeTypeFields.length === 0) {
            return new Response(
                JSON.stringify({
                    error: `ArcheType '${archeTypeName}' not found`,
                }),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const indicatorComponentName = findIndicatorComponentName(
            archeTypeName,
            archeTypeFields
        );

        if (!indicatorComponentName) {
            return new Response(
                JSON.stringify({
                    error: `No indicator component found for '${archeTypeName}'`,
                }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const requiredComponentNames = archeTypeFields
            .filter((field) => !field?.nullable)
            .map((field) => field.componentName);

        const requiredComponentCount = requiredComponentNames.length;

        let entityIdsResult: { entity_id: string }[];
        let totalResult: { count: number }[];

        const batchSize = limit * 3;
        let currentOffset = offset;
        const validEntities: ArcheTypeEntityRecord[] = [];
        let hasMoreData = true;

        while (validEntities.length < limit && hasMoreData) {
            if (searchTerm) {
                const searchPattern = `%${searchTerm}%`;
                const componentNamePlaceholders = requiredComponentNames
                    .map((_, index) => `$${index + 2}`)
                    .join(", ");

                // First find entities that have all required components (archetype membership)
                // Then filter by search term in any of their components
                entityIdsResult = await db.unsafe(
                    `SELECT entity_id FROM (
                         SELECT entity_id, MAX(created_at) as max_created_at
                         FROM components
                         WHERE deleted_at IS NULL
                         GROUP BY entity_id
                         HAVING COUNT(DISTINCT CASE WHEN name IN (${componentNamePlaceholders}) THEN name END) = $${
                        requiredComponentNames.length + 2
                    }
                     ) archetype_entities
                     WHERE entity_id IN (
                         SELECT DISTINCT entity_id
                         FROM components
                         WHERE deleted_at IS NULL
                         AND (
                             data::text ILIKE $1
                             OR id::text ILIKE $1
                             OR entity_id::text ILIKE $1
                         )
                     )
                     ORDER BY max_created_at DESC
                     LIMIT $${requiredComponentNames.length + 3} OFFSET $${
                        requiredComponentNames.length + 4
                    }`,
                    [
                        searchPattern,
                        ...requiredComponentNames,
                        requiredComponentCount,
                        batchSize,
                        currentOffset,
                    ]
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

            const entityIds = entityIdsResult.map((row) => row.entity_id);

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
                entityComponentsMap
                    .get(entityId)!
                    .set(componentName, componentData);
            }

            for (const entityId of entityIds) {
                const componentsMap = entityComponentsMap.get(entityId);

                if (
                    componentsMap &&
                    componentsMap.size === requiredComponentCount
                ) {
                    const allComponentsPresent = requiredComponentNames.every(
                        (name) => componentsMap.has(name)
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
            const componentNamePlaceholders = requiredComponentNames
                .map((_, index) => `$${index + 2}`)
                .join(", ");

            totalResult = await db.unsafe(
                `SELECT COUNT(DISTINCT c.entity_id) as count
                 FROM components c
                 WHERE c.deleted_at IS NULL
                 AND (
                     c.data::text ILIKE $1
                     OR c.id::text ILIKE $1
                     OR c.entity_id::text ILIKE $1
                 )
                 AND c.entity_id IN (
                     SELECT entity_id
                     FROM components
                     WHERE deleted_at IS NULL
                     GROUP BY entity_id
                     HAVING COUNT(DISTINCT CASE WHEN name IN (${componentNamePlaceholders}) THEN name END) = $${
                    requiredComponentNames.length + 2
                }
                 )`,
                [
                    searchPattern,
                    ...requiredComponentNames,
                    requiredComponentCount,
                ]
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
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({
                error: `Failed to fetch archetype data: ${errorMessage}`,
            }),
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
            JSON.stringify({
                error: "entityIds array is required and must not be empty",
            }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    try {
        const idPlaceholders = entityIds
            .map((_, index) => `$${index + 1}`)
            .join(", ");

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
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({
                error: `Failed to delete entities: ${errorMessage}`,
            }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}
