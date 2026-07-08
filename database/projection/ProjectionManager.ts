import type { SQL } from 'bun';
import db from '../index';
import { logger as MainLogger } from '../../core/Logger';
import type { Entity } from '../../core/Entity';
import type { ProjectionDescriptor, ProjectionStatus } from './types';
import { deriveProjectionDescriptor } from './ProjectionMetadata';
import { buildDependencyMap } from './DependencyMap';
import { projectEntity } from './projectEntity';
import { createCoveringIndex, createRmTable, rmTableName, assertRmTableName } from './DDLGenerator';
import { assertIdentifier } from '../../query/SqlIdentifier';

const logger = MainLogger.child({ scope: 'ProjectionManager' });

export class ProjectionManager {
    static enabled = false;
    private static _instance: ProjectionManager | null = null;

    static get instance(): ProjectionManager {
        return (this._instance ??= new ProjectionManager());
    }

    static reset(): void {
        this._instance = null;
        this.enabled = false;
    }

    private descriptors = new Map<string, ProjectionDescriptor>();
    private dependencyMap = new Map<string, string[]>();
    private statusCache = new Map<string, ProjectionStatus>();
    private archetypeNames: string[] = [];

    async initialize(): Promise<void> {
        if (process.env.BUNSANE_QSP_ENABLED !== 'true') return;

        this.archetypeNames = (process.env.BUNSANE_QSP_ARCHETYPES ?? '')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);

        for (const archetypeName of this.archetypeNames) {
            try {
                const descriptor = deriveProjectionDescriptor(archetypeName);
                this.descriptors.set(archetypeName, descriptor);
                await createRmTable(archetypeName, descriptor.columns);

                const equalityColumns = descriptor.columns
                    .filter(col => col.sqlType === 'text' || col.sqlType === 'boolean' || col.sqlType === 'timestamptz')
                    .map(col => col.columnName);
                const sortColumn = descriptor.columns.find(col => col.sqlType === 'numeric')?.columnName;
                await createCoveringIndex(archetypeName, { equalityColumns, sortColumn, sortDir: 'DESC' });

                await db.unsafe(
                    `INSERT INTO projection_state (archetype, shape_hash, status, shape_version)
                     VALUES ($1, $2, 'DISABLED', $3)
                     ON CONFLICT (archetype) DO UPDATE SET shape_hash = EXCLUDED.shape_hash`,
                    [descriptor.archetype, descriptor.shapeHash, descriptor.shapeVersion]
                );
                const rows = await db.unsafe(`SELECT status FROM projection_state WHERE archetype = $1`, [descriptor.archetype]);
                this.statusCache.set(archetypeName, (rows[0]?.status ?? 'DISABLED') as ProjectionStatus);
            } catch (error) {
                logger.warn(`Failed to initialize projection for ${archetypeName}: ${error}`);
            }
        }

        this.dependencyMap = buildDependencyMap(this.archetypeNames);
        ProjectionManager.enabled = true;
    }

    getStatus(archetype: string): ProjectionStatus {
        return this.statusCache.get(archetype) ?? 'DISABLED';
    }

    async setStatus(archetype: string, status: ProjectionStatus, trx?: SQL): Promise<void> {
        await (trx ?? db).unsafe(
            `UPDATE projection_state SET status = $1, updated_at = now() WHERE archetype = $2`,
            [status, archetype]
        );
        this.statusCache.set(archetype, status);
        // Invalidate planner TTL cache so BACKFILLING→READY / rollback→DISABLED
        // take effect on the next query without waiting 30s. Dynamic import avoids
        // a database/projection ↔ query/planner cycle. Cross-instance (multi-process)
        // invalidation remains the documented SEAM in PlannerCache (30s TTL backstop).
        try {
            const { PlannerCache } = await import('../../query/planner/PlannerCache');
            PlannerCache.instance.invalidate(archetype);
        } catch {
            /* planner may not be loaded in some contexts; TTL is the backstop */
        }
    }

    getDescriptor(archetype: string): ProjectionDescriptor | undefined {
        return this.descriptors.get(archetype);
    }

    getArchetypeNames(): string[] {
        return [...this.archetypeNames];
    }

    getDependencyMap(): Map<string, string[]> {
        return this.dependencyMap;
    }

    async upsertProjection(entity: Entity, touchedTypeIds: string[], trx: SQL): Promise<void> {
        if (!ProjectionManager.enabled) return;

        const archetypes = new Set<string>();
        for (const typeId of touchedTypeIds) {
            for (const archetype of this.dependencyMap.get(typeId) ?? []) {
                archetypes.add(archetype);
            }
        }

        for (const archetype of archetypes) {
            const status = this.getStatus(archetype);
            if (status !== 'BACKFILLING' && status !== 'READY') continue;

            const descriptor = this.descriptors.get(archetype);
            if (!descriptor) continue;

            const row = projectEntity(entity, descriptor);
            const projectedColumns = Object.keys(row).map(col => assertIdentifier(col, 'projectedColumn'));
            const tableName = assertRmTableName(rmTableName(archetype));
            const insertColumns = ['entity_id', ...projectedColumns, 'created_at', 'updated_at', 'deleted_at', 'shape_version'];
            const quotedInsertColumns = insertColumns.map(col => col === 'entity_id' || col === 'created_at' || col === 'updated_at' || col === 'deleted_at' || col === 'shape_version'
                ? col
                : `"${col}"`
            );
            const params = [entity.id, ...projectedColumns.map(col => row[col]), descriptor.shapeVersion];
            const valuePlaceholders = [
                '$1',
                ...projectedColumns.map((_, index) => `$${index + 2}`),
                '(SELECT created_at FROM entities WHERE id = $1)',
                '(SELECT updated_at FROM entities WHERE id = $1)',
                'NULL',
                `$${projectedColumns.length + 2}`,
            ];
            const projectedUpdates = projectedColumns.map(col => `"${col}" = EXCLUDED."${col}"`);
            const updates = [
                ...projectedUpdates,
                'updated_at = EXCLUDED.updated_at',
                'deleted_at = NULL',
                'shape_version = EXCLUDED.shape_version',
            ];

            // created_at/updated_at mirror the entities row exactly (for shadow parity on entity-column sorts and keysets).
            await trx.unsafe(
                `INSERT INTO ${tableName} (${quotedInsertColumns.join(', ')}) VALUES (${valuePlaceholders.join(', ')})
                 ON CONFLICT (entity_id) DO UPDATE SET ${updates.join(', ')}`,
                params
            );
        }
    }

    async deleteProjection(entityId: string, force: boolean, trx: SQL): Promise<void> {
        if (!ProjectionManager.enabled) return;

        for (const archetype of this.archetypeNames) {
            const status = this.getStatus(archetype);
            if (status !== 'BACKFILLING' && status !== 'READY') continue;

            const tableName = assertRmTableName(rmTableName(archetype));
            if (force) {
                await trx.unsafe(`DELETE FROM ${tableName} WHERE entity_id = $1`, [entityId]);
            } else {
                await trx.unsafe(`UPDATE ${tableName} SET deleted_at = NOW() WHERE entity_id = $1 AND deleted_at IS NULL`, [entityId]);
            }
        }
    }
}
