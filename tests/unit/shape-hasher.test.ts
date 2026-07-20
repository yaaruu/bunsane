import { describe, test, expect } from 'bun:test';
import { computeShapeHash } from '../../database/projection/ShapeHasher';
import type { ProjectedColumn } from '../../database/projection/types';

const columns: ProjectedColumn[] = [
    { component: 'Order', field: 'status', sqlType: 'text', columnName: 'order_status' },
    { component: 'Order', field: 'total', sqlType: 'numeric', columnName: 'order_total' },
    { component: 'Customer', field: 'tier', sqlType: 'text', columnName: 'customer_tier' },
];

describe('computeShapeHash', () => {
    test('returns a 16-char lowercase hex string', () => {
        expect(computeShapeHash(columns)).toMatch(/^[0-9a-f]{16}$/);
    });

    test('is deterministic', () => {
        expect(computeShapeHash(columns)).toBe(computeShapeHash(columns));
    });

    test('is order-independent', () => {
        expect(computeShapeHash(columns)).toBe(computeShapeHash([...columns].reverse()));
    });

    test('is sensitive to shape changes', () => {
        const changed = columns.map(col =>
            col.field === 'total' ? { ...col, sqlType: 'text' as const } : col
        );
        expect(computeShapeHash(changed)).not.toBe(computeShapeHash(columns));
    });

    test('does not mutate the input array', () => {
        const input = [...columns];
        computeShapeHash(input);
        expect(input.map(col => col.component)).toEqual(['Order', 'Order', 'Customer']);
        expect(input.map(col => col.field)).toEqual(['status', 'total', 'tier']);
    });
});
