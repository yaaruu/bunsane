import db from "../database";
import { getSerializedMetadataStorage } from "../core/metadata";
import type { StudioStatsResponse, ComponentTypeStats, ArcheTypeStats } from "./types";

export async function handleStudioStatsRequest(): Promise<Response> {
    try {
        // Run entity counts and component type counts in parallel
        const [activeCountResult, deletedCountResult, componentTypesResult] =
            await Promise.all([
                db`SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NULL`,
                db`SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NOT NULL`,
                db`SELECT name, COUNT(*) as count FROM components WHERE deleted_at IS NULL GROUP BY name ORDER BY count DESC`,
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
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({
                error: `Failed to fetch stats: ${errorMessage}`,
            }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}
