#!/usr/bin/env bun
/**
 * Real-PostgreSQL before/after comparison for the read path.
 *
 * Provisions a scratch database per tree, copies the scenario into that tree
 * (so each commit's Query/GraphQL code is what executes), then drops the database.
 *
 *   bun tests/benchmark/scripts/compare-pg.ts
 *   bun tests/benchmark/scripts/compare-pg.ts --scale smoke|md|lg
 *   bun tests/benchmark/scripts/compare-pg.ts --self --label head
 *   bun tests/benchmark/scripts/compare-pg.ts --gate
 *   bun tests/benchmark/scripts/compare-pg.ts --write-baseline
 *   bun tests/benchmark/scripts/compare-pg.ts --scale lg --concurrency 16 --duration 30
 *   bun tests/benchmark/scripts/compare-pg.ts --skip-shapes --concurrency 16 --duration 30
 *
 * Unknown --scale is an error. The gate reads tests/benchmark/baseline/<scale>-pg.json.
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
const SCENARIO_FILES = ["pg-scenario.ts", "pg-scale.ts", "pg-seed.ts"] as const;
const SCALES = ["smoke", "md", "lg"] as const;
type ScaleName = (typeof SCALES)[number];

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

interface ConcurrencyShape {
    name: string;
    samples: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
}

interface ConcurrencyResult {
    clients: number;
    durationS: number;
    warmupS: number;
    poolMax: number;
    elapsedMs: number;
    queries: number;
    errors: number;
    queriesPerSec: number;
    shapes: ConcurrencyShape[];
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
    concurrency?: ConcurrencyResult;
}

function argValue(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function requireIntFlag(flag: string): number | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx < 0) return undefined;
    const raw = process.argv[idx + 1];
    if (raw === undefined || raw.startsWith("--")) {
        console.error(`[compare-pg] ${flag} requires an integer`);
        process.exit(1);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        console.error(`[compare-pg] ${flag} requires a non-negative integer, got ${raw}`);
        process.exit(1);
    }
    return n;
}

function isScale(value: string): value is ScaleName {
    return value === "smoke" || value === "md" || value === "lg";
}

function baselinePath(scale: ScaleName): string {
    return join(REPO_ROOT, "tests", "benchmark", "baseline", `${scale}-pg.json`);
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
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const proc = spawn("git", ["rev-parse", "HEAD"], { cwd });
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`git rev-parse failed in ${cwd} (${code})`));
    });
    return promise;
}
async function createScratch(name: string, adminUrl: URL, testRole: string): Promise<void> {
    await withAdmin(adminUrl, async (db) => {
        await db.unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [name],
        );
        await db.unsafe(`DROP DATABASE IF EXISTS ${name}`);
        await db.unsafe(`CREATE DATABASE ${name} OWNER ${testRole}`);
        // Docker Desktop's 64MB /dev/shm cannot resize POSIX DSM segments
        // ("No space left on device" even with free space). Parallel gather
        // plans die at 1M rows. The scratch DB stays non-parallel so seq scan
        // vs index is still measured, without Gather nodes.
        await db.unsafe(`ALTER DATABASE ${name} SET max_parallel_workers_per_gather = 0`);
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

function installScenario(treePath: string): void {
    const destDir = join(treePath, "tests", "benchmark", "scripts");
    mkdirSync(destDir, { recursive: true });
    for (const file of SCENARIO_FILES) {
        const src = join(__dirname, file);
        if (!existsSync(src)) {
            throw new Error(`scenario file missing: ${src}`);
        }
        writeFileSync(join(destDir, file), readFileSync(src));
    }
}

function childEnv(
    scratchUrl: URL,
    scratchName: string,
    outPath: string,
    scale: ScaleName,
    label: string,
    concurrency: number,
    durationS: number,
    skipShapes: boolean,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DB_CONNECTION_URL: scratchUrl.toString(),
        POSTGRES_HOST: scratchUrl.hostname,
        POSTGRES_PORT: scratchUrl.port || "5432",
        POSTGRES_USER: decodeURIComponent(scratchUrl.username),
        POSTGRES_PASSWORD: decodeURIComponent(scratchUrl.password),
        POSTGRES_DB: scratchName,
        POSTGRES_MAX_CONNECTIONS: String(Math.max(8, concurrency)),
        DB_QUERY_TIMEOUT: scale === "lg" ? "600000" : "180000",
        BENCH_OUT: outPath,
        BENCH_SCALE: scale,
        BENCH_LABEL: label,
        BENCH_ITERATIONS: argValue("--iterations") ?? process.env.BENCH_ITERATIONS ?? "30",
        BENCH_WARMUP: argValue("--warmup") ?? process.env.BENCH_WARMUP ?? "5",
        BENCH_SKIP_SHAPES: skipShapes ? "1" : "0",
        LOG_LEVEL: "warn",
        NODE_ENV: "production",
        CACHE_ENABLED: "false",
    };
    if (concurrency > 0) {
        env.BENCH_CONCURRENCY = String(concurrency);
        env.BENCH_DURATION = String(durationS);
        env.DB_CONNECTION_TIMEOUT = "120";
    } else {
        delete env.BENCH_CONCURRENCY;
        delete env.BENCH_DURATION;
    }
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
    scale: ScaleName,
    concurrency: number,
    durationS: number,
    skipShapes: boolean,
): Promise<TreeResult> {
    installScenario(tree.path);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `pg-${tree.label}.json`);
    if (existsSync(outPath)) {
        writeFileSync(outPath, "");
    }

    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const proc = spawn("bun", ["tests/benchmark/scripts/pg-scenario.ts"], {
        cwd: tree.path,
        env: childEnv(scratchUrl, scratchName, outPath, scale, tree.label, concurrency, durationS, skipShapes),
        stdio: "inherit",
    });
    proc.on("error", reject);
    proc.on("exit", (exitCode) => resolve(exitCode ?? 1));
    const code = await promise;
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

function cell(shape: ShapeResult | undefined): string {
    if (!shape) return "-";
    if (shape.skipped) return "skip";
    if (shape.error) return "err";
    return shape.p50Ms.toFixed(2);
}

function printTable(results: TreeResult[]): void {
    const byLabel = new Map(results.map((r) => [r.label, r]));
    const base = byLabel.get("base");
    const head = byLabel.get("head") ?? results[results.length - 1];
    if (!head) return;
    const names = head.shapes.map((s) => s.name);
    console.log("\nshape                            base p50   head p50   delta%   base p95   head p95   stmts b/h");
    for (const name of names) {
        const h = head.shapes.find((s) => s.name === name);
        const b = base?.shapes.find((s) => s.name === name);
        let delta = "-";
        if (b && h && !b.skipped && !h.skipped && !b.error && !h.error && b.p50Ms > 0) {
            delta = (((h.p50Ms - b.p50Ms) / b.p50Ms) * 100).toFixed(1);
        }
        const bp95 = b && !b.skipped && !b.error ? b.p95Ms.toFixed(2) : "-";
        const hp95 = h && !h.skipped && !h.error ? h.p95Ms.toFixed(2) : "-";
        const stmts = `${b ? round(b.statementsPerIter) : "-"}/${h ? round(h.statementsPerIter) : "-"}`;
        console.log(
            `${name.padEnd(32)} ${cell(b).padStart(9)} ${cell(h).padStart(10)} ${delta.padStart(8)} ${bp95.padStart(10)} ${hp95.padStart(10)} ${stmts}`,
        );
    }
    for (const result of results) {
        if (!result.concurrency) continue;
        const c = result.concurrency;
        console.log(
            `\n${result.label} concurrency clients=${c.clients} duration=${c.durationS}s pool=${c.poolMax} qps=${c.queriesPerSec} errors=${c.errors}`,
        );
        console.log("shape                            samples    p50    p95    p99  errors");
        for (const shape of c.shapes) {
            console.log(
                `${shape.name.padEnd(32)} ${String(shape.samples).padStart(7)} ${shape.p50Ms.toFixed(2).padStart(7)} ${shape.p95Ms.toFixed(2).padStart(7)} ${shape.p99Ms.toFixed(2).padStart(7)} ${String(shape.errors).padStart(7)}`,
            );
        }
    }
}

interface BaselineFile {
    capturedAt: string;
    sourceCommit: string;
    scale?: string;
    shapes: Record<string, { p50Ms: number; p95Ms: number; meanMs: number }>;
}

function writeBaseline(result: TreeResult, scale: ScaleName): void {
    const path = baselinePath(scale);
    const shapes: BaselineFile["shapes"] = {};
    for (const shape of result.shapes) {
        if (shape.skipped || shape.error) continue;
        shapes[shape.name] = { p50Ms: shape.p50Ms, p95Ms: shape.p95Ms, meanMs: shape.meanMs };
    }
    const file: BaselineFile = {
        capturedAt: new Date().toISOString(),
        sourceCommit: result.commit,
        scale,
        shapes,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2));
    console.log(`[compare-pg] Wrote ${path}`);
}

/**
 * Same-commit repeats on real PG drift up to ~23% p50 (+1.6 ms) between seeds,
 * so a 10% gate flakes. The regressions worth blocking are plan changes (the
 * 0.7 wins are 5–9×), which clear both bounds by a wide margin.
 */
