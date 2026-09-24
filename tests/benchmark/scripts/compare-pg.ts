#!/usr/bin/env bun
/**
 * Real-PostgreSQL before/after comparison for the 0.7 read path.
 *
 * Provisions a scratch database per tree, runs tests/benchmark/scripts/pg-scenario.ts
 * inside that tree (so each commit's Query/GraphQL code is what executes), then
 * drops the database.
 *
 *   bun tests/benchmark/scripts/compare-pg.ts
 *   bun tests/benchmark/scripts/compare-pg.ts --scale smoke
 *   bun tests/benchmark/scripts/compare-pg.ts --self --label head
 *   bun tests/benchmark/scripts/compare-pg.ts --gate
 *   bun tests/benchmark/scripts/compare-pg.ts --write-baseline
 *
 * Default trees, when present:
 *   ../bunsane-wt-base  (label base)
 *   ../bunsane-wt-head  (label head)
 *
 * Trees run one at a time. Overlapping timed runs on one host are not comparable.
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
    assertDbName,
    redactUrl,
    resolvePgEndpoints,
    withAdmin,
} from "./pg-connection";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "tests", "benchmark", "results");
const BASELINE_PATH = join(REPO_ROOT, "tests", "benchmark", "baseline", "md-pg.json");

interface TreeSpec {
    label: string;
    path: string;
}

interface ShapeResult {
    name: string;
    skipped?: string;
    iterations: number;
    warmup: number;
    rowsReturned: number;
    p50Ms: number;
    p95Ms: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    statementsPerIter: number;
    sql?: string;
    explain?: string;
    error?: string;
}

interface TreeResult {
    label: string;
    commit: string;
    packageVersion: string;
    scale: string;
    dataset: Record<string, number>;
    seedMs: number;
    pgVersion: string;
    bunVersion: string;
    platform: string;
    cpu: string;
    memoryGb: number;
    shapes: ShapeResult[];
}

function argValue(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function defaultTrees(): TreeSpec[] {
    const parent = dirname(REPO_ROOT);
    const specs: TreeSpec[] = [];
    const base = join(parent, "bunsane-wt-base");
    const head = join(parent, "bunsane-wt-head");
    if (existsSync(base)) specs.push({ label: "base", path: base });
    if (existsSync(head)) specs.push({ label: "head", path: head });
    return specs;
}

function parseTrees(): TreeSpec[] {
    if (hasFlag("--self")) {
        return [{ label: argValue("--label") ?? "self", path: REPO_ROOT }];
    }
    const trees = defaultTrees();
    const only = argValue("--only");
    if (only) {
        const picked = trees.filter((tree) => tree.label === only);
        if (picked.length === 0) {
            console.error(`[compare-pg] --only ${only} did not match a default worktree`);
            process.exit(1);
        }
        return picked;
    }
    if (trees.length === 0) return [{ label: "self", path: REPO_ROOT }];
    return trees;
}

async function gitCommit(cwd: string): Promise<string> {
    return await new Promise((resolvePromise, reject) => {
        const proc = spawn("git", ["rev-parse", "HEAD"], { cwd });
        let out = "";
        proc.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString();
        });
        proc.on("exit", (code) => {
            if (code === 0) resolvePromise(out.trim());
            else reject(new Error(`git rev-parse failed in ${cwd} (${code})`));
        });
    });
}

async function createScratch(name: string, adminUrl: URL, testRole: string): Promise<void> {
    await withAdmin(adminUrl, async (db) => {
        await db.unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [name],
        );
        await db.unsafe(`DROP DATABASE IF EXISTS ${name}`);
        await db.unsafe(`CREATE DATABASE ${name} OWNER ${testRole}`);
    });
}

async function dropScratch(name: string, adminUrl: URL): Promise<void> {
    try {
        await withAdmin(adminUrl, async (db) => {
            await db.unsafe(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [name],
            );
            await db.unsafe(`DROP DATABASE IF EXISTS ${name}`);
        });
        console.log(`[compare-pg] Dropped ${name}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[compare-pg] Failed to drop ${name}: ${message}`);
    }
}

function childEnv(scratchUrl: URL, scratchName: string, outPath: string, scale: string, label: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DB_CONNECTION_URL: scratchUrl.toString(),
        POSTGRES_HOST: scratchUrl.hostname,
        POSTGRES_PORT: scratchUrl.port || "5432",
        POSTGRES_USER: decodeURIComponent(scratchUrl.username),
        POSTGRES_PASSWORD: decodeURIComponent(scratchUrl.password),
        POSTGRES_DB: scratchName,
        POSTGRES_MAX_CONNECTIONS: "8",
        DB_QUERY_TIMEOUT: "120000",
        BENCH_OUT: outPath,
        BENCH_SCALE: scale,
        BENCH_LABEL: label,
        BENCH_ITERATIONS: argValue("--iterations") ?? process.env.BENCH_ITERATIONS ?? "30",
        BENCH_WARMUP: argValue("--warmup") ?? process.env.BENCH_WARMUP ?? "5",
        LOG_LEVEL: "warn",
        NODE_ENV: "production",
        CACHE_ENABLED: "false",
    };
    delete env.DB_DISABLE_PREPARE;
    delete env.USE_PGLITE;
    delete env.BUNSANE_QSP;
    delete env.BUNSANE_USE_DIRECT_PARTITION;
    delete env.BUNSANE_MEMBERSHIP_SOURCE;
    return env;
}

async function runTree(
    tree: TreeSpec,
    scratchUrl: URL,
    scratchName: string,
    scale: string,
): Promise<TreeResult> {
    const scenarioSrc = join(__dirname, "pg-scenario.ts");
    const scenarioDest = join(tree.path, "tests", "benchmark", "scripts", "pg-scenario.ts");
    const body = readFileSync(scenarioSrc, "utf8");
    mkdirSync(dirname(scenarioDest), { recursive: true });
    writeFileSync(scenarioDest, body);

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `pg-${tree.label}.json`);
    if (existsSync(outPath)) {
        writeFileSync(outPath, "");
    }

    const code = await new Promise<number>((resolvePromise, reject) => {
        const proc = spawn("bun", ["tests/benchmark/scripts/pg-scenario.ts"], {
            cwd: tree.path,
            env: childEnv(scratchUrl, scratchName, outPath, scale, tree.label),
            stdio: "inherit",
        });
        proc.on("error", reject);
        proc.on("exit", (exitCode) => resolvePromise(exitCode ?? 1));
    });
    if (code !== 0) {
        throw new Error(`${tree.label} scenario exited ${code}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(outPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("shapes" in parsed)) {
        throw new Error(`${tree.label} did not write a result object`);
    }
    return parsed as TreeResult;
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}

function printTable(results: TreeResult[]): void {
    const byLabel = new Map(results.map((r) => [r.label, r]));
    const base = byLabel.get("base");
    const head = byLabel.get("head") ?? results[results.length - 1];
    if (!head) return;
    const names = head.shapes.map((s) => s.name);
    console.log("\nshape                          base p50   head p50   delta%   base p95   head p95   stmts b/h");
    for (const name of names) {
        const h = head.shapes.find((s) => s.name === name);
        const b = base?.shapes.find((s) => s.name === name);
        const hp = h?.skipped ? "skip" : h ? h.p50Ms.toFixed(2) : "-";
        const bp = b?.skipped ? "skip" : b ? b.p50Ms.toFixed(2) : "-";
        let delta = "-";
        if (b && h && !b.skipped && !h.skipped && b.p50Ms > 0) {
            delta = (((h.p50Ms - b.p50Ms) / b.p50Ms) * 100).toFixed(1);
        }
        const bp95 = b && !b.skipped ? b.p95Ms.toFixed(2) : "-";
        const hp95 = h && !h.skipped ? h.p95Ms.toFixed(2) : "-";
        const stmts = `${b ? round(b.statementsPerIter) : "-"}/${h ? round(h.statementsPerIter) : "-"}`;
        console.log(
            `${name.padEnd(30)} ${String(bp).padStart(9)} ${String(hp).padStart(10)} ${delta.padStart(8)} ${String(bp95).padStart(10)} ${String(hp95).padStart(10)} ${stmts}`,
        );
    }
}

interface BaselineFile {
    capturedAt: string;
    sourceCommit: string;
    shapes: Record<string, { p50Ms: number; p95Ms: number; meanMs: number }>;
}

function writeBaseline(result: TreeResult): void {
    const shapes: BaselineFile["shapes"] = {};
    for (const shape of result.shapes) {
        if (shape.skipped || shape.error) continue;
        shapes[shape.name] = { p50Ms: shape.p50Ms, p95Ms: shape.p95Ms, meanMs: shape.meanMs };
    }
    const file: BaselineFile = {
        capturedAt: new Date().toISOString(),
        sourceCommit: result.commit,
        shapes,
    };
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2));
    console.log(`[compare-pg] Wrote ${BASELINE_PATH}`);
}

/**
 * Same-commit repeats on real PG drift up to ~23% p50 (+1.6 ms) between seeds,
 * so a 10% gate flakes. The regressions worth blocking are plan changes (the
 * 0.7 wins are 5–9×), which clear both bounds by a wide margin.
 */
