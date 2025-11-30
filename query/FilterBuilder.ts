/**
 * Custom Filter Builder System for Bunsane Query Framework
 *
 * This module provides the core types and interfaces for extensible query filtering,
 * enabling plugins to register custom filter operators that integrate seamlessly
 * with the DAG-based Query system.
 */

import type { QueryFilter } from "./QueryContext";
import type { QueryContext } from "./QueryContext";

/**
 * Result returned by a custom filter builder function
 */
export interface FilterResult {
    /** The SQL fragment to append to the WHERE clause */
    sql: string;
    /** Number of parameters added to the context by this filter */
    addedParams: number;
}

/**
 * Function signature for custom filter builders
 *
 * @param filter - The filter specification containing field, operator, and value
 * @param alias - The table alias for the component table (e.g., "c" for components)
 * @param context - The query context for parameter management and caching
 * @returns FilterResult containing SQL fragment and parameter count
 */
export type FilterBuilder = (filter: QueryFilter, alias: string, context: QueryContext) => FilterResult;

/**
 * Options for advanced filter builder configuration
 */
export interface FilterBuilderOptions {
    /** Whether this filter supports LATERAL join optimization */
    supportsLateral?: boolean;
    /** Whether this filter requires database indexes for optimal performance */
    requiresIndex?: boolean;
    /** Complexity score for performance monitoring (0-10, higher = more complex) */
    complexityScore?: number;
    /** Optional validation function for filter values */
    validate?: (filter: QueryFilter) => boolean;
}

/**
 * Build a JSON path expression for nested field access
 *
 * @param field - The field path (e.g., "location.coordinates.latitude")
 * @param alias - The table alias (e.g., "c")
 * @returns PostgreSQL JSON path expression
 *
 * @example
 * buildJSONPath("device.unique_id", "c") // "c.data->'device'->>'unique_id'"
 * buildJSONPath("latitude", "c") // "c.data->>'latitude'"
 */
export function buildJSONPath(field: string, alias: string): string {
    if (field.includes('.')) {
        const parts = field.split('.');
        const lastPart = parts.pop()!;
        const nestedPath = parts.map(p => `'${p}'`).join('->');
        return `${alias}.data->${nestedPath}->>'${lastPart}'`;
    } else {
        return `${alias}.data->>'${field}'`;
    }
}

/**
 * Compose multiple filter builders into a single builder that applies all conditions
 *
 * This allows chaining multiple custom filters together (e.g., spatial proximity AND full-text search).
 * All builders are executed and their SQL fragments are combined with AND.
 *
 * @param builders - Array of filter builders to compose
 * @returns A composed filter builder function
 *
 * @example
 * const spatialAndTextBuilder = composeFilters([withinDistanceBuilder, fullTextSearchBuilder]);
 * // Results in: (spatial_condition) AND (text_search_condition)
 */
export function composeFilters(builders: FilterBuilder[]): FilterBuilder {
    if (builders.length === 0) {
        throw new Error('Cannot compose empty array of filter builders');
    }

    return (filter: QueryFilter, alias: string, context: QueryContext): FilterResult => {
        const conditions: string[] = [];
        let totalParams = 0;

        for (const builder of builders) {
            const result = builder(filter, alias, context);
            if (result.sql.trim()) {
                conditions.push(`(${result.sql})`);
            }
            totalParams += result.addedParams;
        }

        return {
            sql: conditions.join(' AND '),
            addedParams: totalParams
        };
    };
}

/**
 * Create a filter builder that adds SQL hints for index usage
 *
 * This wrapper adds PostgreSQL query hints to suggest index usage to the planner.
 * Useful for custom filters that require specific indexes for optimal performance.
 *
 * @param builder - The original filter builder
 * @param indexHint - The index name to hint (e.g., "idx_spatial_location")
 * @returns A filter builder that includes index hints
 *
 * @example
 * const hintedBuilder = withIndexHint(spatialBuilder, 'idx_spatial_location');
 * // Generates: /&#42; INDEX: idx_spatial_location &#42;/ (spatial_condition)
 */
export function withIndexHint(builder: FilterBuilder, indexHint: string): FilterBuilder {
    return (filter: QueryFilter, alias: string, context: QueryContext): FilterResult => {
        const result = builder(filter, alias, context);
        return {
            sql: `/* INDEX: ${indexHint} */ ${result.sql}`,
            addedParams: result.addedParams
        };
    };
}