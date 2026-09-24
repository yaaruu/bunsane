import { describe, test, expect } from "bun:test";
import {
    buildRedisConnectionOptions,
    remoteRedisClientOptions,
} from "../../core/redisOptions";
import { redisCacheClientOptions } from "../../core/cache/RedisCache";
import { envSecurityWarnings, validateEnv } from "../../core/validateEnv";

const cacheConfig = { host: "127.0.0.1", port: 6379 };

describe("buildRedisConnectionOptions", () => {
    test("REDIS_TLS=true yields tls: {} and false or unset yields none", () => {
        expect(buildRedisConnectionOptions({ REDIS_TLS: "true" }).tls).toEqual({});
        expect(buildRedisConnectionOptions({ REDIS_TLS: "false" }).tls).toBeUndefined();
        expect(buildRedisConnectionOptions({}).tls).toBeUndefined();
    });

    test("optional TLS servername and rejectUnauthorized are applied only when TLS is on", () => {
        expect(buildRedisConnectionOptions({
            REDIS_TLS: "true",
            REDIS_TLS_SERVERNAME: "redis.example",
        }).tls).toEqual({ servername: "redis.example" });

        expect(buildRedisConnectionOptions({
            REDIS_TLS: "true",
            REDIS_TLS_REJECT_UNAUTHORIZED: "false",
        }).tls).toEqual({ rejectUnauthorized: false });

        expect(buildRedisConnectionOptions({
            REDIS_TLS: "true",
            REDIS_TLS_REJECT_UNAUTHORIZED: "true",
        }).tls).toEqual({ rejectUnauthorized: true });

        expect(buildRedisConnectionOptions({
            REDIS_TLS: "true",
            REDIS_TLS_SERVERNAME: "redis.example",
            REDIS_TLS_REJECT_UNAUTHORIZED: "false",
        }).tls).toEqual({ servername: "redis.example", rejectUnauthorized: false });

        expect(buildRedisConnectionOptions({
            REDIS_TLS: "false",
            REDIS_TLS_SERVERNAME: "redis.example",
            REDIS_TLS_REJECT_UNAUTHORIZED: "false",
        }).tls).toBeUndefined();
    });

    test("explicit overrides win over REDIS_* including tls: false", () => {
        const options = buildRedisConnectionOptions(
            {
                REDIS_HOST: "env-host",
                REDIS_PORT: "6380",
                REDIS_PASSWORD: "env-secret",
                REDIS_USERNAME: "env-user",
                REDIS_DB: "2",
                REDIS_TLS: "true",
                REDIS_TLS_SERVERNAME: "env.example",
            },
            {
                host: "10.0.0.8",
                port: 6390,
                password: "app-secret",
                username: "app-user",
                db: 4,
                tls: { servername: "app.example" },
            },
        );
        expect(options).toMatchObject({
            host: "10.0.0.8",
            port: 6390,
            password: "app-secret",
            username: "app-user",
            db: 4,
            tls: { servername: "app.example" },
        });

        expect(buildRedisConnectionOptions(
            { REDIS_TLS: "true", REDIS_PASSWORD: "env-secret" },
            { tls: false, password: undefined },
        ).tls).toBeUndefined();
        expect(buildRedisConnectionOptions(
            { REDIS_TLS: "true", REDIS_PASSWORD: "env-secret" },
            { tls: false, password: undefined },
        ).password).toBeUndefined();
    });

    test("reads host, port, password, username, and db from env when not overridden", () => {
        expect(buildRedisConnectionOptions({
            REDIS_HOST: "redis.internal",
            REDIS_PORT: "6380",
            REDIS_PASSWORD: "s3cret",
            REDIS_USERNAME: "app",
            REDIS_DB: "3",
        })).toMatchObject({
            host: "redis.internal",
            port: 6380,
            password: "s3cret",
            username: "app",
            db: 3,
        });
        expect(buildRedisConnectionOptions({})).toMatchObject({
            host: "localhost",
            port: 6379,
            db: 0,
        });
    });

    test("keyPrefix is omitted unless requested, then env or override applies", () => {
        expect(buildRedisConnectionOptions({ REDIS_KEY_PREFIX: "myapp:" }).keyPrefix).toBeUndefined();
        expect(buildRedisConnectionOptions(
            { REDIS_KEY_PREFIX: "myapp:" },
            {},
            { includeKeyPrefix: true },
        ).keyPrefix).toBe("myapp:");
        expect(buildRedisConnectionOptions(
            { REDIS_KEY_PREFIX: "myapp:" },
            { keyPrefix: "custom:" },
        ).keyPrefix).toBe("custom:");
    });
});