const GATE_MAX_PCT = 50;
const GATE_MIN_ABS_MS = 2;
function gateAgainstBaseline(result: TreeResult): number {
    if (!existsSync(BASELINE_PATH)) {
        console.error(`[compare-pg] No baseline at ${BASELINE_PATH}. Run with --write-baseline first.`);
        return 1;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    let failed = 0;
    for (const shape of result.shapes) {
        if (shape.skipped || shape.error) continue;
        const stored = baseline.shapes[shape.name];
        if (!stored) continue;
        const deltaPct = ((shape.p50Ms - stored.p50Ms) / stored.p50Ms) * 100;
        const abs = shape.p50Ms - stored.p50Ms;
        if (deltaPct > GATE_MAX_PCT && abs > GATE_MIN_ABS_MS) {
            failed++;
            console.error(
                `[compare-pg] REGRESSION ${shape.name}: p50 ${shape.p50Ms.toFixed(2)}ms vs baseline ${stored.p50Ms.toFixed(2)}ms (${deltaPct.toFixed(1)}%)`,
            );
        }
    }
    if (failed === 0) console.log("[compare-pg] PG gate passed.");
    return failed === 0 ? 0 : 1;
}

const scale = argValue("--scale") ?? "md";
const trees = parseTrees();
const endpoints = resolvePgEndpoints(REPO_ROOT);
console.log(`[compare-pg] Admin ${redactUrl(endpoints.adminUrl)} (port via ${endpoints.directPortSource})`);
console.log(`[compare-pg] Scale ${scale}; trees: ${trees.map((t) => `${t.label}@${t.path}`).join(", ")}`);

const results: TreeResult[] = [];
let exitCode = 0;
try {
    for (const tree of trees) {
        const commit = await gitCommit(tree.path);
        const scratchName = assertDbName(`bunsane_bench_${tree.label}_${process.pid}`);
        const scratchUrl = new URL(endpoints.testUrl.toString());
        scratchUrl.pathname = `/${scratchName}`;
        console.log(`[compare-pg] ${tree.label} ${commit.slice(0, 12)} scratch ${scratchName}`);
        await createScratch(scratchName, endpoints.adminUrl, endpoints.testRole);
        try {
            const result = await runTree(tree, scratchUrl, scratchName, scale);
            results.push(result);
        } finally {
            await dropScratch(scratchName, endpoints.adminUrl);
        }
    }
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[compare-pg] ${message}`);
    exitCode = 1;
}

if (results.length >= 2) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const combinedPath = join(RESULTS_DIR, "pg-compare.json");
    writeFileSync(combinedPath, JSON.stringify({ capturedAt: new Date().toISOString(), scale, results }, null, 2));
    console.log(`[compare-pg] Wrote ${combinedPath}`);
} else if (results.length === 1) {
    console.log(`[compare-pg] Single tree (${results[0]?.label}); left pg-compare.json unchanged`);
}
if (results.length > 0) {
    printTable(results);
    if (hasFlag("--write-baseline")) {
        const head = results.find((r) => r.label === "head") ?? results[results.length - 1];
        if (head) writeBaseline(head);
    }
    if (hasFlag("--gate")) {
        const current = results[results.length - 1];
        if (current) exitCode = gateAgainstBaseline(current) || exitCode;
    }
}

process.exit(exitCode);
