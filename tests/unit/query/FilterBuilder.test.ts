/**
 * Unit tests for FilterBuilder utility functions
 */
import { describe, test, expect } from 'bun:test';
import { buildJSONPath, composeFilters, type FilterBuilder, type FilterResult } from '../../../query/FilterBuilder';

describe('FilterBuilder', () => {
    describe('buildJSONPath()', () => {
        test('builds simple field path', () => {
            const result = buildJSONPath('name', 'c');
            expect(result).toBe("c.data->>'name'");
        });

        test('builds nested field path', () => {
            const result = buildJSONPath('location.latitude', 'c');
            expect(result).toBe("c.data->'location'->>'latitude'");
        });

        test('builds deeply nested path', () => {
            const result = buildJSONPath('device.location.coordinates.latitude', 'c');
            expect(result).toBe("c.data->'device'->'location'->'coordinates'->>'latitude'");
        });

        test('uses provided alias', () => {
            const result = buildJSONPath('field', 'comp');
            expect(result).toBe("comp.data->>'field'");
        });
    });

    describe('composeFilters()', () => {
        test('throws for empty array', () => {
            expect(() => composeFilters([])).toThrow('Cannot compose empty array of filter builders');
        });

        test('composes single builder', () => {
            const mockBuilder: FilterBuilder = () => ({
                sql: 'field = $1',
                addedParams: 1
            });

            const composed = composeFilters([mockBuilder]);
            const result = composed(
                { field: 'test', operator: 'EQ', value: 'value' },
                'c',
                {} as any
            );

            expect(result.sql).toBe('(field = $1)');
            expect(result.addedParams).toBe(1);
        });

        test('composes multiple builders with AND', () => {
            const builder1: FilterBuilder = () => ({
                sql: 'field1 = $1',
                addedParams: 1
            });
            const builder2: FilterBuilder = () => ({
                sql: 'field2 > $2',
                addedParams: 1
            });

            const composed = composeFilters([builder1, builder2]);
            const result = composed(
                { field: 'test', operator: 'EQ', value: 'value' },
                'c',
                {} as any
            );

            expect(result.sql).toBe('(field1 = $1) AND (field2 > $2)');
            expect(result.addedParams).toBe(2);
        });

        test('handles empty SQL from builder', () => {
            const builder1: FilterBuilder = () => ({
                sql: 'field1 = $1',
                addedParams: 1
            });
            const builder2: FilterBuilder = () => ({
                sql: '',
                addedParams: 0
            });

            const composed = composeFilters([builder1, builder2]);
            const result = composed(
                { field: 'test', operator: 'EQ', value: 'value' },
                'c',
                {} as any
            );

            expect(result.sql).toBe('(field1 = $1)');
            expect(result.addedParams).toBe(1);
        });

        test('handles whitespace-only SQL', () => {
            const builder: FilterBuilder = () => ({
                sql: '   ',
                addedParams: 0
            });

            const composed = composeFilters([builder]);
            const result = composed(
                { field: 'test', operator: 'EQ', value: 'value' },
                'c',
                {} as any
            );

            expect(result.sql).toBe('');
            expect(result.addedParams).toBe(0);
        });
    });
});
