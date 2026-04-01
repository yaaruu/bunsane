/**
 * Unit tests for JSONB Array Filter Builders
 */
import { describe, test, expect } from 'bun:test';
import { buildJSONBPath } from '../../../query/FilterBuilder';
import { QueryContext } from '../../../query/QueryContext';
import {
    jsonbContainsBuilder,
    jsonbContainedByBuilder,
    jsonbHasAnyBuilder,
    jsonbHasAllBuilder,
    jsonbArrayOptions,
} from '../../../query/builders/JsonbArrayBuilder';

describe('buildJSONBPath', () => {
    test('simple field returns JSONB node path', () => {
        expect(buildJSONBPath('tags', 'c')).toBe("c.data->'tags'");
    });

    test('nested field returns JSONB node path', () => {
        expect(buildJSONBPath('metadata.tags', 'c')).toBe("c.data->'metadata'->'tags'");
    });

    test('deeply nested field', () => {
        expect(buildJSONBPath('a.b.c', 'c')).toBe("c.data->'a'->'b'->'c'");
    });

    test('uses provided alias', () => {
        expect(buildJSONBPath('tags', 'comp')).toBe("comp.data->'tags'");
    });
});

describe('jsonbContainsBuilder (@>)', () => {
    test('single string value is auto-wrapped in array', () => {
        const ctx = new QueryContext();
        const result = jsonbContainsBuilder(
            { field: 'tags', operator: 'CONTAINS', value: 'urgent' },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'tags' @> $1::jsonb");
        expect(ctx.params[0]).toEqual(['urgent']);
        expect(result.addedParams).toBe(1);
    });

    test('array value is passed as raw array', () => {
        const ctx = new QueryContext();
        const result = jsonbContainsBuilder(
            { field: 'tags', operator: 'CONTAINS', value: ['a', 'b'] },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'tags' @> $1::jsonb");
        expect(ctx.params[0]).toEqual(['a', 'b']);
    });

    test('nested field path', () => {
        const ctx = new QueryContext();
        const result = jsonbContainsBuilder(
            { field: 'meta.tags', operator: 'CONTAINS', value: 'x' },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'meta'->'tags' @> $1::jsonb");
    });

    test('numeric value', () => {
        const ctx = new QueryContext();
        jsonbContainsBuilder(
            { field: 'scores', operator: 'CONTAINS', value: 42 },
            'c', ctx
        );
        expect(ctx.params[0]).toEqual([42]);
    });
});

describe('jsonbContainedByBuilder (<@)', () => {
    test('generates correct SQL', () => {
        const ctx = new QueryContext();
        const result = jsonbContainedByBuilder(
            { field: 'tags', operator: 'CONTAINED_BY', value: ['a', 'b', 'c'] },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'tags' <@ $1::jsonb");
        expect(ctx.params[0]).toEqual(['a', 'b', 'c']);
        expect(result.addedParams).toBe(1);
    });

    test('single value is auto-wrapped', () => {
        const ctx = new QueryContext();
        jsonbContainedByBuilder(
            { field: 'tags', operator: 'CONTAINED_BY', value: 'only' },
            'c', ctx
        );
        expect(ctx.params[0]).toEqual(['only']);
    });
});

describe('jsonbHasAnyBuilder (?|)', () => {
    test('generates correct SQL with text[] cast', () => {
        const ctx = new QueryContext();
        const result = jsonbHasAnyBuilder(
            { field: 'tags', operator: 'HAS_ANY', value: ['a', 'b'] },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'tags' ?| $1::text[]");
        expect(ctx.params[0]).toEqual(['a', 'b']);
        expect(result.addedParams).toBe(1);
    });

    test('single value is auto-wrapped and stringified', () => {
        const ctx = new QueryContext();
        jsonbHasAnyBuilder(
            { field: 'tags', operator: 'HAS_ANY', value: 'solo' },
            'c', ctx
        );
        expect(ctx.params[0]).toEqual(['solo']);
    });

    test('numeric values are cast to strings', () => {
        const ctx = new QueryContext();
        jsonbHasAnyBuilder(
            { field: 'ids', operator: 'HAS_ANY', value: [1, 2, 3] },
            'c', ctx
        );
        expect(ctx.params[0]).toEqual(['1', '2', '3']);
    });
});

describe('jsonbHasAllBuilder (?&)', () => {
    test('generates correct SQL with text[] cast', () => {
        const ctx = new QueryContext();
        const result = jsonbHasAllBuilder(
            { field: 'tags', operator: 'HAS_ALL', value: ['x', 'y'] },
            'c', ctx
        );
        expect(result.sql).toBe("c.data->'tags' ?& $1::text[]");
        expect(ctx.params[0]).toEqual(['x', 'y']);
        expect(result.addedParams).toBe(1);
    });
});

describe('validation', () => {
    const validate = jsonbArrayOptions.validate!;

    test('rejects null value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: null })).toBe(false);
    });

    test('rejects undefined value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: undefined })).toBe(false);
    });

    test('rejects empty array', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: [] })).toBe(false);
    });

    test('accepts string value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: 'tag' })).toBe(true);
    });

    test('accepts number value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: 42 })).toBe(true);
    });

    test('accepts boolean value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: true })).toBe(true);
    });

    test('accepts array of strings', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: ['a', 'b'] })).toBe(true);
    });

    test('rejects object value', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: { key: 'val' } })).toBe(false);
    });

    test('rejects array with non-primitive elements', () => {
        expect(validate({ field: 'f', operator: 'CONTAINS', value: [{ a: 1 }] })).toBe(false);
    });
});
