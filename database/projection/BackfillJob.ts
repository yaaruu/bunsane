import { projExec } from './exec';
import { getMetadataStorage } from '../../core/metadata';
import { getDistributedLock } from '../../core/scheduler/DistributedLock';
import { assertIdentifier } from '../../query/SqlIdentifier';
import { ProjectionManager } from './ProjectionManager';
import { rmTableName, assertRmTableName } from './DDLGenerator';
import { assertTypeId, projectionSourceExpr } from './ProjectionSource';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Backfill `rm_<archetype>` from `components`, resuming from the watermark.
 * `resume`: started automatically for a row read as BACKFILLING. The status
 * is re-read under the lock, so a run that waited for another instance's
 * backfill to finish does not demote the now SHADOW/READY projection.
 */
export async function run(archetypeName: string, opts: { resume?: boolean } = {}): Promise<void> {
    if (!ProjectionManager.enabled) return;

    const lock = getDistributedLock();
    const taskId = `qsp-backfill-${archetypeName}`;
    const res = await lock.tryAcquire(taskId);
    if (!res.acquired) return;

    try {
        const mgr = ProjectionManager.instance;
        const descriptor = mgr.getDescriptor(archetypeName);
        if (!descriptor) return;

        const stateRows = await projExec<any[]>('projection.backfill.watermark',
            `SELECT status, watermark FROM projection_state WHERE archetype = $1`, [archetypeName]);
        if (opts.resume && stateRows[0]?.status !== 'BACKFILLING') return;

        await mgr.setStatus(archetypeName, 'BACKFILLING');

        let watermark = stateRows[0]?.watermark ?? ZERO_UUID;
        const batchSize = parseInt(process.env.BUNSANE_QSP_BACKFILL_BATCH ?? '5000', 10);
        const throttle = parseInt(process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS ?? '50', 10);
        const tableName = assertRmTableName(rmTableName(archetypeName));
        const storage = getMetadataStorage();

        const required = Array.from(new Set(descriptor.columns.map(col => col.component))).map(componentName => ({
            componentName,
            typeId: assertTypeId(storage.getComponentId(componentName)),
        }));
        const membershipPredicates = required.map(item =>
            `EXISTS (SELECT 1 FROM components c WHERE c.entity_id = e.id AND c.type_id = '${item.typeId}' AND c.deleted_at IS NULL)`
        );
        // P2 membership requires only component types that contribute projected columns.
        const membershipSql = membershipPredicates.length > 0 ? ` AND ${membershipPredicates.join(' AND ')}` : '';

        while (true) {
            const batchRows = await projExec<any[]>('projection.backfill.batch',
                `SELECT e.id FROM entities e WHERE e.id > $1 AND e.deleted_at IS NULL${membershipSql} ORDER BY e.id LIMIT $2`,
                [watermark, batchSize]
            );
            if (batchRows.length === 0) break;

            const lastId = batchRows[batchRows.length - 1].id;
            const projectedColumns = descriptor.columns.map(col => assertIdentifier(col.columnName, 'projectedColumn'));
            const insertColumns = ['entity_id', ...projectedColumns, 'created_at', 'updated_at', 'deleted_at', 'shape_version'];
            const selectColumns = descriptor.columns.map(col => {
                const columnName = assertIdentifier(col.columnName, 'projectedColumn');
                const typeId = storage.getComponentId(col.component);
                return `${projectionSourceExpr(col, typeId, 'e.id')} AS "${columnName}"`;
            });
            const selectList = ['e.id', ...selectColumns, 'e.created_at', 'e.updated_at', 'e.deleted_at', '$3'].join(', ');
            const quotedInsertColumns = insertColumns.map(col => projectedColumns.includes(col) ? `"${col}"` : col).join(', ');

            await projExec('projection.backfill.upsert',
                `INSERT INTO ${tableName} (${quotedInsertColumns})
                 SELECT ${selectList}
                 FROM entities e
                 WHERE e.id > $1 AND e.id <= $2 AND e.deleted_at IS NULL${membershipSql}
                 ORDER BY e.id
                 ON CONFLICT (entity_id) DO NOTHING`,
                [watermark, lastId, descriptor.shapeVersion]
            );

            watermark = lastId;
            await projExec('projection.backfill.advance',
                `UPDATE projection_state SET watermark = $1 WHERE archetype = $2`, [watermark, archetypeName]);
            if (throttle > 0) await sleep(throttle);
        }

        await mgr.setStatus(archetypeName, 'SHADOW');
        await projExec('projection.backfill.clearWatermark',
            `UPDATE projection_state SET watermark = NULL WHERE archetype = $1`, [archetypeName]);
    } finally {
        await lock.release(taskId);
    }
}