describe("client options use the shared builder", () => {
    test("cache and remote carry the builder TLS decision", () => {
        const env = {
            REDIS_TLS: "true",
            REDIS_HOST: "redis.internal",
            REDIS_PORT: "6380",
            REDIS_PASSWORD: "s3cret",
            REDIS_USERNAME: "app",
            REDIS_KEY_PREFIX: "myapp:",
        };
        const shared = buildRedisConnectionOptions(env);
        const cache = redisCacheClientOptions(cacheConfig, env);
        const publisher = remoteRedisClientOptions(false, env);
        const blocking = remoteRedisClientOptions(true, env);

        expect(shared.tls).toEqual({});
        if (shared.tls === undefined) throw new Error("REDIS_TLS=true did not set tls");
        expect(cache.tls).toEqual(shared.tls);
        expect(publisher.tls).toEqual(shared.tls);
        expect(blocking.tls).toEqual(shared.tls);

        // Explicit cache config wins; remote follows env. Neither sets ioredis keyPrefix.
        expect(cache.host).toBe("127.0.0.1");
        expect(cache.port).toBe(6379);
        expect(cache.password).toBeUndefined();
        expect(cache.username).toBe("app");
        expect(cache.keyPrefix).toBeUndefined();
        expect(publisher.host).toBe("redis.internal");
        expect(publisher.port).toBe(6380);
        expect(publisher.password).toBe("s3cret");
        expect(publisher.username).toBe("app");
        expect(publisher.keyPrefix).toBeUndefined();
        expect(blocking.keyPrefix).toBeUndefined();
    });

    test("REDIS_TLS=false leaves both clients without tls", () => {
        const env = { REDIS_TLS: "false", REDIS_HOST: "redis.internal" };
        expect(redisCacheClientOptions(cacheConfig, env).tls).toBeUndefined();
        expect(remoteRedisClientOptions(false, env).tls).toBeUndefined();
        expect(remoteRedisClientOptions(true, env).tls).toBeUndefined();
    });

    test("cache tls: false and a tls object beat REDIS_TLS", () => {
        const env = {
            REDIS_TLS: "true",
            REDIS_TLS_SERVERNAME: "env.example",
            REDIS_HOST: "env-host",
        };
        expect(redisCacheClientOptions({ ...cacheConfig, tls: false }, env).tls).toBeUndefined();
        expect(redisCacheClientOptions(
            { ...cacheConfig, tls: { servername: "cache.internal" } },
            env,
        ).tls).toEqual({ servername: "cache.internal" });
        expect(redisCacheClientOptions(
            { host: "10.1.1.1", port: 6391, password: "cache-secret", username: "cache-user", db: 5 },
            { REDIS_HOST: "env-host", REDIS_PASSWORD: "env-secret", REDIS_USERNAME: "env-user", REDIS_DB: "1" },
        )).toMatchObject({
            host: "10.1.1.1",
            port: 6391,
            password: "cache-secret",
            username: "cache-user",
            db: 5,
        });
    });

    test("remote keeps blocking-specific options and does not apply keyPrefix", () => {
        const env = { REDIS_TLS: "true", REDIS_KEY_PREFIX: "myapp:" };
        const publisher = remoteRedisClientOptions(false, env);
        const blocking = remoteRedisClientOptions(true, env);
        expect(publisher.maxRetriesPerRequest).toBe(3);
        expect(blocking.maxRetriesPerRequest).toBeNull();
        expect(publisher.enableReadyCheck).toBe(false);
        expect(blocking.enableReadyCheck).toBe(false);
        expect(publisher.retryStrategy?.(1)).toBe(50);
        expect(publisher.retryStrategy?.(100)).toBe(2000);
        expect(publisher.keyPrefix).toBeUndefined();
    });

    test("cache keeps fail-fast reconnect defaults alongside env TLS", () => {
        const options = redisCacheClientOptions(
            { ...cacheConfig, maxReconnectAttempts: 2 },
            { REDIS_TLS: "true" },
        );
        expect(options.tls).toEqual({});
        expect(options.enableOfflineQueue).toBe(false);
        expect(options.connectTimeout).toBe(5000);
        expect(options.commandTimeout).toBe(3000);
        expect(options.maxRetriesPerRequest).toBe(3);
        expect(options.retryStrategy?.(1)).toBe(200);
        expect(options.retryStrategy?.(3)).toBeNull();
    });
});