const GATE_MAX_PCT = 50;
const GATE_MIN_ABS_MS = 2;
function gateAgainstBaseline(result: TreeResult, scale: ScaleName): number {
    const path = baselinePath(scale);
    if (!existsSync(path)) {
        console.error(`[compare-pg] No baseline at ${path}. Run with --write-baseline first.`);
        return 1;
    }
    const baseline = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
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
    if (failed === 0) console.log(`[compare-pg] PG gate passed (${scale}).`);
    return failed === 0 ? 0 : 1;
}

const scaleArg = argValue("--scale") ?? "md";
if (!isScale(scaleArg)) {
    console.error(`[compare-pg] Unknown scale "${scaleArg}". Expected smoke, md, or lg.`);
    process.exit(1);
}
const scale: ScaleName = scaleArg;
const concurrency = requireIntFlag("--concurrency") ?? 0;
const durationS = requireIntFlag("--duration") ?? 30;
const skipShapes = hasFlag("--skip-shapes");
if (concurrency > 0 && durationS <= 0) {
    console.error("[compare-pg] --duration must be > 0 when --concurrency is set");
    process.exit(1);
}

const trees = parseTrees();
const endpoints = resolvePgEndpoints(REPO_ROOT);
console.log(`[compare-pg] Admin ${redactUrl(endpoints.adminUrl)} (port via ${endpoints.directPortSource})`);
console.log(`[compare-pg] Scale ${scale}; trees: ${trees.map((t) => `${t.label}@${t.path}`).join(", ")}`);
if (concurrency > 0) {
    console.log(`[compare-pg] Concurrency ${concurrency} for ${durationS}s${skipShapes ? " (shapes skipped)" : ""}`);
}

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
            const result = await runTree(tree, scratchUrl, scratchName, scale, concurrency, durationS, skipShapes);
            results.push(result);
            console.log(`[compare-pg] ${tree.label} seed ${result.seedMs}ms scale=${result.scale}`);
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
        if (head) writeBaseline(head, scale);
    }
    if (hasFlag("--gate")) {
        const current = results[results.length - 1];
        if (current) exitCode = gateAgainstBaseline(current, scale) || exitCode;
    }
}

process.exit(exitCode);
