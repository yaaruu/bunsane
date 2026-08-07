/**
 * RP-04 / BUG-1: numeric filters restate the partial-index validity predicate
 * so PostgreSQL can use idx_*_numeric functional indexes.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { ComponentRegistry } from '../../../core/components';
import { TestUser } from '../../fixtures/components';
import { ensureComponentsRegistered } from '../../utils';
import {
    NUMERIC_JSON_TEXT_REGEX,
    numericJsonTextValidPredicate,
    numericJsonCompareSql,
} from '../../../database/numericJsonField';

function compileSql(setup: (ctx: QueryContext) => void): string {
    const ctx = new QueryContext();
    setup(ctx);
    return QueryDAG.buildBasicQuery(ctx).execute(ctx).sql;
}

describe('RP-04 numeric partial-index predicate restatement', () => {
    let userId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);
        userId = ComponentRegistry.getComponentId(TestUser.name)!;
    });

    test('shared helper matches index DDL regex shape', () => {
        expect(NUMERIC_JSON_TEXT_REGEX).toBe('^-?[0-9]+\\.?[0-9]*$');
        expect(numericJsonTextValidPredicate(`data->>'age'`)).toContain(
            `data->>'age' ~ '${NUMERIC_JSON_TEXT_REGEX}'`
        );
        expect(numericJsonCompareSql(`c.data->>'age'`, '>', '$1::numeric')).toContain(
            `(c.data->>'age')::numeric > $1::numeric`
        );
        expect(numericJsonCompareSql(`c.data->>'age'`, '>', '$1::numeric')).toContain(
            `IS NOT NULL`
        );
    });

    test('numeric filter SQL restates validity predicate', () => {
        const sql = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'age', operator: '>', value: 18 },
            ]);
        });

        expect(sql).toContain(`data->>'age' IS NOT NULL`);
        expect(sql).toContain(`data->>'age' ~ '${NUMERIC_JSON_TEXT_REGEX}'`);
        // Alias may be ec/c/s — only require cast form.
        expect(sql).toMatch(/\(e?c?\.?data->>'age'\)::numeric|data->>'age'\)::numeric/);
        expect(sql).toMatch(/::numeric\s+>\s+\$\d+/);
    });

    test('numeric IN list restates validity predicate', () => {
        const sql = compileSql((ctx) => {
            ctx.componentIds.add(userId);
            ctx.componentFilters.set(userId, [
                { field: 'age', operator: 'IN', value: [18, 21, 30] },
            ]);
        });

        expect(sql).toContain(`data->>'age' IS NOT NULL`);
        expect(sql).toContain(`data->>'age' ~ '${NUMERIC_JSON_TEXT_REGEX}'`);
        expect(sql).toMatch(/IN\s*\(/i);
    });

    test('numeric ORDER BY alone does not filter out NULL sort keys', () => {
        // Sort-only must keep NULLS LAST semantics — no validity predicate on
        // the sort field when there is no numeric filter on that field.
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
        // Name filter is text — no age validity predicate required.
        expect(sql).not.toContain(`data->>'age' IS NOT NULL`);
    });
});
