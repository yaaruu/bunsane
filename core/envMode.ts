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

let warnedNodeEnvUnset = false;

/**
 * One-time boot warning when NODE_ENV is unset — it drives error masking,
 * the studio surface and HSTS, so its absence is security-relevant.
 * Called from validateEnv().
 */
export function warnIfNodeEnvUnset(): void {
    if (warnedNodeEnvUnset) return;
    if (!process.env.NODE_ENV) {
        warnedNodeEnvUnset = true;
        console.warn(
            '[BunSane] NODE_ENV is not set. Defaulting to fail-closed behaviour: ' +
            'error details are masked and production-only surfaces stay off. ' +
            'Set NODE_ENV=development for verbose errors.'
        );
    }
}