describe("envSecurityWarnings REDIS_TLS", () => {
    test("production non-loopback with TLS unset or false warns", () => {
        for (const tls of [undefined, "false"] as const) {
            const warnings = envSecurityWarnings({
                NODE_ENV: "production",
                REDIS_HOST: "redis.internal",
                REDIS_TLS: tls,
            });
            expect(warnings.join("\n")).toContain("REDIS_TLS unset or false");
            expect(warnings.join("\n")).toContain("redis.internal");
        }
    });

    test("does not warn for loopback, non-production, or REDIS_TLS=true", () => {
        const quiet = [
            { NODE_ENV: "production", REDIS_HOST: "127.0.0.1", REDIS_TLS: "false" },
            { NODE_ENV: "production", REDIS_HOST: "localhost" },
            { NODE_ENV: "production", REDIS_HOST: "169.254.1.1", REDIS_TLS: "false" },
            { NODE_ENV: "production" },
            { NODE_ENV: "development", REDIS_HOST: "redis.internal" },
            { NODE_ENV: "production", REDIS_HOST: "redis.internal", REDIS_TLS: "true" },
        ];
        for (const env of quiet) {
            const text = envSecurityWarnings(env).join("\n");
            expect(text).not.toContain("REDIS_TLS unset or false");
            expect(text).not.toContain("not applied");
        }
    });

    test("password warning no longer claims TLS is unused", () => {
        const text = envSecurityWarnings({
            NODE_ENV: "production",
            CACHE_PROVIDER: "redis",
            REDIS_HOST: "redis.internal",
            REDIS_PASSWORD: "",
            REDIS_TLS: "true",
        }).join("\n");
        expect(text).toContain("REDIS_PASSWORD");
        expect(text).not.toContain("not applied");
        expect(text).not.toContain("REDIS_TLS unset or false");
    });

    test("plaintext warning is independent of CACHE_PROVIDER", () => {
        const text = envSecurityWarnings({
            NODE_ENV: "production",
            CACHE_PROVIDER: "memory",
            REDIS_HOST: "redis.internal",
        }).join("\n");
        expect(text).toContain("REDIS_TLS unset or false");
        expect(text).not.toContain("REDIS_PASSWORD");
    });
});

describe("validateEnv REDIS_TLS", () => {
    test("rejects invalid values and STRICT_ENV fails closed on plaintext production Redis", () => {
        const saved = { ...process.env };
        try {
            process.env.DB_CONNECTION_URL = "postgres://user:pass@localhost:5432/db";
            process.env.NODE_ENV = "test";
            process.env.REDIS_TLS = "yes";
            delete process.env.BUNSANE_STRICT_ENV;
            expect(() => validateEnv()).toThrow(/REDIS_TLS/);

            process.env.REDIS_TLS = "true";
            process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "no";
            expect(() => validateEnv()).toThrow(/REDIS_TLS_REJECT_UNAUTHORIZED/);

            delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
            process.env.NODE_ENV = "production";
            process.env.REDIS_HOST = "redis.internal";
            process.env.REDIS_TLS = "false";
            delete process.env.CACHE_PROVIDER;
            delete process.env.BUNSANE_STRICT_ENV;
            expect(() => validateEnv()).not.toThrow();

            process.env.BUNSANE_STRICT_ENV = "on";
            expect(() => validateEnv()).toThrow(/BUNSANE_STRICT_ENV/);
            expect(() => validateEnv()).toThrow(/REDIS_TLS unset or false/);
        } finally {
            process.env = saved;
        }
    });
});
