/**
 * RP-03 unit tests: same-component filter coalesce + membership INTERSECT pushdown.
 * Asserts emitted SQL shape without requiring a live database.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { ComponentRegistry } from '../../../core/components';
import { TestUser, TestProduct } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';

function compileSql(setup: (ctx: QueryContext) => void): { sql: string; params: any[] } {
    const ctx = new QueryContext();
    setup(ctx);
    const dag = QueryDAG.buildBasicQuery(ctx);
    const result = dag.execute(ctx);
    return { sql: result.sql, params: result.params };
}

function countExists(sql: string): number {
    return (sql.match(/\bEXISTS\s*\(/gi) ?? []).length;
}

describe('RP-03 filter coalesce + membership pushdown', () => {
    let userId: string;
    let productId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct);
        userId = ComponentRegistry.getComponentId(TestUser.name)!;
        productId = ComponentRegistry.getComponentId(TestProduct.name)!;
        expect(userId).toBeTruthy();
        expect(productId).toBeTruthy();
    });

    test('two filters on one component → single EXISTS (or inline), not two', () => {
        // One filter total avoids CTE (totalFilters < 2 for two filters on one
        // component actually triggers CTE when size>=2). Two filters → CTE path
        // with pushdown; outer EXISTS should be zero when non-legacy.
        const { sql } = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
                { field: 'age', operator: '>', value: 18 },
            ]);
        });

        // Filters live in the membership/CTE branch as AND predicates.
        expect(sql).toContain("data->>'name'");
        expect(sql).toContain("data->>'age'");
        // Must not emit two separate EXISTS for the two filters.
        // With non-legacy pushdown, outer EXISTS for field filters is 0.
        expect(countExists(sql)).toBeLessThanOrEqual(1);
        // Both predicates appear (coalesced or pushed) — not only one field.
        const nameHits = (sql.match(/data->>'name'/g) ?? []).length;
        const ageHits = (sql.match(/data->>'age'/g) ?? []).length;
        expect(nameHits).toBeGreaterThanOrEqual(1);
        expect(ageHits).toBeGreaterThanOrEqual(1);
    });

    test('multi-component membership pushes the filtered component and probes the other', () => {
        const { sql } = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
            ]);
        });

        expect(sql.toUpperCase()).not.toContain('INTERSECT');
        expect(sql).toContain("data->>'name'");
        expect(countExists(sql)).toBe(1);
        expect((sql.match(/data->>'name'/g) ?? []).length).toBe(1);
    });

    test('multi-component multi-filter CTE pushes filters into the driving scan and probes', () => {
        const { sql } = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
                { field: 'age', operator: '>', value: 21 },
            ]);
            ctx.componentFilters.set(productId, [
                { field: 'price', operator: '<', value: 100 },
            ]);
        });

        expect(sql).toMatch(/WITH\s+base_entities/i);
        expect(sql.toUpperCase()).not.toContain('INTERSECT');
        expect(sql).toContain("data->>'name'");
        expect(sql).toContain("data->>'age'");
        expect(sql).toContain("data->>'price'");
        expect(countExists(sql)).toBe(1);
        expect(sql).not.toMatch(/SELECT\s+DISTINCT/i);
    });

    test('sort-driven multi-comp with two filters on other component → one EXISTS', () => {
        const { sql } = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(productId, [
                { field: 'price', operator: '>', value: 10 },
                { field: 'inStock', operator: '=', value: true },
            ]);
            ctx.sortOrders = [
                { component: 'TestUser', property: 'age', direction: 'DESC', nullsFirst: false },
            ];
        });

        // Sort-driven scan (no CTE) — FROM driving table, EXISTS for other comps.
        expect(sql.toUpperCase()).not.toContain('INTERSECT');
        expect(sql).toContain("data->>'price'");
        expect(sql).toContain("data->>'inStock'");
        // Exactly one filter EXISTS for product (coalesced); no separate presence EXISTS.
        expect(countExists(sql)).toBe(1);
    });

    test('sort-driven presence EXISTS remains when other component has no filters', () => {
        const { sql } = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(userId, [
                { field: 'name', operator: '=', value: 'Ada' },
            ]);
            ctx.sortOrders = [
                { component: 'TestUser', property: 'age', direction: 'ASC', nullsFirst: false },
            ];
        });

        // Product has no filters → presence-only EXISTS; user filters inline on drive table.
        expect(countExists(sql)).toBe(1);
        expect(sql).toContain("data->>'name'");
    });
});
