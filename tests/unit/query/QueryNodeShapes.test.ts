/**
 * Query-node SQL shape regressions:
 * - Q-04 OrNode predicates match FilterBuilder (boolean text, numeric validity)
 * - Q-05 boolean = / != / IN compare as text
 * - Q-02 single-component sort is a leaf scan (no dummy filters, numeric expr, cursor)
 * - Q-06 / Q-11 DISTINCT and OFFSET 0 are not emitted on unique membership scans
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { OrNode } from '../../../query/OrNode';
import { OrQuery } from '../../../query/OrQuery';
import { ComponentInclusionNode } from '../../../query/ComponentInclusionNode';
import { buildComponentFilterGroup } from '../../../query/FilterBuilder';
import { ComponentRegistry } from '../../../core/components';
import { TestUser, TestProduct, TestOrder } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';
import { NUMERIC_JSON_TEXT_REGEX } from '../../../database/numericJsonField';
import config from '../../../core/Config';

function normalizeParams(sql: string): string {
    return sql.replace(/\$\d+/g, '$?');
}

function compile(setup: (ctx: QueryContext) => void): { sql: string; params: unknown[] } {
    const ctx = new QueryContext();
    setup(ctx);
    const result = QueryDAG.buildBasicQuery(ctx).execute(ctx);
    return { sql: result.sql, params: result.params };
}

describe('query node SQL shapes', () => {
    let userId: string;
    let productId: string;
    let orderId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
        userId = ComponentRegistry.getComponentId(TestUser.name)!;
        productId = ComponentRegistry.getComponentId(TestProduct.name)!;
        orderId = ComponentRegistry.getComponentId(TestOrder.name)!;
    });

    afterEach(() => {
        delete process.env.BUNSANE_ORNODE_SINGLE_PASS;
        delete process.env.BUNSANE_USE_DIRECT_PARTITION;
        config.reloadConfig();
    });

    function filterBuilderSql(filters: { field: string; operator: string; value: unknown }[], alias: string): string {
        const ctx = new QueryContext();
        return buildComponentFilterGroup(filters, alias, ctx)!;
    }

    function compileOr(
        branches: OrQuery['branches'],
        opts?: { withBase?: boolean; singlePass?: boolean },
    ): { sql: string; params: unknown[] } {
        if (opts?.singlePass === false) process.env.BUNSANE_ORNODE_SINGLE_PASS = '0';
        else delete process.env.BUNSANE_ORNODE_SINGLE_PASS;
        const ctx = new QueryContext();
        const node = new OrNode(new OrQuery(branches));
        if (opts?.withBase) {
            ctx.componentIds.add(userId);
            const base = new ComponentInclusionNode();
            node.addDependency(base);
        }
        const result = node.execute(ctx);
        return { sql: result.sql, params: result.params };
    }

    test('OR boolean equality and numeric comparison match FilterBuilder (union path)', () => {
        const boolFilters = [{ field: 'inStock', operator: '=', value: true }];
        const numFilters = [{ field: 'total', operator: '>', value: 10 }];
        const { sql, params } = compileOr([
            { component: TestProduct, filters: boolFilters },
            { component: TestOrder, filters: numFilters },
        ]);

        expect(sql.toUpperCase()).toContain('UNION');
        expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(boolFilters, 'c')));
        expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(numFilters, 'c')));
        expect(sql).toContain(`data->>'total' IS NOT NULL`);
        expect(sql).toContain(`data->>'total' ~ '${NUMERIC_JSON_TEXT_REGEX}'`);
        expect(sql).toMatch(/\(c\.data->>'total'\)::numeric > \$\d+::numeric/);
        expect(sql).not.toContain('::boolean');
        expect(sql).not.toMatch(/data->>'inStock'\)::numeric/);
        expect(params).toContain('true');
        expect(params).not.toContain(true);
    });

    test('OR same-component boolean and numeric match FilterBuilder', () => {
        const boolFilters = [{ field: 'inStock', operator: '=', value: false }];
        const numFilters = [{ field: 'price', operator: '>=', value: 1 }];
        const { sql, params } = compileOr([
            { component: TestProduct, filters: boolFilters },
            { component: TestProduct, filters: numFilters },
        ]);

        expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(boolFilters, 'c')));
        expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(numFilters, 'c')));
        expect(sql).toContain(`data->>'price' ~ '${NUMERIC_JSON_TEXT_REGEX}'`);
        expect(params).toContain('false');
        expect(params).not.toContain(false);
    });

    test('OR fallback emitter (dependency, single-pass off and on) matches FilterBuilder', () => {
        const boolFilters = [{ field: 'inStock', operator: '=', value: true }];
        const numFilters = [{ field: 'price', operator: '<', value: 5 }];
        for (const singlePass of [true, false]) {
            const { sql, params } = compileOr(
                [
                    { component: TestProduct, filters: boolFilters },
                    { component: TestProduct, filters: numFilters },
                ],
                { withBase: true, singlePass },
            );
            expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(boolFilters, 'c')));
            expect(normalizeParams(sql)).toContain(normalizeParams(filterBuilderSql(numFilters, 'c')));
            expect(sql).toContain(`data->>'price' IS NOT NULL`);
            expect(params).toContain('true');
            expect(params).not.toContain(true);
        }
        expect(userId).toBeTruthy();
        expect(productId).toBeTruthy();
        expect(orderId).toBeTruthy();
    });

    test('boolean =, !=, and IN compare as text and bind true/false strings', () => {
        const eq = compile((ctx) => {
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(productId, [{ field: 'inStock', operator: '=', value: true }]);
        });
        expect(eq.sql).toMatch(/data->>'inStock' = \$\d+/);
        expect(eq.sql).not.toContain('::boolean');
        expect(eq.params).toContain('true');

        const neq = compile((ctx) => {
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(productId, [{ field: 'inStock', operator: '!=', value: false }]);
        });
        expect(neq.sql).toMatch(/data->>'inStock' != \$\d+/);
        expect(neq.params).toContain('false');

        const inn = compile((ctx) => {
            ctx.componentIds.add(productId);
            ctx.componentFilters.set(productId, [{ field: 'inStock', operator: 'IN', value: [true, false] }]);
        });
        expect(inn.sql).toMatch(/data->>'inStock' IN \(\$\d+, \$\d+\)/);
        expect(inn.sql).not.toContain('::boolean');
        expect(inn.params).toContain('true');
        expect(inn.params).toContain('false');
    });

    test('single-component sort with no filters is a leaf scan with numeric expr and cursor', () => {
        const plain = compile((ctx) => {
            ctx.componentIds.add(userId);
            ctx.sortOrders = [{ component: 'TestUser', property: 'age', direction: 'DESC', nullsFirst: false }];
            ctx.limit = 20;
            ctx.offsetValue = 0;
        });
        expect(plain.sql.toUpperCase()).not.toContain('EXISTS');
        expect(plain.sql.toUpperCase()).not.toContain('INTERSECT');
        expect(plain.sql).not.toMatch(/SELECT\s+DISTINCT/i);
        expect(plain.sql).toMatch(/\(s\.data->>'age'\)::numeric DESC NULLS LAST, s\.entity_id ASC/);
        expect(plain.sql).toMatch(/LIMIT \$\d+/);
        expect(plain.sql).not.toMatch(/OFFSET/i);
        expect(plain.sql).not.toContain(`data->>'age' IS NOT NULL`);

        const cursor = compile((ctx) => {
            ctx.componentIds.add(userId);
            ctx.sortOrders = [{ component: 'TestUser', property: 'age', direction: 'ASC', nullsFirst: false }];
            ctx.compositeCursor = { v: '5', id: '00000000-0000-0000-0000-000000000001' };
            ctx.limit = 10;
        });
        expect(cursor.sql).toMatch(
            /\(\(s\.data->>'age'\)::numeric, s\.entity_id\) > \(\$\d+::numeric, \$\d+::uuid\) OR \(s\.data->>'age'\)::numeric IS NULL/,
        );
        expect(cursor.sql).toMatch(/ORDER BY \(s\.data->>'age'\)::numeric ASC NULLS LAST, s\.entity_id ASC/);
        expect(cursor.sql).not.toMatch(/OFFSET/i);
    });

    test('unique membership scan skips DISTINCT and OFFSET 0', () => {
        const sql = compile((ctx) => {
            ctx.componentIds.add(userId);
            ctx.limit = 10;
            ctx.offsetValue = 0;
        }).sql;
        expect(sql).not.toMatch(/SELECT\s+DISTINCT/i);
        expect(sql).not.toMatch(/OFFSET/i);
        expect(sql).toMatch(/LIMIT \$\d+/);
    });
});
