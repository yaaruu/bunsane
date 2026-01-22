/**
 * Data seeder for stress testing
 * Performs optimized bulk inserts for maximum throughput
 */
import db from '../../database';
import { sql } from 'bun';
import { ComponentRegistry } from '../../core/components';
import { getMetadataStorage } from '../../core/metadata';
import { uuidv7 } from '../../utils/uuid';
import type { BaseComponent } from '../../core/components/BaseComponent';

export interface SeederOptions {
    totalEntities: number;
    batchSize: number;
    onProgress?: (current: number, total: number, elapsedMs: number) => void;
}

export interface SeederResult {
    entityIds: string[];
    totalTime: number;
    recordsPerSecond: number;
}

type ComponentConstructor = new () => BaseComponent;

export class DataSeeder {
    /**
     * Seeds the database with test entities and components
     * Uses optimized bulk inserts for maximum throughput
     */
    async seed<T extends BaseComponent>(
        componentClass: ComponentConstructor,
        dataGenerator: (index: number) => Record<string, any>,
        options: SeederOptions
    ): Promise<SeederResult> {
        const { totalEntities, batchSize, onProgress } = options;
        const entityIds: string[] = [];
        const startTime = performance.now();

        // Ensure component is registered (just wait for readiness, don't trigger registration)
        const componentName = componentClass.name;
        await ComponentRegistry.getReadyPromise(componentName);

        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(componentName);

        for (let i = 0; i < totalEntities; i += batchSize) {
            const currentBatch = Math.min(batchSize, totalEntities - i);
            const now = new Date();

            // Build batch data arrays
            const entitiesToInsert: { id: string; created_at: Date; updated_at: Date }[] = [];
            const componentsToInsert: { id: string; entity_id: string; type_id: string; name: string; data: any; created_at: Date; updated_at: Date }[] = [];
            const entityComponentsToInsert: { entity_id: string; type_id: string; component_id: string; created_at: Date; updated_at: Date }[] = [];

            // Generate batch data
            for (let j = 0; j < currentBatch; j++) {
                const entityId = uuidv7();
                const componentId = uuidv7();
                const data = dataGenerator(i + j);

                entitiesToInsert.push({
                    id: entityId,
                    created_at: now,
                    updated_at: now
                });

                componentsToInsert.push({
                    id: componentId,
                    entity_id: entityId,
                    type_id: typeId,
                    name: componentName,
                    data: data,
                    created_at: now,
                    updated_at: now
                });

                entityComponentsToInsert.push({
                    entity_id: entityId,
                    type_id: typeId,
                    component_id: componentId,
                    created_at: now,
                    updated_at: now
                });

                entityIds.push(entityId);
            }

            // Bulk insert entities using Bun's sql helper
            await db`INSERT INTO entities ${sql(entitiesToInsert, 'id', 'created_at', 'updated_at')}`;

            // Bulk insert components
            await db`INSERT INTO components ${sql(componentsToInsert, 'id', 'entity_id', 'type_id', 'name', 'data', 'created_at', 'updated_at')}`;

            // Bulk insert entity_components index
            await db`INSERT INTO entity_components ${sql(entityComponentsToInsert, 'entity_id', 'type_id', 'component_id', 'created_at', 'updated_at')} ON CONFLICT (entity_id, type_id) DO NOTHING`;

            if (onProgress) {
                onProgress(i + currentBatch, totalEntities, performance.now() - startTime);
            }
        }

        const totalTime = performance.now() - startTime;

        return {
            entityIds,
            totalTime,
            recordsPerSecond: (totalEntities / totalTime) * 1000
        };
    }

    /**
     * Seeds multiple components for existing entities
     */
    async seedAdditionalComponent<T extends BaseComponent>(
        entityIds: string[],
        componentClass: ComponentConstructor,
        dataGenerator: (index: number, entityId: string) => Record<string, any>,
        batchSize: number = 5000
    ): Promise<void> {
        const componentName = componentClass.name;
        await ComponentRegistry.getReadyPromise(componentName);

        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(componentName);

        for (let i = 0; i < entityIds.length; i += batchSize) {
            const batchEntityIds = entityIds.slice(i, i + batchSize);
            const now = new Date();

            const componentsToInsert: { id: string; entity_id: string; type_id: string; name: string; data: any; created_at: Date; updated_at: Date }[] = [];
            const entityComponentsToInsert: { entity_id: string; type_id: string; component_id: string; created_at: Date; updated_at: Date }[] = [];

            for (let j = 0; j < batchEntityIds.length; j++) {
                const entityId = batchEntityIds[j];
                const componentId = uuidv7();
                const data = dataGenerator(i + j, entityId);

                componentsToInsert.push({
                    id: componentId,
                    entity_id: entityId,
                    type_id: typeId,
                    name: componentName,
                    data: data,
                    created_at: now,
                    updated_at: now
                });

                entityComponentsToInsert.push({
                    entity_id: entityId,
                    type_id: typeId,
                    component_id: componentId,
                    created_at: now,
                    updated_at: now
                });
            }

            await db`INSERT INTO components ${sql(componentsToInsert, 'id', 'entity_id', 'type_id', 'name', 'data', 'created_at', 'updated_at')}`;
            await db`INSERT INTO entity_components ${sql(entityComponentsToInsert, 'entity_id', 'type_id', 'component_id', 'created_at', 'updated_at')} ON CONFLICT (entity_id, type_id) DO NOTHING`;
        }
    }

    /**
     * Cleans up seeded data
     */
    async cleanup(entityIds: string[], batchSize: number = 10000): Promise<void> {
        for (let i = 0; i < entityIds.length; i += batchSize) {
            const batch = entityIds.slice(i, i + batchSize);
            // Use individual deletes for reliability
            await db`DELETE FROM entities WHERE id IN ${sql(batch.map(id => [id]))}`;
        }
    }

    /**
     * Runs VACUUM ANALYZE for optimal query planning
     */
    async optimize(): Promise<void> {
        await db.unsafe('VACUUM ANALYZE entities');
        await db.unsafe('VACUUM ANALYZE components');
        await db.unsafe('VACUUM ANALYZE entity_components');
    }

    /**
     * Gets the current record count
     */
    async getRecordCount(): Promise<number> {
        const result = await db`SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NULL`;
        return parseInt(result[0].count);
    }
}
