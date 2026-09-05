/**
 * SEC-03: injection-proofing of filter/sort metadata interpolation.
 *
 * Fields are ESCAPED (exotic but legal JSONB keys keep working, injection
 * becomes impossible); operators and sort directions are closed-set checked.
 */
import { describe, test, expect } from 'bun:test';
import {
    buildJSONPath,
    buildJSONBPath,
    buildComponentFilterCondition,
} from '../../../query/FilterBuilder';
import { QueryContext } from '../../../query/QueryContext';
import {
    escapeJsonLiteral,
    normalizeSortDirection,
    assertFieldPath,
} from '../../../query/SqlIdentifier';
import { projectionSourceExpr } from '../../../database/projection/ProjectionSource';

describe('escapeJsonLiteral', () => {
    test('doubles single quotes', () => {
        expect(escapeJsonLiteral("x' OR true --")).toBe("x'' OR true --");
    });

    test('leaves normal keys untouched', () => {
        expect(escapeJsonLiteral('my-key')).toBe('my-key');
        expect(escapeJsonLiteral('a b')).toBe('a b');
    });
});

describe('normalizeSortDirection', () => {
    test('only exact DESC is DESC; everything else ASC', () => {
        expect(normalizeSortDirection('DESC')).toBe('DESC');
        expect(normalizeSortDirection('ASC')).toBe('ASC');
        expect(normalizeSortDirection(undefined)).toBe('ASC');
        expect(normalizeSortDirection('ASC; SELECT pg_sleep(5)--')).toBe('ASC');
    });
});

describe('buildJSONPath escaping', () => {
    test('injection payload stays inside the literal', () => {
        const sql = buildJSONPath("x' OR true --", 'c');
        // The quote must be doubled — no raw breakout into SQL structure.
        expect(sql).toContain("x'' OR true --");
        expect(sql.startsWith("c.data->>'")).toBe(true);
        expect(sql.endsWith("'")).toBe(true);
    });

    test('nested path segments are escaped individually', () => {
        const sql = buildJSONPath("a.b' OR true--", 'c');
        expect(sql).not.toContain("b' OR");
        expect(sql).toContain("b'' OR");
    });

    test('legal exotic keys keep working', () => {
        expect(buildJSONPath('my-key', 'c')).toBe("c.data->>'my-key'");
        expect(buildJSONBPath('tags', 'c')).toBe("c.data->'tags'");
    });

    test('jsonb variant escapes too', () => {
        const sql = buildJSONBPath("t'; DROP TABLE x--", 'c');
        expect(sql).toContain("t''; DROP TABLE x--");
    });
});

describe('buildComponentFilterCondition operator allow-list', () => {
    function build(field: string, operator: string, value: unknown): string {
        const ctx = new QueryContext();
        return buildComponentFilterCondition({ field, operator, value } as any, 'c', ctx);
    }

    test('known operators still build predicates', () => {
        expect(build('score', '=', 5)).toContain('=');
        expect(build('name', 'LIKE', '%a%')).toContain('LIKE $1');
        expect(build('name', 'IS NULL', null)).toContain('IS NULL');
    });

    test('crafted operator cannot inject SQL', () => {
        expect(() => build('name', '= $1) OR true --', 'v')).toThrow(/Unsupported filter operator/);
        expect(() => build('name', '= 1; DROP TABLE x --', 'v')).toThrow(/Unsupported filter operator/);
    });

    test('field injection inside a valid operator is inert', () => {
        const sql = build("name') OR true --", '=', 'v');
        // Escaped literal, no structural change.
        expect(sql).toContain("name'') OR true --");
    });

    test('assertFieldPath remains strict for callers that want validation', () => {
        expect(assertFieldPath('a.b.c', 'test')).toBe('a.b.c');
        expect(() => assertFieldPath("a.b' --", 'test')).toThrow(/Invalid SQL identifier/);
    });
});

describe('projectionSourceExpr entityRef allow-list', () => {
    const column = { kind: 'data', field: 'score', columnName: 'score', sqlType: 'numeric' } as any;

    test('accepts the documented shapes', () => {
        expect(projectionSourceExpr(column, 'abc123', 'e.id')).toContain('c.entity_id = e.id');
        expect(projectionSourceExpr(column, 'abc123', '$1')).toContain('c.entity_id = $1');
        expect(projectionSourceExpr(column, 'abc123', 'r.entity_id')).toContain('= r.entity_id');
    });

    test('rejects injected expressions', () => {
        expect(() => projectionSourceExpr(column, 'abc123', "1 OR true--")).toThrow(/Invalid projection entity reference/);
        expect(() => projectionSourceExpr(column, 'abc123', '$1; DROP TABLE x')).toThrow(/Invalid projection entity reference/);
    });
});
