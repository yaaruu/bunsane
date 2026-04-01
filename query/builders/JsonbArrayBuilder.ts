/**
 * JSONB Array Filter Builders
 *
 * Provides PostgreSQL JSONB array containment and existence operators
 * as custom filter builders for the BunSane Query system.
 *
 * Operators:
 * - CONTAINS (@>)      — array contains value(s)
 * - CONTAINED_BY (<@)  — array is subset of given values
 * - HAS_ANY (?|)       — array has any of the given values
 * - HAS_ALL (?&)       — array has all of the given values
 */

import type { FilterBuilder, FilterBuilderOptions } from "../FilterBuilder";
import { buildJSONBPath } from "../FilterBuilder";
import type { QueryFilter } from "../QueryContext";
import type { QueryContext } from "../QueryContext";

export const JSONB_ARRAY_OPS = {
    CONTAINS: "CONTAINS",
    CONTAINED_BY: "CONTAINED_BY",
    HAS_ANY: "HAS_ANY",
    HAS_ALL: "HAS_ALL",
} as const;

function normalizeToArray(value: any): any[] {
    return Array.isArray(value) ? value : [value];
}

function validateJsonbArrayFilter(filter: QueryFilter): boolean {
    if (filter.value === null || filter.value === undefined) return false;
    const arr = normalizeToArray(filter.value);
    return arr.length > 0 && arr.every(
        (v: any) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
}

/**
 * CONTAINS (@>) — "array contains value(s)"
 *
 * Single value: Query.filter("tags", FilterOp.CONTAINS, "urgent")
 * Multiple:     Query.filter("tags", FilterOp.CONTAINS, ["urgent", "high"])
 */
export const jsonbContainsBuilder: FilterBuilder = (
    filter: QueryFilter, alias: string, context: QueryContext
): { sql: string; addedParams: number } => {
    const jsonbPath = buildJSONBPath(filter.field, alias);
    const values = normalizeToArray(filter.value);
    const paramIndex = context.addParam(values);
    return {
        sql: `${jsonbPath} @> $${paramIndex}::jsonb`,
        addedParams: 1,
    };
};

/**
 * CONTAINED_BY (<@) — "array is subset of given values"
 *
 * Query.filter("tags", FilterOp.CONTAINED_BY, ["urgent", "high", "low"])
 */
export const jsonbContainedByBuilder: FilterBuilder = (
    filter: QueryFilter, alias: string, context: QueryContext
): { sql: string; addedParams: number } => {
    const jsonbPath = buildJSONBPath(filter.field, alias);
    const values = normalizeToArray(filter.value);
    const paramIndex = context.addParam(values);
    return {
        sql: `${jsonbPath} <@ $${paramIndex}::jsonb`,
        addedParams: 1,
    };
};

/**
 * HAS_ANY (?|) — "array has any of the given values"
 *
 * Query.filter("tags", FilterOp.HAS_ANY, ["urgent", "high"])
 *
 * Note: ?| operates on text[], so values are cast to strings.
 */
export const jsonbHasAnyBuilder: FilterBuilder = (
    filter: QueryFilter, alias: string, context: QueryContext
): { sql: string; addedParams: number } => {
    const jsonbPath = buildJSONBPath(filter.field, alias);
    const values = normalizeToArray(filter.value).map(String);
    const paramIndex = context.addParam(values);
    return {
        sql: `${jsonbPath} ?| $${paramIndex}::text[]`,
        addedParams: 1,
    };
};

/**
 * HAS_ALL (?&) — "array has all of the given values"
 *
 * Query.filter("tags", FilterOp.HAS_ALL, ["urgent", "high"])
 *
 * Note: ?& operates on text[], so values are cast to strings.
 */
export const jsonbHasAllBuilder: FilterBuilder = (
    filter: QueryFilter, alias: string, context: QueryContext
): { sql: string; addedParams: number } => {
    const jsonbPath = buildJSONBPath(filter.field, alias);
    const values = normalizeToArray(filter.value).map(String);
    const paramIndex = context.addParam(values);
    return {
        sql: `${jsonbPath} ?& $${paramIndex}::text[]`,
        addedParams: 1,
    };
};

export const jsonbArrayOptions: FilterBuilderOptions = {
    supportsLateral: true,
    requiresIndex: false,
    complexityScore: 1,
    validate: validateJsonbArrayFilter,
};
