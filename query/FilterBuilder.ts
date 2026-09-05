/**
 * Custom Filter Builder System for Bunsane Query Framework
 *
 * This module provides the core types and interfaces for extensible query filtering,
 * enabling plugins to register custom filter operators that integrate seamlessly
 * with the DAG-based Query system.
 */

import type { QueryFilter } from "./QueryContext";
import type { QueryContext } from "./QueryContext";
import { FilterBuilderRegistry } from "./FilterBuilderRegistry";
import { escapeJsonLiteral, KNOWN_FILTER_OPERATORS } from "./SqlIdentifier";
import {
    numericJsonCompareSql,
    numericJsonTextValidPredicate,
} from "../database/numericJsonField";

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
    // SEC-03: keys are escaped for the single-quoted literal, so a crafted
    // field ("x' OR true --") stays a literal instead of breaking out. Exotic
    // but legal keys (dashes, spaces) keep working.
    if (field.includes('.')) {
        const parts = field.split('.');
        const lastPart = parts.pop()!;
        const nestedPath = parts.map(p => `'${escapeJsonLiteral(p)}'`).join('->');
        return `${alias}.data->${nestedPath}->>'${escapeJsonLiteral(lastPart)}'`;
    } else {
        return `${alias}.data->>'${escapeJsonLiteral(field)}'`;
    }
}

/**
 * Build a JSON path expression that returns a JSONB node (not text)
 *
 * Unlike buildJSONPath which uses ->> (text extraction) at the leaf,
 * this uses -> throughout, preserving the JSONB type. Required for
 * JSONB operators like @>, <@, ?|, ?& that operate on JSONB values.
 *
 * @param field - The field path (e.g., "tags" or "metadata.tags")
 * @param alias - The table alias (e.g., "c")
 * @returns PostgreSQL JSONB path expression
 *
 * @example
 * buildJSONBPath("tags", "c")          // "c.data->'tags'"
 * buildJSONBPath("metadata.tags", "c") // "c.data->'metadata'->'tags'"
 */
export function buildJSONBPath(field: string, alias: string): string {
    // SEC-03: same escaping discipline as buildJSONPath.
    if (field.includes('.')) {
        const parts = field.split('.');
        const lastPart = parts.pop()!;
        const nestedPath = parts.map(p => `'${escapeJsonLiteral(p)}'`).join('->');
        return `${alias}.data->${nestedPath}->'${escapeJsonLiteral(lastPart)}'`;
    }
    return `${alias}.data->'${escapeJsonLiteral(field)}'`;
}

/**
 * Determine the type cast for an `IN` / `NOT IN` value list against a JSONB
 * text-extracted field (`data->>'x'` always yields text). Without a cast a
 * numeric/boolean list produces `text IN (1, 2)` → PostgreSQL "operator does
 * not exist: text = integer". When every element is a number (or boolean) we
 * cast both the field and each parameter, mirroring the scalar `=` path. Mixed
 * or string lists stay as plain text comparison (the correct default).
 *
 * @returns `lhs(path)` wraps the field expression; `param` is the per-parameter
 *          cast suffix (e.g. `::numeric`), `''` for text.
 */
export function jsonbInListCast(values: any[]): { lhs: (path: string) => string; param: string } {
    const allNumbers = values.length > 0 && values.every(v => typeof v === 'number');
    if (allNumbers) return { lhs: (p) => `(${p})::numeric`, param: '::numeric' };
    const allBooleans = values.length > 0 && values.every(v => typeof v === 'boolean');
    if (allBooleans) return { lhs: (p) => `(${p})::boolean`, param: '::boolean' };
    return { lhs: (p) => p, param: '' };
}

/**
 * Build a single field predicate against `<alias>.data` for default operators
 * and registered custom FilterBuilder operators. Shared by INTERSECT/CTE
 * membership pushdown, EXISTS coalescing, and sort-driven scan so all paths
 * emit the same SQL shape.
 */
export function buildComponentFilterCondition(
    filter: QueryFilter,
    alias: string,
    context: QueryContext
): string {
    if (FilterBuilderRegistry.has(filter.operator)) {
        const options = FilterBuilderRegistry.getOptions(filter.operator);
        if (options?.validate && !options.validate(filter)) {
            throw new Error(
                `Invalid filter value for operator '${filter.operator}': ${JSON.stringify(filter.value)}`
            );
        }
        return FilterBuilderRegistry.get(filter.operator)!(filter, alias, context).sql;
    }

    // SEC-03: the operator is interpolated into SQL text below. Custom
    // operators were dispatched above; anything reaching this point must be
    // in the closed known set, or it is either a typo or an injection attempt.
    if (!KNOWN_FILTER_OPERATORS.has(String(filter.operator))) {
        throw new Error(
            `Unsupported filter operator: ${JSON.stringify(filter.operator)}. ` +
            `Register custom operators via FilterBuilderRegistry.`
        );
    }

    const jsonPath = buildJSONPath(filter.field, alias);
    const valueStr = String(filter.value);
    const isUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);

    if (isUUID && filter.operator === '=') {
        return `${jsonPath} = $${context.addParam(filter.value)}`;
    }
    if (filter.operator === 'LIKE' || filter.operator === 'NOT LIKE' || filter.operator === 'ILIKE') {
        return `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}`;
    }
    if (filter.operator === 'IS NULL') {
        return `(${jsonPath} IS NULL OR ${jsonPath} = '')`;
    }
    if (filter.operator === 'IS NOT NULL') {
        return `(${jsonPath} IS NOT NULL AND ${jsonPath} <> '')`;
    }
    if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
        if (Array.isArray(filter.value) && filter.value.length > 0) {
            const cast = jsonbInListCast(filter.value);
            const placeholders = filter.value
                .map((v: any) => `$${context.addParam(v)}${cast.param}`)
                .join(', ');
            const listPred = `${cast.lhs(jsonPath)} ${filter.operator} (${placeholders})`;
            // Numeric IN lists need the partial-index validity predicate too.
            if (cast.param === '::numeric') {
                return `${numericJsonTextValidPredicate(jsonPath)} AND ${listPred}`;
            }
            return listPred;
        }
        if (Array.isArray(filter.value) && filter.value.length === 0) {
            return filter.operator === 'IN' ? 'FALSE' : 'TRUE';
        }
        throw new Error(`${filter.operator} operator requires an array of values`);
    }
    if (typeof filter.value === 'number') {
        // Restate partial numeric index predicate (RP-04 / BUG-1).
        return numericJsonCompareSql(
            jsonPath,
            filter.operator,
            `$${context.addParam(filter.value)}::numeric`
        );
    }
    if (typeof filter.value === 'boolean') {
        return `(${jsonPath})::boolean ${filter.operator} $${context.addParam(filter.value)}`;
    }
    return `${jsonPath} ${filter.operator} $${context.addParam(filter.value)}`;
}

/**
 * AND-join every filter for one component into predicates on `alias`.
 * Returns null when there are no filters (caller keeps membership-only branch).
 */
export function buildComponentFilterGroup(
    filters: QueryFilter[],
    alias: string,
    context: QueryContext
): string | null {
    if (!filters.length) return null;
    return filters
        .map((f) => buildComponentFilterCondition(f, alias, context))
        .join(' AND ');
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