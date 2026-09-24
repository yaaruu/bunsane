/**
 * Shared ioredis connection defaults for cache and remote clients.
 *
 * REDIS_* env builds the defaults. A key present on `overrides` wins even
 * when the value is undefined, so an explicit config object does not pick
 * up a sibling env value. Omit `tls` to follow REDIS_TLS; pass `false` for
 * plaintext; pass a ConnectionOptions object to replace the env TLS options.
 *
 * keyPrefix is not applied unless requested. RedisCache prefixes keys itself
 * (ioredis keyPrefix would double-prefix). Remote stream names must not pick
 * up REDIS_KEY_PREFIX.
 *
 * There is no REDIS_URL-style variable in this codebase, so rediss:// is not
 * parsed here. TLS is REDIS_TLS=true → `tls: {}`.
 */
import type { RedisOptions } from "ioredis";

export type RedisTlsOptions = NonNullable<RedisOptions["tls"]>;

export interface RedisConnectionOverrides {
    host?: string;
    port?: number;
    password?: string;
    username?: string;
    db?: number;
    /** ioredis keyPrefix. Applied only when this key is set or includeKeyPrefix is true. */
    keyPrefix?: string;
    /**
     * `false` forces plaintext. An object is passed through as ioredis `tls`.
     * Omit the key to use REDIS_TLS.
     */
    tls?: RedisTlsOptions | false;
}

export interface BuildRedisConnectionOptions {
    /**
     * When true, set ioredis `keyPrefix` from the override or REDIS_KEY_PREFIX.
     * Default false — see module comment.
     */
    includeKeyPrefix?: boolean;
}

function hasOverride(
    overrides: RedisConnectionOverrides,
    key: keyof RedisConnectionOverrides,
): boolean {
    return Object.prototype.hasOwnProperty.call(overrides, key);
}

/**
 * TLS options from env. `undefined` means plaintext.
 * REDIS_TLS=true with no extras is exactly `{}` so Node's default
 * `rejectUnauthorized: true` applies. REDIS_TLS_REJECT_UNAUTHORIZED=false
 * is the only way to disable verification.
 */
export function redisTlsFromEnv(env: NodeJS.ProcessEnv = process.env): RedisTlsOptions | undefined {
    if (env.REDIS_TLS !== "true") return undefined;
    const tls: RedisTlsOptions = {};
    if (env.REDIS_TLS_SERVERNAME) tls.servername = env.REDIS_TLS_SERVERNAME;
    if (env.REDIS_TLS_REJECT_UNAUTHORIZED === "false") {
        tls.rejectUnauthorized = false;
    } else if (env.REDIS_TLS_REJECT_UNAUTHORIZED === "true") {
        tls.rejectUnauthorized = true;
    }
    return tls;
}

export function buildRedisConnectionOptions(
    env: NodeJS.ProcessEnv = process.env,
    overrides: RedisConnectionOverrides = {},
    build: BuildRedisConnectionOptions = {},
): RedisOptions {
    const host = hasOverride(overrides, "host")
        ? (overrides.host ?? "")
        : (env.REDIS_HOST || "localhost");
    const port = hasOverride(overrides, "port")
        ? (overrides.port ?? 0)
        : parseInt(env.REDIS_PORT || "6379", 10);
    const db = hasOverride(overrides, "db")
        ? (overrides.db ?? 0)
        : parseInt(env.REDIS_DB || "0", 10);

    const options: RedisOptions = { host, port, db };

    if (hasOverride(overrides, "password")) {
        if (overrides.password !== undefined) options.password = overrides.password;
    } else if (env.REDIS_PASSWORD !== undefined) {
        options.password = env.REDIS_PASSWORD;
    }

    if (hasOverride(overrides, "username")) {
        if (overrides.username) options.username = overrides.username;
    } else if (env.REDIS_USERNAME) {
        options.username = env.REDIS_USERNAME;
    }

    const includeKeyPrefix = build.includeKeyPrefix === true || hasOverride(overrides, "keyPrefix");
    if (includeKeyPrefix) {
        const prefix = hasOverride(overrides, "keyPrefix")
            ? overrides.keyPrefix
            : env.REDIS_KEY_PREFIX;
        if (prefix) options.keyPrefix = prefix;
    }

    if (hasOverride(overrides, "tls")) {
        if (overrides.tls) options.tls = overrides.tls;
    } else {
        const tls = redisTlsFromEnv(env);
        if (tls) options.tls = tls;
    }

    return options;
}

/**
 * Options the remote publisher (`blocking` false) and blocking consumers
 * pass to `new Redis` when no `redisFactory` was supplied.
 * A caller-supplied redisFactory replaces this entirely.
 */
export function remoteRedisClientOptions(
    blocking: boolean,
    env: NodeJS.ProcessEnv = process.env,
): RedisOptions {
    return {
        ...buildRedisConnectionOptions(env),
        maxRetriesPerRequest: blocking ? null : 3,
        enableReadyCheck: false,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
    };
}
