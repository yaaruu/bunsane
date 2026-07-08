import 'reflect-metadata';
import { describe, test, expect } from 'bun:test';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { deriveProjectedColumns } from '../../database/projection/ProjectionMetadata';

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

    test('sorts columns by component then field', () => {
        const columns = deriveProjectedColumns('QspOrderListView');
        expect(columns.map(col => `${col.component}.${col.field}`)).toEqual([
            'QspTestCustomer.tier',
            'QspTestOrder.paid',
            'QspTestOrder.placedAt',
            'QspTestOrder.status',
            'QspTestOrder.total',
        ]);
    });
});
