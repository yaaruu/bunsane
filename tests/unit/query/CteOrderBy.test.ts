/**
 * RP-07: CTE emits ORDER BY only when it owns final ordering (no outer sort).
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { ComponentRegistry } from '../../../core/components';
import { TestUser, TestProduct } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

function compileSql(setup: (ctx: QueryContext) => void): string {
    const ctx = new QueryContext();
    setup(ctx);
    return QueryDAG.buildBasicQuery(ctx).execute(ctx).sql;
}

describe('RP-07 CTE ORDER BY gating', () => {
    let userId: string;
    let productId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
        userId = ComponentRegistry.getComponentId(TestUser.name)!;
        productId = ComponentRegistry.getComponentId(TestProduct.name)!;
    });

    test('multi-filter CTE without sort: ORDER BY entity_id present (stable pages)', () => {
        const sql = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
            ]);
            ctx.componentFilters.set(productId, [
                { field: 'price', operator: '<', value: 100 },
            ]);
            ctx.limit = 20;
        });

        expect(sql).toMatch(/WITH\s+base_entities/i);
        // CTE owns ordering when no outer sort.
        expect(sql).toMatch(/base_entities AS[\s\S]*ORDER BY/i);
    });

    test('multi-filter CTE with component sort: no ORDER BY inside CTE body', () => {
        const sql = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
            ]);
            ctx.componentFilters.set(productId, [
                { field: 'price', operator: '<', value: 100 },
            ]);
            ctx.sortOrders = [
                { component: 'TestUser', property: 'age', direction: 'DESC', nullsFirst: false },
            ];
            ctx.limit = 20;
        });

        // Sort-driven path may avoid CTE entirely when eligible.
        // If CTE is present, it must not ORDER BY entity_id (outer sort owns order).
        if (/WITH\s+base_entities/i.test(sql)) {
            // Extract CTE body between WITH base_entities AS ( and closing )
            const m = sql.match(/WITH\s+base_entities\s+AS\s*\(([\s\S]*?)\)\s*(?:SELECT|$)/i);
            expect(m).toBeTruthy();
            const cteBody = m![1]!;
            expect(cteBody.toUpperCase()).not.toContain('ORDER BY');
        }
    });
});
