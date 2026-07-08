import { createHash } from 'crypto';
import type { ProjectedColumn } from './types';

export const computeShapeHash = (cols: ProjectedColumn[]): string => {
    const canonical = [...cols]
        .sort((a, b) => {
            const componentCmp = a.component.localeCompare(b.component);
            if (componentCmp !== 0) return componentCmp;
            return a.field.localeCompare(b.field);
        })
        .map(col => `${col.component}:${col.field}:${col.sqlType}`)
        .join('|');

    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};
