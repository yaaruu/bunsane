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

        // Operational
        SHUTDOWN_GRACE_PERIOD_MS: z
            .string()
            .regex(/^\d+$/, "SHUTDOWN_GRACE_PERIOD_MS must be numeric")
            .optional(),
        DB_STATEMENT_TIMEOUT: z
            .string()
            .regex(/^\d+$/, "DB_STATEMENT_TIMEOUT must be numeric")
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
