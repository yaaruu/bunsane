import 'reflect-metadata';
import { describe, test, expect, beforeEach } from 'bun:test';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { deriveProjectionDescriptor } from '../../database/projection/ProjectionMetadata';
import { resolveHydrationPlan, resetHydrationPlanCache } from '../../query/planner/RmHydrationPlan';

@Component
class HydPlanOrder extends BaseComponent {
    @CompData() status!: string;
    @CompData() total!: number;
    @CompData({ arrayOf: String }) tags!: string[]; // makes the component MIXED — not hydratable
}

@Component
class HydPlanCustomer extends BaseComponent {
    @CompData() tier!: string;
    @CompData() lifetimeValue!: number;
}

@ArcheType({ name: 'HydPlanListView' })
class HydPlanListView extends BaseArcheType {
    @ArcheTypeField(HydPlanOrder) order!: HydPlanOrder;
    @ArcheTypeField(HydPlanCustomer) customer!: HydPlanCustomer;
}

const descriptor = () => deriveProjectionDescriptor('HydPlanListView');

describe('resolveHydrationPlan', () => {
    beforeEach(() => resetHydrationPlanCache());

    test('F1 — hydrates the fully-columnar component and excludes the mixed one', () => {
        const plan = resolveHydrationPlan('HydPlanListView', descriptor(), {});

        expect(plan.components.has('HydPlanCustomer')).toBe(true);
        expect(plan.components.has('HydPlanOrder')).toBe(false);

        // The SELECT list must contain exactly the hydratable component's columns.
        expect(plan.columns.map(c => c.columnName).sort()).toEqual([
            'hyd_plan_customer_lifetime_value',
            'hyd_plan_customer_tier',
        ]);
    });

    test('degrades per-component, not per-query — Order still routes, just not hydrated', () => {
        const plan = resolveHydrationPlan('HydPlanListView', descriptor(), {});
        expect(plan.components.size).toBe(1);
        expect(plan.columns.length).toBeGreaterThan(0);
    });

    test('F3 — a FILLING column drops its component from the plan', () => {
        const plan = resolveHydrationPlan('HydPlanListView', descriptor(), {
            hyd_plan_customer_tier: 'FILLING',
        });
        expect(plan.components.size).toBe(0);
        expect(plan.columns).toEqual([]);
    });

    test('F3 — READY columns are kept', () => {
        const plan = resolveHydrationPlan('HydPlanListView', descriptor(), {
            hyd_plan_customer_tier: 'READY',
            hyd_plan_customer_lifetime_value: 'READY',
        });
        expect(plan.components.has('HydPlanCustomer')).toBe(true);
    });

    test('F3 — fieldState is matched on any of the three key forms used by the planner', () => {
        for (const key of ['hyd_plan_customer_tier', 'tier', 'HydPlanCustomer:tier']) {
            resetHydrationPlanCache();
            const plan = resolveHydrationPlan('HydPlanListView', descriptor(), { [key]: 'FILLING' });
            expect(plan.components.size).toBe(0);
        }
    });

    test('every planned column belongs to a planned component', () => {
        const plan = resolveHydrationPlan('HydPlanListView', descriptor(), {});
        for (const col of plan.columns) {
            expect(plan.components.has(col.component)).toBe(true);
        }
        const flattened = [...plan.components.values()].flat().length;
        expect(plan.columns.length).toBe(flattened);
    });
});
