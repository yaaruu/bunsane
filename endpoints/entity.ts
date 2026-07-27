import { studioDeadline, studioExec, studioErrorResponse } from "./db";
import type {
    EntityInspectorResponse,
    StudioEntityListQueryParams,
    StudioEntityListResponse,
    EntityListItem,
} from "./types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleEntityListRequest(
    params: StudioEntityListQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search?.trim() ?? "";
    const includeDeleted = params.include_deleted ?? false;

    const deletedFilter = includeDeleted ? "" : "AND e.deleted_at IS NULL";

    const deadline = studioDeadline();

    try {
        let rows: Record<string, unknown>[];
        let totalResult: { count: number }[];

        if (searchTerm) {
            const searchPattern = `%${searchTerm}%`;
            rows = await studioExec(
                "studio.entity.list.search",
                deadline,
                `SELECT e.id, e.created_at, e.updated_at, e.deleted_at,
                        (SELECT COUNT(*) FROM components c
                         WHERE c.entity_id = e.id AND c.deleted_at IS NULL) AS component_count
                 FROM entities e
                 WHERE e.id::text ILIKE $1 ${deletedFilter}
                 ORDER BY e.created_at DESC NULLS LAST
                 LIMIT $2 OFFSET $3`,
                [searchPattern, limit, offset]
            );
            totalResult = await studioExec(
                "studio.entity.count.search",
                deadline,
                `SELECT COUNT(*) AS count FROM entities e
                 WHERE e.id::text ILIKE $1 ${deletedFilter}`,
                [searchPattern]
            );
        } else {
            rows = await studioExec(
                "studio.entity.list",
                deadline,
                `SELECT e.id, e.created_at, e.updated_at, e.deleted_at,
                        (SELECT COUNT(*) FROM components c
                         WHERE c.entity_id = e.id AND c.deleted_at IS NULL) AS component_count
                 FROM entities e
                 WHERE TRUE ${deletedFilter}
                 ORDER BY e.created_at DESC NULLS LAST
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            totalResult = await studioExec(
                "studio.entity.count",
                deadline,
                `SELECT COUNT(*) AS count FROM entities e WHERE TRUE ${deletedFilter}`
            );
        }

        const entities: EntityListItem[] = rows.map((row) => ({
            id: row.id as string,
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
            deleted_at: (row.deleted_at as string) ?? null,
            component_count: Number(row.component_count ?? 0),
        }));

        const responseData: StudioEntityListResponse = {
            entities,
            total: Number(totalResult[0]?.count ?? 0),
            limit,
            offset,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return studioErrorResponse(error, "Failed to fetch entities");
    }
}

export async function handleEntityInspectorRequest(
    entityId: string
): Promise<Response> {
    if (!entityId || !UUID_REGEX.test(entityId)) {
        return new Response(
            JSON.stringify({ error: "Invalid entity ID format. Expected a UUID." }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    const deadline = studioDeadline();

    try {
        const entityResult = await studioExec<any[]>(
            "studio.entity.inspect",
            deadline,
            `SELECT id, created_at, updated_at, deleted_at
             FROM entities
             WHERE id = $1`,
            [entityId],
        );

        if (entityResult.length === 0) {
            return new Response(
                JSON.stringify({ error: `Entity '${entityId}' not found` }),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const entity = entityResult[0];

        // Fetch ALL components for this entity (including soft-deleted)
        const componentsResult = await studioExec<Record<string, unknown>[]>(
            "studio.entity.inspect.components",
            deadline,
            `SELECT id, name, type_id, data, created_at, updated_at, deleted_at
             FROM components
             WHERE entity_id = $1
             ORDER BY name ASC, created_at ASC`,
            [entityId],
        );

        const responseData: EntityInspectorResponse = {
            entity: {
                id: entity.id as string,
                created_at: entity.created_at as string,
                updated_at: entity.updated_at as string,
                deleted_at: (entity.deleted_at as string) ?? null,
            },
            components: componentsResult.map((row: Record<string, unknown>) => ({
                id: row.id as string,
                name: row.name as string,
                type_id: row.type_id as string,
                data: row.data as unknown,
                created_at: row.created_at as string,
                updated_at: row.updated_at as string,
                deleted_at: (row.deleted_at as string) ?? null,
            })),
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return studioErrorResponse(error, "Failed to fetch entity");
    }
}
