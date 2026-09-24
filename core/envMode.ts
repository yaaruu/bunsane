/**
 * Environment-mode gates (SEC-08).
 *
 * Error verbosity previously keyed off `NODE_ENV !== 'production'` in some
 * modules and `=== 'production'` in others — so unset, 'staging', or a typo'd
 * value silently picked DIFFERENT sides of the gate, and the common
 * "forgot to set NODE_ENV" deployment leaked stacks and SQL text. All
 * verbose-error decisions now flow through this one helper: only the exact
 * value 'development' is verbose; everything else fails closed to masked.
 */

/** True only when explicitly running in development mode. */
export function isVerboseErrors(): boolean {
    return process.env.NODE_ENV === 'development';
}


/**
 * Guidance when NODE_ENV is unset. Returns null when it is set.
 * validateEnv warns, or throws under BUNSANE_STRICT_ENV.
 */
export function nodeEnvUnsetWarning(): string | null {
    if (process.env.NODE_ENV) return null;
    return (
        "NODE_ENV is not set. Fail-closed defaults apply: error details are masked, " +
        "HSTS stays off unless BUNSANE_HSTS=on, and /metrics, /health/remote, /docs, and /openapi.json " +
        "answer 404 unless a token or explicit public opt-in is configured. " +
        "Studio still requires enableStudio({ token }). " +
        "Set NODE_ENV=development for verbose errors, or NODE_ENV=production for a production deploy."
    );
}

