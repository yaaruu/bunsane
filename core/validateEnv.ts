import { z } from "zod";
import { nodeEnvUnsetWarning } from "./envMode";

const numeric = (name: string) =>
    z.string().regex(/^\d+$/, `${name} must be numeric`).optional();

const envSchema = z
    .object({
        DB_CONNECTION_URL: z.string().url().optional(),
        POSTGRES_HOST: z.string().optional(),
        POSTGRES_USER: z.string().optional(),
        POSTGRES_PASSWORD: z.string().optional(),
        POSTGRES_DB: z.string().optional(),
        POSTGRES_PORT: numeric("POSTGRES_PORT"),
        POSTGRES_MAX_CONNECTIONS: numeric("POSTGRES_MAX_CONNECTIONS"),

        APP_PORT: numeric("APP_PORT"),
        NODE_ENV: z.enum(["development", "production", "test"]).optional(),

        GRAPHQL_MAX_DEPTH: numeric("GRAPHQL_MAX_DEPTH"),
        GRAPHQL_MAX_COMPLEXITY: numeric("GRAPHQL_MAX_COMPLEXITY"),
        GRAPHQL_INTROSPECTION: z.enum(["on", "off"]).optional(),
        GRAPHQL_GRAPHIQL: z.enum(["on", "off"]).optional(),

        S3_BUCKET: z.string().optional(),
        S3_REGION: z.string().optional(),
        S3_ENDPOINT: z.string().optional(),
        S3_ACCESS_KEY_ID: z.string().optional(),
        S3_SECRET_ACCESS_KEY: z.string().optional(),

        MAX_REQUEST_BODY_SIZE: numeric("MAX_REQUEST_BODY_SIZE"),
        JSON_BODY_LIMIT: numeric("JSON_BODY_LIMIT"),
        MULTIPART_BODY_LIMIT: numeric("MULTIPART_BODY_LIMIT"),
        REQUEST_TIMEOUT_MS: numeric("REQUEST_TIMEOUT_MS"),

        SHUTDOWN_GRACE_PERIOD_MS: numeric("SHUTDOWN_GRACE_PERIOD_MS"),
        DB_STATEMENT_TIMEOUT: numeric("DB_STATEMENT_TIMEOUT"),
        DB_QUERY_TIMEOUT: numeric("DB_QUERY_TIMEOUT"),
        DB_CONNECTION_TIMEOUT: numeric("DB_CONNECTION_TIMEOUT"),
        DB_HEALTH_WRITE_TIMEOUT: numeric("DB_HEALTH_WRITE_TIMEOUT"),
        HEALTH_DB_WRITE_PROBE: z.enum(["true", "false"]).optional(),
        DB_DISABLE_PREPARE: z.enum(["true", "false"]).optional(),

        BUNSANE_QSP: z.enum(["off", "shadow", "route"]).optional(),
        BUNSANE_QSP_PROMOTE_MIN: numeric("BUNSANE_QSP_PROMOTE_MIN"),
        BUNSANE_QSP_COUNT: z.enum(["exact", "n_plus_1", "estimate"]).optional(),
        BUNSANE_QSP_ARCHETYPES: z.string().optional(),
        BUNSANE_QSP_BACKFILL_BATCH: numeric("BUNSANE_QSP_BACKFILL_BATCH"),
        BUNSANE_QSP_BACKFILL_THROTTLE_MS: numeric("BUNSANE_QSP_BACKFILL_THROTTLE_MS"),
        BUNSANE_QSP_ENTITIES_ACCEL: z.enum(["true", "false"]).optional(),

        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
        BUNSANE_LOCK_BACKEND: z.enum(["auto", "in-process", "postgres", "redis", "advisory"]).optional(),
        BUNSANE_STUDIO_TOKEN: z.string().optional(),
        BUNSANE_STUDIO_QUERY: z.enum(["on", "true", "off", "false"]).optional(),
        BUNSANE_METRICS_TOKEN: z.string().optional(),
        BUNSANE_METRICS: z.enum(["public", "off"]).optional(),
        BUNSANE_DOCS_TOKEN: z.string().optional(),
        BUNSANE_DOCS: z.enum(["public", "off"]).optional(),
        BUNSANE_HEALTH_PROBE: z.enum(["read", "write"]).optional(),
        BUNSANE_HEALTH_CACHE_MS: numeric("BUNSANE_HEALTH_CACHE_MS"),
        BUNSANE_HEALTH_MAX_RPS: numeric("BUNSANE_HEALTH_MAX_RPS"),
        BUNSANE_HSTS: z.enum(["on", "off"]).optional(),
        BUNSANE_TLS: z.enum(["on", "off"]).optional(),
        BUNSANE_STRICT_ENV: z.enum(["on", "off", "true", "false"]).optional(),
        BUNSANE_CACHE_INVALIDATION_SECRET: z.string().optional(),
        BUNSANE_RPC_SECRET: z.string().optional(),

        CACHE_PROVIDER: z.enum(["memory", "redis", "multilevel", "noop"]).optional(),
        REDIS_HOST: z.string().optional(),
        REDIS_PORT: numeric("REDIS_PORT"),
        REDIS_PASSWORD: z.string().optional(),
        REDIS_USERNAME: z.string().optional(),
        REDIS_TLS: z.enum(["true", "false"]).optional(),
        REDIS_TLS_SERVERNAME: z.string().optional(),
        REDIS_TLS_REJECT_UNAUTHORIZED: z.enum(["true", "false"]).optional(),
        BUNSANE_RPC_CONSUMER_CONCURRENCY: numeric("BUNSANE_RPC_CONSUMER_CONCURRENCY"),
        BUNSANE_ENTITY_SORT_PROBE: numeric("BUNSANE_ENTITY_SORT_PROBE"),
        BUNSANE_INDEX_SYNC_MAX_ROWS: numeric("BUNSANE_INDEX_SYNC_MAX_ROWS"),
    })
    .refine(
        (env) => {
            const hasUrl = !!env.DB_CONNECTION_URL;
            const hasFields =
                !!env.POSTGRES_HOST && !!env.POSTGRES_USER && !!env.POSTGRES_DB;
            return hasUrl || hasFields;
        },
        {
            message:
                "Database connection required: provide DB_CONNECTION_URL or POSTGRES_HOST + POSTGRES_USER + POSTGRES_DB",
        },
    )
    .refine(
        (env) => {
            if (env.S3_BUCKET) {
                return !!env.S3_ACCESS_KEY_ID && !!env.S3_SECRET_ACCESS_KEY;
            }
            return true;
        },
        {
            message:
                "S3_BUCKET requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or use IAM roles and omit S3_BUCKET from env)",
        },
    )
    .refine(
        (env) => !env.GRAPHQL_MAX_DEPTH || parseInt(env.GRAPHQL_MAX_DEPTH, 10) >= 15,
        { message: "GRAPHQL_MAX_DEPTH must be an integer >= 15 (0 does not disable the limit)" },
    )
    .refine(
        (env) => !env.GRAPHQL_MAX_COMPLEXITY || parseInt(env.GRAPHQL_MAX_COMPLEXITY, 10) >= 1,
        { message: "GRAPHQL_MAX_COMPLEXITY must be an integer >= 1 (0 does not disable the limit)" },
    )
    .refine(
        (env) => !env.BUNSANE_STUDIO_TOKEN || env.BUNSANE_STUDIO_TOKEN.length >= 16,
        { message: "BUNSANE_STUDIO_TOKEN must be at least 16 characters" },
    )
    .refine(
        (env) => !env.BUNSANE_METRICS_TOKEN || env.BUNSANE_METRICS_TOKEN.length >= 16,
        { message: "BUNSANE_METRICS_TOKEN must be at least 16 characters" },
    )
    .refine(
        (env) => !env.BUNSANE_DOCS_TOKEN || env.BUNSANE_DOCS_TOKEN.length >= 16,
        { message: "BUNSANE_DOCS_TOKEN must be at least 16 characters" },
    )
    .refine(
        (env) => !env.BUNSANE_RPC_CONSUMER_CONCURRENCY || parseInt(env.BUNSANE_RPC_CONSUMER_CONCURRENCY, 10) >= 1,
        { message: "BUNSANE_RPC_CONSUMER_CONCURRENCY must be a positive integer (default 8)" },
    )
    .refine(
        (env) => {
            const raw = env.BUNSANE_ENTITY_SORT_PROBE;
            if (!raw) return true;
            const n = Number(raw);
            return Number.isSafeInteger(n) && n >= 1;
        },
        { message: "BUNSANE_ENTITY_SORT_PROBE must be a positive integer (default 5000)" },
    )
    .refine(
        (env) => {
            const raw = env.BUNSANE_INDEX_SYNC_MAX_ROWS;
            if (!raw) return true;
            const n = Number(raw);
            return Number.isSafeInteger(n) && n >= 0;
        },
        { message: "BUNSANE_INDEX_SYNC_MAX_ROWS must be a non-negative integer (default 100000)" },
    );

