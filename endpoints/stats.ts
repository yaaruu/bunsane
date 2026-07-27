import { studioDeadline, studioExec, studioErrorResponse } from "./db";
import { getSerializedMetadataStorage } from "../core/metadata";
import type { StudioStatsResponse, ComponentTypeStats, ArcheTypeStats } from "./types";

export async function handleStudioStatsRequest(): Promise<Response> {
    const deadline = studioDeadline();

    try {
        // Three unbounded COUNT(*) scans issued at once. Under the background
        // lane that is now a bounded burst rather than three slots taken from
        // request traffic simultaneously; if the lane is full they queue against
        // the shared deadline instead of the driver's.
        const [activeCountResult, deletedCountResult, componentTypesResult] =
            await Promise.all([
                studioExec<any[]>("studio.stats.entities.active", deadline,
                    `SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NULL`),
                studioExec<any[]>("studio.stats.entities.deleted", deadline,
                    `SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NOT NULL`),
                studioExec<Record<string, unknown>[]>("studio.stats.componentTypes", deadline,
                    `SELECT name, COUNT(*) as count FROM components WHERE deleted_at IS NULL GROUP BY name ORDER BY count DESC`),
            ]);

        const activeCount = Number(activeCountResult[0]?.count ?? 0);
        const deletedCount = Number(deletedCountResult[0]?.count ?? 0);

        const componentTypes: ComponentTypeStats[] = componentTypesResult.map(
            (row: Record<string, unknown>) => ({
                name: row.name as string,
                count: Number(row.count),
            })
        );

        // Derive archetype stats from metadata + component counts
        const metadata = getSerializedMetadataStorage();
        const componentCountMap = new Map(
            componentTypes.map((ct) => [ct.name, ct.count])
        );

        const archetypes: ArcheTypeStats[] = [];
        for (const [name, fields] of Object.entries(metadata.archeTypes)) {
            const requiredComponents = fields.filter((f) => !f.nullable);
            const indicatorComponent =
                requiredComponents.find((f) =>
                    f.componentName.endsWith("Tag")
                ) ?? requiredComponents[0];

            archetypes.push({
                name,
                entityCount: indicatorComponent
                    ? componentCountMap.get(indicatorComponent.componentName) ?? 0
                    : 0,
                componentCount: fields.length,
            });
        }

        archetypes.sort((a, b) => b.entityCount - a.entityCount);

        const responseData: StudioStatsResponse = {
            entities: {
                active: activeCount,
                deleted: deletedCount,
                total: activeCount + deletedCount,
            },
            componentTypes,
            archetypes,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return studioErrorResponse(error, "Failed to fetch stats");
    }
}
