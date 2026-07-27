import { studioDeadline, studioExec, studioErrorResponse } from "./db";
import { GenerateTableName } from "../database/DatabaseHelper";
import type { ComponentTypeInfo, StudioComponentsResponse } from "./types";

export async function handleStudioComponentsRequest(): Promise<Response> {
    // One budget for the whole handler. This endpoint is N+1 by construction —
    // one sample query per distinct component name — so a per-query timeout
    // would bound each of N statements and nothing at all in aggregate.
    const deadline = studioDeadline();

    try {
        // Get distinct component names with entity counts
        const componentRows = await studioExec<any[]>(
            "studio.components.list",
            deadline,
            `SELECT name, COUNT(DISTINCT entity_id) as entity_count
             FROM components
             WHERE deleted_at IS NULL
             GROUP BY name
             ORDER BY entity_count DESC`,
        );

        const components: ComponentTypeInfo[] = [];

        for (const row of componentRows) {
            const name = row.name as string;
            const entityCount = Number(row.entity_count);
            const partitionTable = GenerateTableName(name);

            // Get sample row to discover JSONB field shape
            const sampleResult = await studioExec<any[]>(
                "studio.components.sample",
                deadline,
                `SELECT data FROM components WHERE name = $1 AND deleted_at IS NULL AND data IS NOT NULL LIMIT 1`,
                [name]
            );

            let fields: string[] = [];
            if (sampleResult.length > 0 && sampleResult[0].data) {
                const sampleData = sampleResult[0].data;
                if (typeof sampleData === "object" && sampleData !== null) {
                    fields = Object.keys(sampleData as Record<string, unknown>);
                }
            }

            components.push({ name, entityCount, partitionTable, fields });
        }

        const responseData: StudioComponentsResponse = { components };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return studioErrorResponse(error, "Failed to fetch components");
    }
}
