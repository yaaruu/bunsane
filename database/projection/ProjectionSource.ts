import { assertIdentifier } from '../../query/SqlIdentifier';
import type { ProjectedColumn } from './types';

export const assertTypeId = (typeId: string): string => {
    if (!/^[a-f0-9]{1,64}$/.test(typeId)) {
        throw new Error(`Invalid projection component type id: ${typeId}`);
    }
    return typeId;
};

export const castFor = (column: ProjectedColumn): string => {
    if (column.sqlType === 'numeric') return '::numeric';
    if (column.sqlType === 'timestamptz') return '::timestamptz';
    if (column.sqlType === 'boolean') return '::boolean';
    if (column.sqlType === 'uuid') return '::uuid';
    return '';
};

/**
 * The scalar subquery that sources one projected column from `components`, shared by backfill
 * and the reconcile sweep so the two can never compute a column differently.
 *
 * `entityRef` is the entity-id expression in the enclosing scope (`e.id` for the INSERT..SELECT
 * form, a bind placeholder for the single-row recompute).
 */
export const projectionSourceExpr = (
    column: ProjectedColumn,
    typeId: string,
    entityRef: string
): string => {
    const safeTypeId = assertTypeId(typeId);
    const where = `c.entity_id = ${entityRef} AND c.type_id = '${safeTypeId}' AND c.deleted_at IS NULL`;

    // Component-id columns come from the row's own id — there is no data key to read.
    if (column.kind === 'component_id') {
        return `(SELECT c.id FROM components c WHERE ${where} LIMIT 1)`;
    }

    const field = assertIdentifier(column.field, 'projectedField');
    return `(SELECT (c.data->>'${field}')${castFor(column)} FROM components c WHERE ${where} LIMIT 1)`;
};
