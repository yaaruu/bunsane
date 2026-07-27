import { getSerializedMetadataStorage } from "../core/metadata";
import { findIndicatorComponentName } from "../utils/archetypeIndicator";
import { studioDeadline, studioExec, studioErrorResponse } from "./db";
import { dbExec, dbTransaction } from "../database/gateway";
import { logger as MainLogger } from "../core/Logger";
import { ProjectionManager, rmTableName, assertRmTableName } from "../database/projection";
import type {
    StudioArcheTypeQueryParams,
    StudioArcheTypeResponse,
    DeleteArcheTypeEntitiesRequest,
    DeleteResponse,
    ArcheTypeField,
    ArcheTypeEntityRecord,
} from "./types";

const logger = MainLogger.child({ scope: "archetypes-endpoint" });

export async function handleStudioArcheTypeRecordsRequest(
    archeTypeName: string,
    params: StudioArcheTypeQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search ?? "";
    const includeDeleted = params.include_deleted ?? false;

    // Conditional filter: include or exclude soft-deleted rows
    const deletedFilter = includeDeleted ? "" : "AND c.deleted_at IS NULL";
    const deletedFilterBare = includeDeleted ? "" : "AND deleted_at IS NULL";

    // One budget for the whole handler. The loop below keeps fetching batches
    // until it has filled a page, so the number of statements is data-dependent
    // and unbounded in principle — a per-query timeout would bound none of it.
    // A shared deadline also terminates the loop when the budget runs out,
    // rather than letting it grind against a slow database indefinitely.
    const deadline = studioDeadline();

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

        const allComponentNames = archeTypeFields.map(
            (field) => field.componentName
        );

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

                entityIdsResult = await studioExec(
                    "studio.archetype.entityIds.search",
                    deadline,
                    `SELECT entity_id FROM (
                         SELECT entity_id, MAX(created_at) as max_created_at
                         FROM components
                         WHERE TRUE ${deletedFilterBare}
                         GROUP BY entity_id
                         HAVING COUNT(DISTINCT CASE WHEN name IN (${componentNamePlaceholders}) THEN name END) = $${
                        requiredComponentNames.length + 2
                    }
                     ) archetype_entities
                     WHERE entity_id IN (
                         SELECT DISTINCT entity_id
                         FROM components
                         WHERE TRUE ${deletedFilterBare}
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
                entityIdsResult = await studioExec(
                    "studio.archetype.entityIds",
                    deadline,
                    `SELECT entity_id FROM (
                         SELECT c.entity_id, MAX(c.created_at) as max_created_at
                         FROM components c
                         WHERE c.name = $1
                         ${deletedFilter}
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
            const componentNamePlaceholders = allComponentNames
                .map((_, index) => `$${componentNameStartIndex + index}`)
                .join(", ");

            const componentsResult = await studioExec(
                "studio.archetype.components",
                deadline,
                `SELECT c.entity_id, c.name, c.data
                 FROM components c
                 WHERE c.entity_id IN (${entityIdPlaceholders})
                 AND c.name IN (${componentNamePlaceholders})
                 ${deletedFilter}`,
                [...entityIds, ...allComponentNames]
            );

            // When including deleted, also fetch entity-level deleted_at
            let entityDeletedMap = new Map<string, string | null>();
            if (includeDeleted) {
                const entitiesResult = await studioExec<Record<string, unknown>[]>(
                    "studio.archetype.entityDeleted",
                    deadline,
                    `SELECT id, deleted_at FROM entities WHERE id IN (${entityIdPlaceholders})`,
                    entityIds
                );
                for (const row of entitiesResult) {
                    entityDeletedMap.set(
                        row.id as string,
                        (row.deleted_at as string) ?? null
                    );
                }
            }

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

                if (!componentsMap) {
                    continue;
                }

                const allRequiredComponentsPresent =
                    requiredComponentNames.every((name) =>
                        componentsMap.has(name)
                    );

                if (allRequiredComponentsPresent) {
                    const componentsObject: Record<string, unknown> = {};
                    for (const [name, data] of componentsMap) {
                        componentsObject[name] = data;
                    }

                    const record: ArcheTypeEntityRecord = {
                        entityId,
                        components: componentsObject,
                    };

                    if (includeDeleted) {
                        record.deleted_at = entityDeletedMap.get(entityId) ?? null;
                    }

                    validEntities.push(record);

                    if (validEntities.length >= limit) {
                        break;
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

            totalResult = await studioExec(
                "studio.archetype.count.search",
                deadline,
                `SELECT COUNT(DISTINCT c.entity_id) as count
                 FROM components c
                 WHERE TRUE ${deletedFilter}
                 AND (
                     c.data::text ILIKE $1
                     OR c.id::text ILIKE $1
                     OR c.entity_id::text ILIKE $1
                 )
                 AND c.entity_id IN (
                     SELECT entity_id
                     FROM components
                     WHERE TRUE ${deletedFilterBare}
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
            totalResult = await studioExec(
                "studio.archetype.count",
                deadline,
                `SELECT COUNT(DISTINCT c.entity_id) as count
                 FROM components c
                 WHERE c.name = $1
                 ${deletedFilter}`,
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
        return studioErrorResponse(error, "Failed to fetch archetype data");
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

        const deadline = studioDeadline();

        // The two core deletes are now one transaction. They were separate
        // autocommit statements: a failure on the second left every component
        // row gone and its entity row behind, which is an entity that exists and
        // has nothing — the delete "half succeeded" with a 500 and no way to
        // tell how far it got. One transaction also takes ONE admission permit
        // for the pair instead of competing for two.
        await dbTransaction(
            async (trx: any) => {
                // Order still matters for the FK, now within the transaction.
                await dbExec(
                    `DELETE FROM components WHERE entity_id IN (${idPlaceholders})`,
                    entityIds,
                    { conn: trx, lane: "background", label: "studio.archetype.delete.components", deadline },
                );
                await dbExec(
                    `DELETE FROM entities WHERE id IN (${idPlaceholders})`,
                    entityIds,
                    { conn: trx, lane: "background", label: "studio.archetype.delete.entities", deadline },
                );
            },
            { lane: "background", label: "studio.archetype.delete", deadline },
        );

        // Projection cleanup stays OUTSIDE that transaction, deliberately. It is
        // best-effort (failures only warn), and a swallowed error inside a
        // transaction is worse than useless: Postgres aborts the transaction on
        // the first failed statement, so catching it and continuing would turn
        // the COMMIT into a ROLLBACK and silently undo the deletes above while
        // reporting success.
        if (ProjectionManager.enabled) {
            try {
                for (const archetype of ProjectionManager.instance.getArchetypeNames()) {
                    const tableName = assertRmTableName(rmTableName(archetype));
                    await studioExec(
                        "studio.archetype.delete.projection",
                        deadline,
                        `DELETE FROM ${tableName} WHERE entity_id IN (${idPlaceholders})`,
                        entityIds
                    );
                }
            } catch (error) {
                logger.warn(`Failed to clean projection rows for bulk delete: ${error}`);
            }
        }

        const responseData: DeleteResponse = {
            success: true,
            deletedCount: entityIds.length,
            message: `Successfully deleted ${entityIds.length} entity(ies) of type ${archeTypeName}`,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return studioErrorResponse(error, "Failed to delete entities");
    }
}
