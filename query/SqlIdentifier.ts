/**
 * SQL identifier sanitization helpers.
 *
 * These helpers prevent SQL injection when interpolating caller-supplied or
 * metadata-derived strings into SQL via `db.unsafe(...)` or template literals.
 * Parameter binding (`$1`, `$2`) is always preferred for values, but column
 * names, table names, ORDER BY fields, and JSON path segments cannot be
 * parameterized — they are sanitized against a strict allow-list instead.
 *
 * Ticket C08.
 */

/** Matches a safe identifier: letter/underscore followed by letters/digits/underscores. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Matches a safe component table name: `components` or `components_<ident>`. */
const COMPONENT_TABLE_RE = /^components(?:_[a-z0-9_]+)?$/;

/**
 * PostgreSQL text-search languages supported by `to_tsvector(config, ...)`.
 * Extend as needed for deployments with additional dictionaries installed.
 */
const ALLOWED_TS_LANGUAGES = new Set<string>([
    'simple',
    'english',
    'french',
    'german',
    'spanish',
    'italian',
    'portuguese',
    'dutch',
    'russian',
    'swedish',
    'norwegian',
    'danish',
    'finnish',
    'turkish',
    'hungarian',
    'arabic',
    'indonesian',
    'irish',
    'lithuanian',
    'nepali',
    'romanian',
    'tamil',
    'yiddish',
]);

/**
 * Assert a string is a safe SQL identifier (column name, alias). Throws
 * `InvalidIdentifierError` if not.
 */
export function assertIdentifier(value: unknown, context: string): string {
    if (typeof value !== 'string' || !IDENT_RE.test(value)) {
        throw new InvalidIdentifierError(context, String(value));
    }
    return value;
}

/**
 * Assert a string is a safe component table name (e.g. `components`,
 * `components_user`). Throws if not.
 */
export function assertComponentTableName(value: unknown, context: string): string {
    if (typeof value !== 'string' || !COMPONENT_TABLE_RE.test(value)) {
        throw new InvalidIdentifierError(context, String(value));
    }
    return value;
}

/**
 * Assert a dotted JSON field path is safe. Each segment must be a valid
 * identifier. Empty paths / empty segments are rejected.
 */
export function assertFieldPath(value: unknown, context: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidIdentifierError(context, String(value));
    }
    const parts = value.split('.');
    for (const p of parts) {
        if (!IDENT_RE.test(p)) {
            throw new InvalidIdentifierError(context, value);
        }
    }
    return value;
}

/**
 * Assert a text-search language is in the allow-list. Defaults to `simple`
 * when undefined (behavior preserved from the prior implementation).
 */
export function assertTsLanguage(value: unknown, context: string = 'tsLanguage'): string {
    if (value === undefined || value === null) return 'simple';
    if (typeof value !== 'string' || !ALLOWED_TS_LANGUAGES.has(value.toLowerCase())) {
        throw new InvalidIdentifierError(context, String(value));
    }
    return value.toLowerCase();
}

/**
 * Escape a value for interpolation inside a single-quoted PostgreSQL string
 * literal (`data->>'${key}'`). Unlike `assertFieldPath` this does NOT restrict
 * characters: JSONB keys legitimately contain dashes, spaces or dots, and
 * rejecting them would break working queries. Escaping makes injection
 * impossible while preserving every key. (SEC-03)
 */
export function escapeJsonLiteral(value: unknown): string {
    return String(value).replace(/'/g, "''");
}

/**
 * Normalize an ORDER BY direction to the closed ASC/DESC set. Anything that
 * is not exactly 'DESC' becomes 'ASC' — a malformed direction can never reach
 * SQL text. (SEC-03)
 */
export function normalizeSortDirection(value: unknown): 'ASC' | 'DESC' {
    return value === 'DESC' ? 'DESC' : 'ASC';
}

/**
 * Operators accepted by the default (non-registered) filter predicate path.
 * Custom operators are dispatched through FilterBuilderRegistry before this
 * set is consulted, so plugin operators are unaffected.
 */
export const KNOWN_FILTER_OPERATORS: ReadonlySet<string> = new Set([
    '=', '>', '<', '>=', '<=', '!=',
    'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE',
    'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL',
    'CONTAINS', 'CONTAINED_BY', 'HAS_ANY', 'HAS_ALL',
]);

export class InvalidIdentifierError extends Error {
    constructor(context: string, value: string) {
        super(`Invalid SQL identifier in ${context}: ${JSON.stringify(value)}`);
        this.name = 'InvalidIdentifierError';
    }
}
