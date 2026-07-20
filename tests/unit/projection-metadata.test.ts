import 'reflect-metadata';
import { describe, test, expect } from 'bun:test';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { deriveProjectedColumns, fullyColumnarComponents } from '../../database/projection/ProjectionMetadata';
import { coerceProjectedValue } from '../../database/projection/projectEntity';

@Component
class QspTestOrder extends BaseComponent {
    @CompData() status!: string;
    @CompData() total!: number;
    @CompData() placedAt!: Date;
    @CompData() paid!: boolean;
    @CompData({ arrayOf: String }) tags!: string[];
}

@Component
class QspTestCustomer extends BaseComponent {
    @CompData() tier!: string;
}

@ArcheType({ name: 'QspOrderListView' })
class QspOrderListView extends BaseArcheType {
    @ArcheTypeField(QspTestOrder) order!: QspTestOrder;
    @ArcheTypeField(QspTestCustomer) customer!: QspTestCustomer;
}

describe('deriveProjectedColumns', () => {
    test('derives primitive scalar projected columns for an archetype', () => {
        const columns = deriveProjectedColumns('QspOrderListView');
        const byColumnName = new Map(columns.map(col => [col.columnName, col]));

        expect(byColumnName.get('qsp_test_order_status')?.sqlType).toBe('text');
        expect(byColumnName.get('qsp_test_order_total')?.sqlType).toBe('numeric');
        expect(byColumnName.get('qsp_test_order_placed_at')?.sqlType).toBe('timestamptz');
        expect(byColumnName.get('qsp_test_order_paid')?.sqlType).toBe('boolean');
        expect(byColumnName.get('qsp_test_customer_tier')?.sqlType).toBe('text');
        expect(byColumnName.has('qsp_test_order_tags')).toBe(false);
    });

    test('projects a component-id column for every component that contributes fields', () => {
        const columns = deriveProjectedColumns('QspOrderListView');
        const idColumns = columns.filter(col => col.kind === 'component_id');

        expect(idColumns.map(col => col.columnName).sort()).toEqual([
            'qsp_test_customer__cid',
            'qsp_test_order__cid',
        ]);
        for (const col of idColumns) expect(col.sqlType).toBe('uuid');

        // Double underscore keeps it distinct from a real field named `cid`.
        expect(columns.some(col => col.columnName === 'qsp_test_order_cid')).toBe(false);
    });

    test('rejects a column-name collision at derivation instead of serving ambiguous rows', () => {
        @Component
        class QspCollideComp extends BaseComponent {
            @CompData() _cid!: string; // snake-cases to `__cid`, colliding with the id column
        }
        @ArcheType({ name: 'QspCollideView' })
        class QspCollideView extends BaseArcheType {
            @ArcheTypeField(QspCollideComp) c!: QspCollideComp;
        }
        void QspCollideView;

        expect(() => deriveProjectedColumns('QspCollideView')).toThrow(/collision/i);
    });

    test('sorts field columns by component then field', () => {
        const columns = deriveProjectedColumns('QspOrderListView').filter(col => col.kind !== 'component_id');
        expect(columns.map(col => `${col.component}.${col.field}`)).toEqual([
            'QspTestCustomer.tier',
            'QspTestOrder.paid',
            'QspTestOrder.placedAt',
            'QspTestOrder.status',
            'QspTestOrder.total',
        ]);
    });
});

describe('fullyColumnarComponents (F1 hydration gate)', () => {
    test('excludes a mixed-field component and includes an all-scalar one', () => {
        const fully = fullyColumnarComponents('QspOrderListView');

        // QspTestOrder has a projected column for every field EXCEPT `tags` (arrayOf).
        // It passes component-set coverage, so without this gate it would hydrate
        // from rm_ silently missing `tags`.
        expect(fully.has('QspTestOrder')).toBe(false);
        expect(fully.has('QspTestCustomer')).toBe(true);
    });

    test('gate is strictly narrower than coverage — a covered archetype can be partly hydratable', () => {
        const projected = new Set(deriveProjectedColumns('QspOrderListView').map(c => c.component));
        const fully = fullyColumnarComponents('QspOrderListView');
        for (const name of fully) expect(projected.has(name)).toBe(true);
        expect(fully.size).toBeLessThan(projected.size);
    });
});

describe('coerceProjectedValue (inverse of projectEntity)', () => {
    test('numeric arrives from PG as a string and must come back a number', () => {
        // The highest-probability silent bug: `==` still passes, the JS type has drifted.
        const coerced = coerceProjectedValue('123.45', 'numeric');
        expect(typeof coerced).toBe('number');
        expect(coerced).toBe(123.45);
        expect(coerceProjectedValue(7, 'numeric')).toBe(7);
    });

    test('timestamptz revives to Date from both string and Date', () => {
        const iso = '2026-07-20T10:20:30.000Z';
        const fromString = coerceProjectedValue(iso, 'timestamptz');
        expect(fromString).toBeInstanceOf(Date);
        expect((fromString as Date).toISOString()).toBe(iso);

        const d = new Date(iso);
        expect(coerceProjectedValue(d, 'timestamptz')).toBe(d);
    });

    test('boolean and text pass through with their JS types', () => {
        expect(coerceProjectedValue(true, 'boolean')).toBe(true);
        expect(coerceProjectedValue(false, 'boolean')).toBe(false);
        expect(coerceProjectedValue('shipped', 'text')).toBe('shipped');
    });

    test('null and undefined both normalize to null for every sqlType', () => {
        for (const t of ['numeric', 'timestamptz', 'boolean', 'text'] as const) {
            expect(coerceProjectedValue(null, t)).toBeNull();
            expect(coerceProjectedValue(undefined, t)).toBeNull();
        }
    });

    test('round-trips every sqlType through projectEntity write rules', () => {
        // Mirrors projectEntity's per-type write, then reads it back.
        const cases: Array<{ sqlType: 'numeric' | 'timestamptz' | 'boolean' | 'text'; value: any }> = [
            { sqlType: 'numeric', value: 42.5 },
            { sqlType: 'timestamptz', value: new Date('2026-07-20T10:20:30.000Z') },
            { sqlType: 'boolean', value: true },
            { sqlType: 'text', value: 'pending' },
        ];

        for (const { sqlType, value } of cases) {
            const written =
                sqlType === 'numeric' ? Number(value)
                : sqlType === 'timestamptz' ? (value as Date).toISOString()
                : sqlType === 'boolean' ? Boolean(value)
                : String(value);

            // numeric crosses the wire as text — simulate that, not the JS value.
            const overWire = sqlType === 'numeric' ? String(written) : written;
            const readBack = coerceProjectedValue(overWire, sqlType);

            if (sqlType === 'timestamptz') {
                expect((readBack as Date).getTime()).toBe((value as Date).getTime());
            } else {
                expect(readBack).toBe(value);
            }
        }
    });
});
