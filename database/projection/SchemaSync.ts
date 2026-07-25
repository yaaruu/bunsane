/**
 * Projection schema growth (B7).
 *
 * `createRmTable` is `CREATE TABLE IF NOT EXISTS`, so once an `rm_` table
 * exists it never gains columns — adding a projected field to an archetype
 * used to leave the dual-write inserting into a column that does not exist,
 * failing every write on that archetype until someone ran `ALTER TABLE` by
 * hand in production.
 *
 * This module closes that gap by diffing the descriptor against
 * `information_schema.columns` on every registration/sync and adding what is
 * missing. Adding the column is only half the fix: existing rows hold NULL in
 * the new column, and under `BUNSANE_QSP=route` reads are served from the row,
 * so a silently-widened READY projection would turn a loud write failure into
 * a silent wrong read. So a newly added column is marked `FILLING` in
 * `projection_state.field_state` — the planner already excludes FILLING
 * columns from coverage, filtering, sorting and hydration — and a background
 * fill job populates it for existing rows before flipping it to `READY`.
 */
import db from '../index';
import { logger as MainLogger } from '../../core/Logger';
import { getMetadataStorage } from '../../core/metadata';
import { assertIdentifier } from '../../query/SqlIdentifier';
import { addColumn, rmTableName, assertRmTableName } from './DDLGenerator';
import { projectionSourceExpr } from './ProjectionSource';
import type { ProjectedColumn, ProjectionDescriptor } from './types';

const logger = MainLogger.child({ scope: 'qsp.schema' });

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * A pre-existing `field_state` that is not a jsonb OBJECT (legacy rows have
 * been seen holding a jsonb *string*) cannot be `||`-merged — the result would
 * be an array. Fall back to `{}` in that case.
 */
const fieldStateBase = `(CASE WHEN jsonb_typeof(field_state) = 'object' THEN field_state ELSE '{}'::jsonb END)`;

/**
 * Inline jsonb literal rather than a bound parameter: Bun SQL encodes a JS
 * object param differently depending on `prepare` (a JSON-encoded STRING with
 * prepare:true — which `||` turns into an array — and "[object Object]" with
 * prepare:false behind PgBouncer). Column names are already validated
 * identifiers, so inlining is safe and mode-independent.
 */
const fieldStateLiteral = (columns: ProjectedColumn[], state: 'FILLING' | 'READY'): string => {
    const entries = columns
        .map(col => `"${assertIdentifier(col.columnName, 'projectedColumn')}":"${state}"`)
        .join(',');
    return `'{${entries}}'::jsonb`;
};

const invalidatePlannerCache = async (archetype: string): Promise<void> => {
    try {
        const { PlannerCache } = await import('../../query/planner/PlannerCache');
        PlannerCache.instance.invalidate(archetype);
    } catch {
        /* planner may not be loaded in some contexts; TTL is the backstop */
    }
};

/** Column names that physically exist on the archetype's rm_ table. */
export async function existingRmColumns(archetype: string): Promise<Set<string>> {
    const table = assertRmTableName(rmTableName(archetype));
    // rmTableName is already schema-less and validated; strip nothing else.
    const rows = await db.unsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`,
        [table]
    );
    return new Set(rows.map((row: any) => row.column_name as string));
}

/**
 * Add any descriptor column the rm_ table is missing, mark it FILLING, and
 * kick the background fill. Returns the columns added (empty = no drift).
 *
 * Safe to call concurrently across instances: `ADD COLUMN IF NOT EXISTS` and
 * the jsonb merge are both idempotent.
 */
export async function syncRmSchema(
    archetype: string,
    descriptor: ProjectionDescriptor,
    opts: { fill?: boolean } = {}
): Promise<ProjectedColumn[]> {
    const present = await existingRmColumns(archetype);
    const missing = descriptor.columns.filter(col => !present.has(col.columnName));
    if (missing.length === 0) return [];

    for (const col of missing) {
        await addColumn(archetype, col);
    }

    await db.unsafe(
        `UPDATE projection_state
         SET field_state = ${fieldStateBase} || ${fieldStateLiteral(missing, 'FILLING')},
             shape_hash = $2,
             shape_version = $3,
             updated_at = now()
         WHERE archetype = $1`,
        [archetype, descriptor.shapeHash, descriptor.shapeVersion]
    );
    await invalidatePlannerCache(archetype);

    logger.warn(
        { archetype, columns: missing.map(col => col.columnName) },
        'Projection shape grew — added rm_ columns, marked FILLING until backfilled'
    );

    if (opts.fill !== false) {
        void fillColumns(archetype, missing).catch(err =>
            logger.error({ archetype, err }, 'Projection column fill failed — columns stay FILLING')
        );
    }
    return missing;
}

/**
 * Populate newly added columns for pre-existing rows, in keyset batches, then
 * flip them to READY. Values come from `projectionSourceExpr` — the same
 * expression backfill and the reconcile sweep use — so a fill can never
 * compute a column differently from a dual-write.
 */
export async function fillColumns(archetype: string, columns: ProjectedColumn[]): Promise<void> {
    if (columns.length === 0) return;
    const table = assertRmTableName(rmTableName(archetype));
    const storage = getMetadataStorage();
    const batchSize = parseInt(process.env.BUNSANE_QSP_BACKFILL_BATCH ?? '5000', 10);
    const throttle = parseInt(process.env.BUNSANE_QSP_BACKFILL_THROTTLE_MS ?? '50', 10);

    const assignments = columns.map(col => {
        const columnName = assertIdentifier(col.columnName, 'projectedColumn');
        const typeId = storage.getComponentId(col.component) ?? '';
        return `"${columnName}" = ${projectionSourceExpr(col, typeId, 'r.entity_id')}`;
    }).join(', ');

    let watermark = ZERO_UUID;
    while (true) {
        const rows = await db.unsafe(
            `WITH batch AS (
                 SELECT entity_id FROM ${table} WHERE entity_id > $1 ORDER BY entity_id LIMIT $2
             )
             UPDATE ${table} r SET ${assignments}
             FROM batch b WHERE r.entity_id = b.entity_id
             RETURNING r.entity_id`,
            [watermark, batchSize]
        );
        if (rows.length === 0) break;
        // RETURNING order is unspecified; advance on the batch maximum.
        watermark = rows.reduce((max: string, row: any) => (row.entity_id > max ? row.entity_id : max), watermark);
        if (throttle > 0) await new Promise(resolve => setTimeout(resolve, throttle));
    }

    await db.unsafe(
        `UPDATE projection_state
         SET field_state = ${fieldStateBase} || ${fieldStateLiteral(columns, 'READY')}, updated_at = now()
         WHERE archetype = $1`,
        [archetype]
    );
    await invalidatePlannerCache(archetype);
    logger.info(
        { archetype, columns: columns.map(col => col.columnName) },
        'Projection column fill complete — columns READY'
    );
}
