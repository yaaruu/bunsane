import type { SQL } from 'bun';
import db from '../index';
import { logger as MainLogger } from '../../core/Logger';
import { getMetadataStorage } from '../../core/metadata';
import type { Entity } from '../../core/Entity';
import type { ProjectionDescriptor, ProjectionStatus } from './types';
import { deriveProjectionDescriptor } from './ProjectionMetadata';
import { buildDependencyMap } from './DependencyMap';
import { projectEntity } from './projectEntity';
import { createCoveringIndex, createRmTable, rmTableName, assertRmTableName } from './DDLGenerator';
import { assertIdentifier } from '../../query/SqlIdentifier';
import { qspActive, qspMode, qspInScope } from './qspConfig';

const logger = MainLogger.child({ scope: 'ProjectionManager' });

export class ProjectionManager {
    static get enabled(): boolean { return qspActive(); }
    private static _instance: ProjectionManager | null = null;

    static get instance(): ProjectionManager {
        return (this._instance ??= new ProjectionManager());
    }

    static reset(): void {
        this._instance?.stopPoll();
        this._instance = null;
    }

    private descriptors = new Map<string, ProjectionDescriptor>();
    private dependencyMap = new Map<string, string[]>();
    private statusCache = new Map<string, ProjectionStatus>();
    private shadowCounters = new Map<string, { compared: number; diverged: number }>();
    private ensuring = new Set<string>();
    private pollHandle: ReturnType<typeof setInterval> | null = null;
    private archetypeNames: string[] = [];

    private coveringIndexOpts(descriptor: ProjectionDescriptor): { equalityColumns: string[]; sortColumn?: string; sortDir: 'DESC' } {
        const equalityColumns = descriptor.columns
            .filter(col => col.sqlType === 'text' || col.sqlType === 'boolean' || col.sqlType === 'timestamptz')
            .map(col => col.columnName);
        const sortColumn = descriptor.columns.find(col => col.sqlType === 'numeric')?.columnName;
        return { equalityColumns, sortColumn, sortDir: 'DESC' };
    }

    private registerArchetype(archetype: string, descriptor: ProjectionDescriptor): void {
        this.descriptors.set(archetype, descriptor);
        if (!this.archetypeNames.includes(archetype)) this.archetypeNames.push(archetype);
        this.dependencyMap = buildDependencyMap(this.archetypeNames);
    }

    async initialize(): Promise<void> {
        if (!qspActive()) return;

        this.archetypeNames = (process.env.BUNSANE_QSP_ARCHETYPES ?? '')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);

