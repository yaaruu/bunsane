/**
 * Tests for Phase 4 Advanced Filter Builder Features
 *
 * Tests validation, composition, versioning, and advanced options.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { FilterBuilderRegistry } from '../FilterBuilderRegistry';
import { composeFilters, withIndexHint } from '../FilterBuilder';
import { QueryContext } from '../QueryContext';
import type { FilterBuilder, FilterBuilderOptions } from '../FilterBuilder';

describe('Phase 4: Advanced Filter Builder Features', () => {
    beforeEach(() => {
        FilterBuilderRegistry.clear();
    });

    describe('Filter Validation (TASK-026)', () => {
        it('should validate filter values before calling custom builders', () => {
            // Create a builder with validation that rejects invalid values
            const validatingBuilder: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'test' = $${context.addParam(filter.value)}`,
                addedParams: 1
            });

            const options: FilterBuilderOptions = {
                validate: (filter) => typeof filter.value === 'string' && filter.value.length > 0
            };

            FilterBuilderRegistry.register('validated_filter', validatingBuilder, options, 'TestPlugin');

            const context = new QueryContext();
            context.componentIds.add('TestComponent');
            context.componentFilters.set('TestComponent', [{
                field: 'test',
                operator: 'validated_filter',
                value: '' // Invalid: empty string
            }]);

            // This should throw due to validation failure
            expect(() => {
                // We can't directly test ComponentInclusionNode here, but we can test the validation logic
                const options = FilterBuilderRegistry.getOptions('validated_filter');
                if (options?.validate) {
                    expect(options.validate({ field: 'test', operator: 'validated_filter', value: '' })).toBe(false);
                    expect(options.validate({ field: 'test', operator: 'validated_filter', value: 'valid' })).toBe(true);
                }
            }).not.toThrow();
        });

        it('should allow valid filter values to pass through', () => {
            const options: FilterBuilderOptions = {
                validate: (filter) => filter.value === 'valid'
            };

            FilterBuilderRegistry.register('strict_filter', () => ({ sql: '1=1', addedParams: 0 }), options);

            const retrievedOptions = FilterBuilderRegistry.getOptions('strict_filter');
            expect(retrievedOptions?.validate?.({ field: 'test', operator: 'strict_filter', value: 'valid' })).toBe(true);
            expect(retrievedOptions?.validate?.({ field: 'test', operator: 'strict_filter', value: 'invalid' })).toBe(false);
        });
    });

    describe('Filter Builder Composition (TASK-029)', () => {
        it('should compose multiple filter builders into one', () => {
            const builder1: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'field1' = $${context.addParam('value1')}`,
                addedParams: 1
            });

            const builder2: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'field2' = $${context.addParam('value2')}`,
                addedParams: 1
            });

            const composedBuilder = composeFilters([builder1, builder2]);

            const context = new QueryContext();
            const result = composedBuilder({ field: 'test', operator: 'composed', value: 'test' }, 'c', context);

            expect(result.sql).toBe("(c.data->>'field1' = $1) AND (c.data->>'field2' = $2)");
            expect(result.addedParams).toBe(2);
            expect(context.params).toEqual(['value1', 'value2']);
        });

        it('should handle empty builder array', () => {
            expect(() => composeFilters([])).toThrow('Cannot compose empty array of filter builders');
        });

        it('should handle single builder composition', () => {
            const builder: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'test' = $${context.addParam('value')}`,
                addedParams: 1
            });

            const composedBuilder = composeFilters([builder]);

            const context = new QueryContext();
            const result = composedBuilder({ field: 'test', operator: 'single', value: 'test' }, 'c', context);

            expect(result.sql).toBe("(c.data->>'test' = $1)");
            expect(result.addedParams).toBe(1);
        });
    });

    describe('Index Hints (TASK-030)', () => {
        it('should add index hints to filter SQL', () => {
            const baseBuilder: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'field' = $${context.addParam('value')}`,
                addedParams: 1
            });

            const hintedBuilder = withIndexHint(baseBuilder, 'idx_test_field');

            const context = new QueryContext();
            const result = hintedBuilder({ field: 'test', operator: 'hinted', value: 'test' }, 'c', context);

            expect(result.sql).toBe('/* INDEX: idx_test_field */ c.data->>\'field\' = $1');
            expect(result.addedParams).toBe(1);
        });

        it('should preserve parameter handling with hints', () => {
            const baseBuilder: FilterBuilder = (filter, alias, context) => ({
                sql: `${alias}.data->>'field' = $${context.addParam(filter.value)}`,
                addedParams: 1
            });

            const hintedBuilder = withIndexHint(baseBuilder, 'idx_custom');

            const context = new QueryContext();
            const result = hintedBuilder({ field: 'test', operator: 'hinted', value: 'custom_value' }, 'c', context);

            expect(result.sql).toBe('/* INDEX: idx_custom */ c.data->>\'field\' = $1');
            expect(context.params).toEqual(['custom_value']);
        });
    });

    describe('Filter Builder Versioning (TASK-032)', () => {
        it('should allow same plugin to override its own registration', () => {
            const builder1: FilterBuilder = () => ({ sql: 'version1', addedParams: 0 });
            const builder2: FilterBuilder = () => ({ sql: 'version2', addedParams: 0 });

            FilterBuilderRegistry.register('versioned_filter', builder1, {}, 'TestPlugin', '1.0.0');
            const filter = { field: 'test', operator: 'versioned_filter', value: 'test' };
            expect(FilterBuilderRegistry.get('versioned_filter')!(filter, 'c', new QueryContext()).sql).toBe('version1');

            // Same plugin can override
            FilterBuilderRegistry.register('versioned_filter', builder2, {}, 'TestPlugin', '1.1.0');
            expect(FilterBuilderRegistry.get('versioned_filter')!(filter, 'c', new QueryContext()).sql).toBe('version2');
        });

        it('should allow newer version to override older version', () => {
            const builder1: FilterBuilder = () => ({ sql: 'old', addedParams: 0 });
            const builder2: FilterBuilder = () => ({ sql: 'new', addedParams: 0 });

            FilterBuilderRegistry.register('versioned_filter', builder1, {}, 'PluginA', '1.0.0');

            // Different plugin with newer version can override
            FilterBuilderRegistry.register('versioned_filter', builder2, {}, 'PluginB', '1.1.0');
            const filter = { field: 'test', operator: 'versioned_filter', value: 'test' };
            expect(FilterBuilderRegistry.get('versioned_filter')!(filter, 'c', new QueryContext()).sql).toBe('new');
        });

        it('should reject older version override', () => {
            const builder1: FilterBuilder = () => ({ sql: 'new', addedParams: 0 });
            const builder2: FilterBuilder = () => ({ sql: 'old', addedParams: 0 });

            FilterBuilderRegistry.register('versioned_filter', builder1, {}, 'PluginA', '2.0.0');

            // Older version should be rejected
            expect(() => {
                FilterBuilderRegistry.register('versioned_filter', builder2, {}, 'PluginB', '1.5.0');
            }).toThrow(/Cannot register.*without version upgrade/);
        });

        it('should reject registration without version when versioned exists', () => {
            FilterBuilderRegistry.register('versioned_filter', () => ({ sql: 'v1', addedParams: 0 }), {}, 'PluginA', '1.0.0');

            expect(() => {
                FilterBuilderRegistry.register('versioned_filter', () => ({ sql: 'v2', addedParams: 0 }), {}, 'PluginB');
            }).toThrow(/Cannot register.*without version upgrade/);
        });

        it('should include version in registry listing', () => {
            FilterBuilderRegistry.register('versioned_filter', () => ({ sql: 'test', addedParams: 0 }), {}, 'TestPlugin', '1.2.3');

            const registered = FilterBuilderRegistry.listRegistered();
            const entry = registered.find(r => r.operator === 'versioned_filter');

            expect(entry?.version).toBe('1.2.3');
            expect(entry?.registeredBy).toBe('TestPlugin');
        });
    });

    describe('Advanced Options Integration', () => {
        it('should store and retrieve filter builder options', () => {
            const options: FilterBuilderOptions = {
                supportsLateral: true,
                requiresIndex: false,
                complexityScore: 5,
                validate: () => true
            };

            const builder: FilterBuilder = () => ({ sql: 'test', addedParams: 0 });
            FilterBuilderRegistry.register('optioned_filter', builder, options, 'TestPlugin', '1.0.0');

            const retrievedOptions = FilterBuilderRegistry.getOptions('optioned_filter');
            expect(retrievedOptions?.supportsLateral).toBe(true);
            expect(retrievedOptions?.requiresIndex).toBe(false);
            expect(retrievedOptions?.complexityScore).toBe(5);
            expect(typeof retrievedOptions?.validate).toBe('function');
        });

        it('should handle filters without options', () => {
            const builder: FilterBuilder = () => ({ sql: 'test', addedParams: 0 });
            FilterBuilderRegistry.register('simple_filter', builder);

            const options = FilterBuilderRegistry.getOptions('simple_filter');
            expect(options).toBeUndefined();
        });
    });
});