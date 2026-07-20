import type { Entity } from '../../core/Entity';
import type { ProjectionDescriptor, ProjectionSqlType } from './types';

export function projectEntity(entity: Entity, descriptor: ProjectionDescriptor): Record<string, any> {
    const components = new Map<string, any>();
    for (const comp of entity.components.values()) {
        components.set(comp.constructor.name, comp);
    }

    const result: Record<string, any> = {};
    for (const col of descriptor.columns) {
        const comp = components.get(col.component);
        if (!comp) continue;

        const raw = (comp as any)[col.field];
        if (col.sqlType === 'numeric') {
            result[col.columnName] = raw == null ? null : Number(raw);
        } else if (col.sqlType === 'timestamptz') {
            result[col.columnName] = raw == null ? null : (raw instanceof Date ? raw.toISOString() : String(raw));
        } else if (col.sqlType === 'boolean') {
            result[col.columnName] = raw == null ? null : Boolean(raw);
        } else {
            result[col.columnName] = raw == null ? null : String(raw);
        }
    }

    return result;
}

/**
 * Exact inverse of the write rules above — turns an `rm_` column value back into the JS value
 * a component field held before projection. Kept in this file so the two directions are read
 * and edited together.
 *
 * The critical case is `numeric`: PostgreSQL returns numeric over the wire as a STRING. Without
 * the explicit `Number()` every projected number field would silently change JS type on the
 * hydration path while still comparing equal under `==`.
 *
 * NULL stays NULL. `projectEntity` maps absent/undefined fields to NULL, and that round-trip is
 * asymmetric with the legacy JSONB path, which DROPS undefined so the field reads back absent.
 * We preserve `null` — the one intentional divergence, observable in `comp.data()` and
 * `Object.keys`, and normalized away in the shadow comparator.
 */
export function coerceProjectedValue(value: any, sqlType: ProjectionSqlType): any {
    if (value === null || value === undefined) return null;
    if (sqlType === 'numeric') return Number(value);
    if (sqlType === 'timestamptz') return value instanceof Date ? value : new Date(value);
    if (sqlType === 'boolean') return Boolean(value);
    return typeof value === 'string' ? value : String(value);
}
