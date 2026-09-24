/** Wall-clock request timeout. 0 disables. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** JSON and other non-multipart bodies. SEC-14. */
export const DEFAULT_JSON_BODY_LIMIT = 1 * 1024 * 1024;

/** Absolute Bun.serve cap and default multipart cap. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 50 * 1024 * 1024;

/** GraphQL depth floor. 0 does not disable. */
export const GRAPHQL_MIN_DEPTH = 15;

/** GraphQL complexity floor. 0 does not disable. */
export const GRAPHQL_MIN_COMPLEXITY = 1;

export const DEFAULT_GRAPHQL_MAX_COMPLEXITY = 1000;

export type InfoAccess = {
    token: string | null;
    /** Explicit opt-in to serve the surface without a token. */
    public: boolean;
};

export const CLOSED_INFO_ACCESS: InfoAccess = { token: null, public: false };

export function assertGraphQLDepth(depth: number): number {
    if (!Number.isInteger(depth) || depth < GRAPHQL_MIN_DEPTH) {
        throw new Error(
            `GraphQL max depth must be an integer >= ${GRAPHQL_MIN_DEPTH} (got ${depth}). ` +
            "0 does not disable the limit.",
        );
    }
    return depth;
}

export function assertGraphQLComplexity(complexity: number): number {
    if (!Number.isInteger(complexity) || complexity < GRAPHQL_MIN_COMPLEXITY) {
        throw new Error(
            `GraphQL max complexity must be an integer >= ${GRAPHQL_MIN_COMPLEXITY} (got ${complexity}). ` +
            "0 does not disable the limit.",
        );
    }
    return complexity;
}

export function assertNonNegativeMs(name: string, ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`${name} must be a non-negative number of milliseconds (0 disables where documented); got ${ms}`);
    }
    return ms;
}
