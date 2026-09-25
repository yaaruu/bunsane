import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateEnv } from "../../core/validateEnv";

describe("validateEnv", () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        savedEnv = { ...process.env };
        // Clear all DB-related env vars
        delete process.env.DB_CONNECTION_URL;
        delete process.env.POSTGRES_HOST;
        delete process.env.POSTGRES_USER;
        delete process.env.POSTGRES_PASSWORD;
        delete process.env.POSTGRES_DB;
        delete process.env.POSTGRES_PORT;
        delete process.env.POSTGRES_MAX_CONNECTIONS;
        delete process.env.APP_PORT;
        delete process.env.NODE_ENV;
        delete process.env.GRAPHQL_MAX_DEPTH;
    });

    afterEach(() => {
        process.env = savedEnv;
    });

    test("passes with DB_CONNECTION_URL", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        expect(() => validateEnv()).not.toThrow();
    });

    test("passes with POSTGRES_HOST + POSTGRES_USER + POSTGRES_DB", () => {
        process.env.POSTGRES_HOST = "localhost";
        process.env.POSTGRES_USER = "user";
        process.env.POSTGRES_DB = "testdb";
        expect(() => validateEnv()).not.toThrow();
    });

    test("throws when neither DB connection method provided", () => {
        expect(() => validateEnv()).toThrow("Database connection required");
    });

    test("throws for non-numeric APP_PORT", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        process.env.APP_PORT = "abc";
        expect(() => validateEnv()).toThrow("APP_PORT must be numeric");
    });

    test("throws for invalid NODE_ENV", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        process.env.NODE_ENV = "staging";
        expect(() => validateEnv()).toThrow("Environment validation failed");
    });

    test("passes when optional vars omitted", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        // No APP_PORT, NODE_ENV, POSTGRES_PORT, POSTGRES_MAX_CONNECTIONS
        expect(() => validateEnv()).not.toThrow();
    });

    test("throws for non-numeric POSTGRES_PORT", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        process.env.POSTGRES_PORT = "not-a-number";
        expect(() => validateEnv()).toThrow("POSTGRES_PORT must be numeric");
    });

    test("throws for non-numeric POSTGRES_MAX_CONNECTIONS", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        process.env.POSTGRES_MAX_CONNECTIONS = "many";
        expect(() => validateEnv()).toThrow(
            "POSTGRES_MAX_CONNECTIONS must be numeric",
        );
    });

    test("passes with valid optional numeric fields", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        process.env.APP_PORT = "3000";
        process.env.POSTGRES_PORT = "5432";
        process.env.POSTGRES_MAX_CONNECTIONS = "20";
        process.env.GRAPHQL_MAX_DEPTH = "15";
        expect(() => validateEnv()).not.toThrow();
    });

    test("BUNSANE_ENTITY_SORT_PROBE must be a positive integer", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        delete process.env.BUNSANE_ENTITY_SORT_PROBE;
        expect(() => validateEnv()).not.toThrow();
        process.env.BUNSANE_ENTITY_SORT_PROBE = "5000";
        expect(() => validateEnv()).not.toThrow();
        process.env.BUNSANE_ENTITY_SORT_PROBE = "0";
        expect(() => validateEnv()).toThrow(/BUNSANE_ENTITY_SORT_PROBE/);
        process.env.BUNSANE_ENTITY_SORT_PROBE = "nope";
        expect(() => validateEnv()).toThrow(/BUNSANE_ENTITY_SORT_PROBE/);
    });

    test("BUNSANE_INDEX_SYNC_MAX_ROWS must be a non-negative integer", () => {
        process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
        delete process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
        expect(() => validateEnv()).not.toThrow();
        process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = "0";
        expect(() => validateEnv()).not.toThrow();
        process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = "100000";
        expect(() => validateEnv()).not.toThrow();
        process.env.BUNSANE_INDEX_SYNC_MAX_ROWS = "100k";
        expect(() => validateEnv()).toThrow(/BUNSANE_INDEX_SYNC_MAX_ROWS/);
        delete process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
    });
});
