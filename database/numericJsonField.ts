/**
 * Shared numeric JSONB field helpers for index DDL and query emission (RP-04 / BUG-1).
 *
 * `ensureNumericIndex` builds a *partial* functional index:
 *   ((data->>'f')::numeric) WHERE data->>'f' IS NOT NULL
 *                            AND data->>'f' ~ NUMERIC_JSON_TEXT_REGEX
 *
 * PostgreSQL only uses a partial index when the query's WHERE implies that
 * predicate. Emitting bare `(data->>'f')::numeric > $1` therefore falls back
 * to seq scans. Restate the validity predicate alongside every numeric
 * comparison / sort scan so the planner can pick the index.
 *
 * Keep the regex literal identical between DDL and query paths — do not drift.
 */

/** Partial-index / query validity regex for JSON text that casts cleanly to numeric. */
export const NUMERIC_JSON_TEXT_REGEX = '^-?[0-9]+\\.?[0-9]*$';

/**
 * Predicate that a JSON text expression holds a castable number.
 * `jsonTextExpr` is e.g. `c.data->>'age'` or `data->>'age'`.
 */
export function numericJsonTextValidPredicate(jsonTextExpr: string): string {
    return `${jsonTextExpr} IS NOT NULL AND ${jsonTextExpr} ~ '${NUMERIC_JSON_TEXT_REGEX}'`;
}

/**
 * Numeric comparison that restates the partial-index predicate so the
 * functional numeric index is eligible.
 */
export function numericJsonCompareSql(
    jsonTextExpr: string,
    operator: string,
    paramPlaceholder: string
): string {
    return (
        `${numericJsonTextValidPredicate(jsonTextExpr)} ` +
        `AND (${jsonTextExpr})::numeric ${operator} ${paramPlaceholder}`
    );
}
