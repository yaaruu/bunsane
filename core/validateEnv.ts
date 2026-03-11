import { z } from "zod";

const envSchema = z
    .object({
        // DB connection: either URL or individual fields
        DB_CONNECTION_URL: z.string().url().optional(),
        POSTGRES_HOST: z.string().optional(),
        POSTGRES_USER: z.string().optional(),
        POSTGRES_PASSWORD: z.string().optional(),
        POSTGRES_DB: z.string().optional(),
        POSTGRES_PORT: z
            .string()
            .regex(/^\d+$/, "POSTGRES_PORT must be numeric")
            .optional(),
        POSTGRES_MAX_CONNECTIONS: z
            .string()
            .regex(/^\d+$/, "POSTGRES_MAX_CONNECTIONS must be numeric")
            .optional(),

        // App config
        APP_PORT: z
            .string()
            .regex(/^\d+$/, "APP_PORT must be numeric")
            .optional(),
        NODE_ENV: z.enum(["development", "production", "test"]).optional(),

        // GraphQL
        GRAPHQL_MAX_DEPTH: z
            .string()
            .regex(/^\d+$/, "GRAPHQL_MAX_DEPTH must be numeric")
            .optional(),

        // S3 Storage (opt-in)
        S3_BUCKET: z.string().optional(),
        S3_REGION: z.string().optional(),
        S3_ENDPOINT: z.string().optional(),
        S3_ACCESS_KEY_ID: z.string().optional(),
        S3_SECRET_ACCESS_KEY: z.string().optional(),

        // HTTP
        MAX_REQUEST_BODY_SIZE: z
            .string()
            .regex(/^\d+$/, "MAX_REQUEST_BODY_SIZE must be numeric")
            .optional(),

        // Operational
        SHUTDOWN_GRACE_PERIOD_MS: z
            .string()
            .regex(/^\d+$/, "SHUTDOWN_GRACE_PERIOD_MS must be numeric")
            .optional(),
        DB_STATEMENT_TIMEOUT: z
            .string()
            .regex(/^\d+$/, "DB_STATEMENT_TIMEOUT must be numeric")
            .optional(),
        DB_QUERY_TIMEOUT: z
            .string()
            .regex(/^\d+$/, "DB_QUERY_TIMEOUT must be numeric (milliseconds)")
            .optional(),
        DB_CONNECTION_TIMEOUT: z
            .string()
            .regex(/^\d+$/, "DB_CONNECTION_TIMEOUT must be numeric (seconds)")
            .optional(),
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
    );

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
}