        for (const archetypeName of this.archetypeNames) {
            try {
                const descriptor = deriveProjectionDescriptor(archetypeName);
                this.descriptors.set(archetypeName, descriptor);
                await createRmTable(archetypeName, descriptor.columns);
                await createCoveringIndex(archetypeName, this.coveringIndexOpts(descriptor));

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
        this.startPoll();
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

    /**
     * Lazy trigger for a covered query. Idempotent across calls and instances:
     * INSERT ... 'BACKFILLING' ON CONFLICT DO NOTHING - only the winner creates rm_ + index + kicks
     * the backfill. dual-write-FIRST: the rm_ table is created and the archetype registered locally
     * (dual-write live) BEFORE the backfill scan, so live writes during backfill are captured.
     */
    async ensureProjection(archetype: string): Promise<void> {
        if (!qspActive() || !qspInScope(archetype)) return;
        if (this.descriptors.has(archetype)) return;
        if (this.ensuring.has(archetype)) return;
        this.ensuring.add(archetype);
        try {
            const descriptor = deriveProjectionDescriptor(archetype);
            const rows = await db.unsafe(
                `INSERT INTO projection_state (archetype, shape_hash, status, shape_version)
                 VALUES ($1, $2, 'BACKFILLING', $3)
                 ON CONFLICT (archetype) DO NOTHING
                 RETURNING archetype`,
                [descriptor.archetype, descriptor.shapeHash, descriptor.shapeVersion]
            );
            const won = rows.length > 0;
            await createRmTable(archetype, descriptor.columns);
            if (won) {
                await createCoveringIndex(archetype, this.coveringIndexOpts(descriptor));
            }
            this.registerArchetype(archetype, descriptor);
            const s = await db.unsafe(`SELECT status FROM projection_state WHERE archetype = $1`, [archetype]);
            this.statusCache.set(archetype, (s[0]?.status ?? 'BACKFILLING') as ProjectionStatus);
            this.startPoll();
            if (won) {
                const { run } = await import('./BackfillJob');
                void run(archetype).catch(err => logger.warn(`ensureProjection backfill failed for ${archetype}: ${err}`));
            }
        } catch (err) {
            logger.warn(`ensureProjection(${archetype}) failed: ${err}`);
        } finally {
            this.ensuring.delete(archetype);
        }
    }

    async syncActiveProjections(): Promise<void> {
        if (!qspActive()) return;
        try {
            const rows = await db.unsafe(
                `SELECT archetype, status FROM projection_state WHERE status IN ('BACKFILLING','SHADOW','READY')`
            );
            for (const row of rows) {
                const archetype = row.archetype as string;
                if (!qspInScope(archetype)) continue;
                if (!this.descriptors.has(archetype)) {
                    try {
                        const descriptor = deriveProjectionDescriptor(archetype);
                        await createRmTable(archetype, descriptor.columns);
                        this.registerArchetype(archetype, descriptor);
                    } catch (e) {
                        logger.warn(`syncActiveProjections: cannot register ${archetype}: ${e}`);
                        continue;
                    }
                }
                this.statusCache.set(archetype, row.status as ProjectionStatus);
            }
        } catch (err) {
            logger.warn(`syncActiveProjections failed: ${err}`);
        }
    }

    startPoll(intervalMs = 30_000): void {
        if (this.pollHandle) return;
        this.pollHandle = setInterval(() => { void this.syncActiveProjections(); }, intervalMs);
        if (typeof (this.pollHandle as any).unref === 'function') (this.pollHandle as any).unref();
    }

    stopPoll(): void {
        if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
    }

    getShadowCounters(archetype: string): { compared: number; diverged: number } {
        return this.shadowCounters.get(archetype) ?? { compared: 0, diverged: 0 };
    }

    /**
     * Called by ShadowRunner after each rm_ vs legacy comparison.
     * Clean compares accumulate; once compared >= BUNSANE_QSP_PROMOTE_MIN (default 50) with zero
     * divergences AND qspMode()==='route' AND current status is SHADOW, promote SHADOW -> READY.
     * A divergence blocks promotion, triggers a reconcile, and resets the counters so the
     * archetype must re-prove from scratch. qspMode()!=='route' (i.e. 'shadow') never promotes.
     */
    async recordShadowSample(archetype: string, diverged: boolean): Promise<void> {
        if (diverged) {
            this.shadowCounters.set(archetype, { compared: 0, diverged: 0 });
            try {
                const { reconcileArchetype } = await import('./ReconcileSweep');
                await reconcileArchetype(archetype);
            } catch { /* reconcile is best-effort */ }
            return;
        }
        const c = this.shadowCounters.get(archetype) ?? { compared: 0, diverged: 0 };
        c.compared++;
        this.shadowCounters.set(archetype, c);
        const min = parseInt(process.env.BUNSANE_QSP_PROMOTE_MIN ?? '50', 10);
        if (qspMode() === 'route' && this.getStatus(archetype) === 'SHADOW' && c.compared >= min && c.diverged === 0) {
            await this.setStatus(archetype, 'READY');
        }
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
            if (status !== 'BACKFILLING' && status !== 'SHADOW' && status !== 'READY') continue;

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
            if (status !== 'BACKFILLING' && status !== 'SHADOW' && status !== 'READY') continue;

            const tableName = assertRmTableName(rmTableName(archetype));
            if (force) {
                await trx.unsafe(`DELETE FROM ${tableName} WHERE entity_id = $1`, [entityId]);
            } else {
                await trx.unsafe(`UPDATE ${tableName} SET deleted_at = NOW() WHERE entity_id = $1 AND deleted_at IS NULL`, [entityId]);
            }
        }
    }
}
