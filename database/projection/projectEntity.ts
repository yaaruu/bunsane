import type { Entity } from '../../core/Entity';
import type { ProjectionDescriptor } from './types';

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
