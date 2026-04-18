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

export class InvalidIdentifierError extends Error {
    constructor(context: string, value: string) {
        super(`Invalid SQL identifier in ${context}: ${JSON.stringify(value)}`);
        this.name = 'InvalidIdentifierError';
    }
}
