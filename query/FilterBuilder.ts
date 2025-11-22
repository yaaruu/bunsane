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