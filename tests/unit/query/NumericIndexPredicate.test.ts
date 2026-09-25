/**
 * Numeric filters compare through bunsane_num_v1. A non-numeric JSON string
 * must not be cast with ::numeric (that raises) and must not be excluded by a
 * restated partial-index regex. Sort-only must still return NULL keys.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { ComponentRegistry } from '../../../core/components';
import { TestUser } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';
import { NUMERIC_KEY_FN } from '../../../query/orderPlan';

function compileSql(setup: (ctx: QueryContext) => void): string {
    const ctx = new QueryContext();
    setup(ctx);
    return QueryDAG.buildBasicQuery(ctx).execute(ctx).sql;
}

describe('numeric filters use the numeric key function', () => {
    let userId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
        userId = ComponentRegistry.getComponentId(TestUser.name)!;
    });

    test('range and IN compare through the key function, not a raw JSON cast', () => {
        const range = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'age', operator: '>', value: 18 },
            ]);
        });
        expect(range).toContain(`${NUMERIC_KEY_FN}(`);
        expect(range).not.toMatch(/\(.*data->>'age'\)::numeric/);
        expect(range).not.toContain(`data->>'age' ~ '`);

        const list = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'age', operator: 'IN', value: [18, 21, 30] },
            ]);
        });
        expect(list).toContain(`${NUMERIC_KEY_FN}(`);
        expect(list).toMatch(/IN\s*\(/i);
        expect(list).not.toMatch(/\(.*data->>'age'\)::numeric/);
    });

    test('numeric ORDER BY alone does not filter out NULL sort keys', () => {
        const sql = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
            ]);
            ctx.sortOrders = [
                { component: 'TestUser', property: 'age', direction: 'DESC', nullsFirst: false },
            ];
        });
        expect(sql).toContain(`data->>'age'`);
        expect(sql).not.toContain(`data->>'age' IS NOT NULL`);
    });
});
