import db from "../database";
import type { EntityInspectorResponse } from "./types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    try {
        const entityResult = await db`
            SELECT id, created_at, updated_at, deleted_at
            FROM entities
            WHERE id = ${entityId}
        `;

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
        const componentsResult = await db`
            SELECT id, name, type_id, data, created_at, updated_at, deleted_at
            FROM components
            WHERE entity_id = ${entityId}
            ORDER BY name ASC, created_at ASC
        `;

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
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({
                error: `Failed to fetch entity: ${errorMessage}`,
            }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}
