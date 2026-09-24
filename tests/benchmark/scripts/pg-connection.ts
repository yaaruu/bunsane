/**
 * Direct-Postgres connection discovery for the benchmark harness.
 *
 * Mirrors tests/pg-setup.ts: prefer the live Docker port over a stale
 * .env.test pin, and never talk to PgBouncer. This module does not import
 * the framework database singleton.
 */
import { SQL } from "bun";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface PgEndpoints {
    testUrl: URL;
    adminUrl: URL;
    testRole: string;
    directPortSource: string;
}

function loadEnvFile(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key) out[key] = value;
    }
    return out;
}

function fail(msg: string): never {
    console.error(`[pg-connection] ${msg}`);
    process.exit(1);
}

function discoverDockerPort(container: string): string | undefined {
    let out: string;
    try {
        out = execFileSync("docker", ["port", container, "5432"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return undefined;
    }
    for (const line of out.split(/\r?\n/)) {
        const match = /:(\d+)\s*$/.exec(line.trim());
        if (match?.[1]) return match[1];
    }
    return undefined;
}

function dockerEnv(container: string, key: string): string {
    try {
        return execFileSync("docker", ["exec", container, "printenv", key], {
            encoding: "utf8",
        }).trim();
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`docker exec ${container} printenv ${key} failed: ${message}`);
    }
}

export function redactUrl(url: URL): string {
    return `${url.protocol}//${url.username}:****@${url.host}${url.pathname}`;
}

export function resolvePgEndpoints(repoRoot: string): PgEndpoints {
    const envTest = loadEnvFile(join(repoRoot, ".env.test"));
    const cfg = (key: string): string | undefined => process.env[key] ?? envTest[key];

    const fromProcess = process.env.PG_DIRECT_PORT;
    const container = cfg("BUNSANE_PG_DOCKER_CONTAINER");
    const discovered = container ? discoverDockerPort(container) : undefined;
    const pinned = envTest["PG_DIRECT_PORT"];
    let port: string | undefined;
    let directPortSource = "none";
    if (fromProcess) {
        port = fromProcess;
        directPortSource = "PG_DIRECT_PORT env var";
    } else if (discovered) {
        port = discovered;
        directPortSource = `docker port ${container} 5432`;
        if (pinned && pinned !== discovered) {
            console.warn(
                `[pg-connection] .env.test PG_DIRECT_PORT=${pinned} is stale; using ${discovered}.`,
            );
        }
    } else if (pinned) {
        port = pinned;
        directPortSource = ".env.test PG_DIRECT_PORT";
    }

    const explicit = cfg("PG_TEST_URL");
    let testUrl: URL;
    if (explicit) {
        testUrl = new URL(explicit);
    } else {
        const base = cfg("DB_CONNECTION_URL");
        if (!base) fail("No PG_TEST_URL and no DB_CONNECTION_URL to derive from.");
        testUrl = new URL(base);
        if (port) testUrl.port = port;
        else {
            console.warn(
                "[pg-connection] WARNING: no direct port resolved; using DB_CONNECTION_URL port as-is.",
            );
        }
    }

    const explicitAdmin = cfg("PG_ADMIN_URL");
    let adminUrl: URL;
    if (explicitAdmin) {
        adminUrl = new URL(explicitAdmin);
    } else {
        if (!container) {
            fail("No PG_ADMIN_URL and no BUNSANE_PG_DOCKER_CONTAINER.");
        }
        const user = dockerEnv(container, "POSTGRES_USER");
        const pw = dockerEnv(container, "POSTGRES_PASSWORD");
        adminUrl = new URL(testUrl.toString());
        adminUrl.username = encodeURIComponent(user);
        adminUrl.password = encodeURIComponent(pw);
        adminUrl.pathname = "/postgres";
    }

    return {
        testUrl,
        adminUrl,
        testRole: decodeURIComponent(testUrl.username),
        directPortSource,
    };
}

export async function withAdmin<T>(adminUrl: URL, fn: (db: SQL) => Promise<T>): Promise<T> {
    const db = new SQL(adminUrl.toString(), { prepare: true, max: 1, connectionTimeout: 10 });
    try {
        return await fn(db);
    } finally {
        try {
            await db.end();
        } catch {
            /* pool already closed */
        }
    }
}

export function assertDbName(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        fail(`Refusing unsafe database name: ${name}`);
    }
    return name;
}