function isLoopbackOrLinkLocal(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
    if (h.startsWith("127.")) return true;
    if (h.startsWith("fe80:")) return true;
    if (h.startsWith("169.254.")) return true;
    return false;
}

/** Soft security warnings. STRICT_ENV promotes these to a boot failure. */
export function envSecurityWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
    const warnings: string[] = [];
    const nodeEnv = nodeEnvUnsetWarning();
    if (nodeEnv) warnings.push(nodeEnv);

    const provider = env.CACHE_PROVIDER;
    const redisHost = env.REDIS_HOST || "localhost";
    if ((provider === "redis" || provider === "multilevel") && env.NODE_ENV === "production") {
        if (!env.REDIS_PASSWORD && !isLoopbackOrLinkLocal(redisHost)) {
            warnings.push(
                `CACHE_PROVIDER=${provider} in production with empty REDIS_PASSWORD and non-loopback REDIS_HOST=${redisHost}. ` +
                "Set REDIS_PASSWORD or bind Redis to loopback.",
            );
        }
    }
    // Same host default as buildRedisConnectionOptions. Unset REDIS_HOST is
    // localhost, so a deploy that never points at Redis does not warn.
    if (env.NODE_ENV === "production" && !isLoopbackOrLinkLocal(redisHost) && env.REDIS_TLS !== "true") {
        warnings.push(
            `Production non-loopback REDIS_HOST=${redisHost} has REDIS_TLS unset or false. ` +
            "The Redis client will connect without TLS. Set REDIS_TLS=true, or bind Redis to loopback.",
        );
    }
    return warnings;
}

function strictEnv(env: NodeJS.ProcessEnv): boolean {
    return env.BUNSANE_STRICT_ENV === "on" || env.BUNSANE_STRICT_ENV === "true";
}

export function validateEnv(): void {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        const messages = result.error.issues.map(
            (issue) =>
                `  - ${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`,
        );
        throw new Error(
            `Environment validation failed:\n${messages.join("\n")}`,
        );
    }

    const warnings = envSecurityWarnings(process.env);
    if (warnings.length === 0) return;
    if (strictEnv(process.env)) {
        throw new Error(
            `Environment validation failed (BUNSANE_STRICT_ENV):\n${warnings.map((w) => `  - ${w}`).join("\n")}`,
        );
    }
    for (const warning of warnings) {
        console.warn(`[BunSane] ${warning}`);
    }
}
