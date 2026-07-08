import db from '../index';
import { logger as MainLogger } from '../../core/Logger';
import { getDistributedLock } from '../../core/scheduler/DistributedLock';
import { getMetadataStorage } from '../../core/metadata';
import { assertIdentifier } from '../../query/SqlIdentifier';
import { ProjectionManager } from './ProjectionManager';
import { rmTableName, assertRmTableName } from './DDLGenerator';
import { recordDrift } from '../../query/planner/metrics';
import type { ProjectedColumn } from './types';

const logger = MainLogger.child({ scope: 'qsp.reconcile' });

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const assertTypeId = (typeId: string): string => {
    if (!/^[a-f0-9]{1,64}$/.test(typeId)) {
        throw new Error(`Invalid projection component type id: ${typeId}`);
    }
    return typeId;
};

const castFor = (column: ProjectedColumn): string => {
    if (column.sqlType === 'numeric') return '::numeric';
    if (column.sqlType === 'timestamptz') return '::timestamptz';
    if (column.sqlType === 'boolean') return '::boolean';
    return '';
};

export async function reconcileArchetype(archetypeName: string, sampleSize = 200): Promise<number> {
    if (!ProjectionManager.enabled) return 0;

    const lock = getDistributedLock();
    const taskId = `qsp-reconcile-${archetypeName}`;
    const res = await lock.tryAcquire(taskId);
    if (!res.acquired) return 0;

    try {
        const mgr = ProjectionManager.instance;
        const descriptor = mgr.getDescriptor(archetypeName);
        const status = mgr.getStatus(archetypeName);
        if (!descriptor || (status !== 'READY' && status !== 'SHADOW')) return 0;

        const table = assertRmTableName(rmTableName(archetypeName));
        const sampleRows = await db.unsafe(
            `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY random() LIMIT $1`,
            [sampleSize]
        );

        let mismatchCount = 0;
        const storage = getMetadataStorage();

        for (const row of sampleRows) {
            const entityId = row.entity_id;
            let rowMismatch = false;

            for (const col of descriptor.columns) {
                const colName = assertIdentifier(col.columnName, 'projectedColumn');
                const field = assertIdentifier(col.field, 'projectedField');
                const typeId = assertTypeId(storage.getComponentId(col.component) ?? '');
                const cast = castFor(col);
                const recomputeSql = `SELECT (c.data->>'${field}')${cast} AS v FROM components c WHERE c.entity_id = $1 AND c.type_id = '${typeId}' AND c.deleted_at IS NULL LIMIT 1`;
                const recomputedRows = await db.unsafe(recomputeSql, [entityId]);
                const recomputed = recomputedRows[0] ? recomputedRows[0].v : null;
                const actual = row[colName] ?? null;
                const normActual = actual == null ? null : String(actual);
                const normRe = recomputed == null ? null : String(recomputed);
                if (normActual !== normRe) {
                    rowMismatch = true;
                    break;
                }
            }

            if (rowMismatch) {
                mismatchCount++;
                // Re-project via INSERT..SELECT like backfill (single id, DO UPDATE for correction)
                const projectedColumns = descriptor.columns.map(col => assertIdentifier(col.columnName, 'projectedColumn'));
                const insertColumns = ['entity_id', ...projectedColumns, 'created_at', 'updated_at', 'deleted_at', 'shape_version'];
                const quotedInsertColumns = insertColumns.map(col => projectedColumns.includes(col) ? `"${col}"` : col).join(', ');
                const selectColumns = descriptor.columns.map(col => {
                    const columnName = assertIdentifier(col.columnName, 'projectedColumn');
                    const field = assertIdentifier(col.field, 'projectedField');
                    const typeId = assertTypeId(storage.getComponentId(col.component) ?? '');
                    return `(SELECT (c.data->>'${field}')${castFor(col)} FROM components c WHERE c.entity_id = e.id AND c.type_id = '${typeId}' AND c.deleted_at IS NULL LIMIT 1) AS "${columnName}"`;
                });
                const selectList = ['e.id', ...selectColumns, 'e.created_at', 'e.updated_at', 'e.deleted_at', '$2'].join(', ');
                const projectedUpdates = projectedColumns.map(col => `"${col}" = EXCLUDED."${col}"`);
                const updates = [
                    ...projectedUpdates,
                    'updated_at = EXCLUDED.updated_at',
                    'deleted_at = NULL',
                    'shape_version = EXCLUDED.shape_version',
                ];
                await db.unsafe(
                    `INSERT INTO ${table} (${quotedInsertColumns})
                     SELECT ${selectList}
                     FROM entities e
                     WHERE e.id = $1 AND e.deleted_at IS NULL
                     ON CONFLICT (entity_id) DO UPDATE SET ${updates.join(', ')}`,
                    [entityId, descriptor.shapeVersion]
                );
            }
        }

        if (mismatchCount > 0) {
            recordDrift(mismatchCount);
            logger.warn({ scope: 'qsp.reconcile', archetype: archetypeName, mismatches: mismatchCount }, 'QSP reconcile drift detected and repaired');
        }
        return mismatchCount;
    } finally {
        await lock.release(taskId);
    }
}

export function startReconcileSweep(intervalMs = 300_000): () => void {
    if (!ProjectionManager.enabled) return () => {};
    const handle = setInterval(() => {
        (async () => {
            for (const name of ProjectionManager.instance.getArchetypeNames()) {
                try {
                    await reconcileArchetype(name);
                } catch (e) {
                    logger.warn({ scope: 'qsp.reconcile', archetype: name, err: e }, 'Reconcile sweep iteration error (swallowed)');
                }
            }
        })();
    }, intervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    // Registered via core/scheduler DistributedLock for single-instance coordination; App lifecycle can call startReconcileSweep() at boot and the returned stop() at drain.
    return () => { clearInterval(handle); };
}
