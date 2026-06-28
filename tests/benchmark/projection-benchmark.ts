/**
 * Phase 0 benchmark for RFC_MATERIALIZED_READ_MODELS.
 *
 * Fairly compares THREE ways to serve a filter/sort/aggregate on a component field:
 *   (A) jsonb_noidx  — `data->>'field'` with only the GIN index BunSane's
 *                      `@CompData({ indexed: true })` creates today (GIN serves
 *                      containment, NOT `->>` equality/order → seq scan/sort).
 *   (B) jsonb_expr   — same `data->>'field'` SQL but with a B-tree EXPRESSION
 *                      index `((data->>'field'))` present — i.e. what
 *                      `@IndexedField('btree')` already gives you today.
 *   (C) generated    — typed `GENERATED ALWAYS AS ((data->>'field')) STORED`
 *                      column + B-tree (the RFC's M1 proposal).
 *
 * A-vs-C shows "missing index" (dramatic, but misleading for M1).
 * B-vs-C shows the TRUE marginal value of generated columns over the index
 * BunSane can already create.
 *
 * Standalone script — NOT a bun:test (DDL inside bun:test wedges the Bun SQL
 * connection, see CLAUDE.md). Run directly:
 *
 *   bun tests/benchmark/projection-benchmark.ts            # 1M rows (default)
 *   bun tests/benchmark/projection-benchmark.ts 5000000    # custom row count
 *
 * Connection: BENCH_DB_URL env override wins, else DB_CONNECTION_URL from .env.test.
 * Creates one throwaway table `bench_proj_invoice`, then DROPs it.
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- config ----------------------------------------------------------------
const ROWS = Number(process.argv[2] ?? 1_000_000);
const RUNS = 30;
const WARMUP = 5;
const TABLE = "bench_proj_invoice";

function loadEnvUrl(): string {
    if (process.env.BENCH_DB_URL) return process.env.BENCH_DB_URL;
    const txt = readFileSync(join(process.cwd(), ".env.test"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*DB_CONNECTION_URL\s*=\s*(.+)\s*$/);
        if (m && m[1]) return m[1].trim().replace(/^["']|["']$/g, "");
    }
    throw new Error("DB_CONNECTION_URL not found in .env.test");
}

function stats(samples: number[]) {
    if (samples.length === 0) return { median: 0, p95: 0, min: 0 };
    const s = [...samples].sort((a, b) => a - b);
    return {
        median: s[Math.floor(s.length / 2)] ?? 0,
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0,
        min: s[0] ?? 0,
    };
}

async function bench(db: SQL, sql: string, params: any[] = []) {
    for (let i = 0; i < WARMUP; i++) await db.unsafe(sql, params);
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        await db.unsafe(sql, params);
        samples.push(performance.now() - t0);
    }
    return stats(samples).median;
}

async function planOf(db: SQL, sql: string, params: any[] = []): Promise<string> {
    const rows: any[] = await db.unsafe(`EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`, params);
    const lines = rows.map((r) => r["QUERY PLAN"] as string);
    const scan = lines.find((l) => /Scan|Index|Aggregate|Sort/.test(l)) ?? lines[0] ?? "";
    return scan.trim();
}

// ---- connect ---------------------------------------------------------------
const url = loadEnvUrl();
console.log(`Connecting: ${url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@")}`);
const db = new SQL({ url, prepare: false, max: 1, connectionTimeout: 10, idleTimeout: 0 });
const ver: any[] = await db.unsafe("select current_setting('server_version_num') as num");
console.log(`Connected. server_version_num=${ver[0].num}`);
await db.unsafe("SET statement_timeout = 0");

// ---- seed ------------------------------------------------------------------
console.log(`\nSeeding ${ROWS.toLocaleString()} rows ...`);
const seedStart = performance.now();
await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
await db.unsafe(`
    CREATE TABLE ${TABLE} (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        entity_id uuid NOT NULL DEFAULT gen_random_uuid(),
        type_id varchar(64) NOT NULL DEFAULT 'bench',
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
    )
`);
await db.unsafe(`
    INSERT INTO ${TABLE} (data)
    SELECT jsonb_build_object(
        'status',     (ARRAY['draft','sent','paid','void','overdue'])[1 + floor(random()*5)::int],
        'region',     'region_' || (1 + floor(random()*20)::int),
        'customerId', gen_random_uuid()::text,
        'total',      round((random()*10000)::numeric, 2)
    )
    FROM generate_series(1, ${ROWS})
`);
console.log(`Seeded in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`);

// ---- indexes always present ------------------------------------------------
// (A) what @CompData({ indexed: true }) creates today: per-field sub-path GIN
console.log(`Building GIN (framework default) + generated columns ...`);
await db.unsafe(`CREATE INDEX bench_gin_customerid ON ${TABLE} USING GIN ((data->'customerId') jsonb_path_ops)`);
await db.unsafe(`CREATE INDEX bench_gin_total      ON ${TABLE} USING GIN ((data->'total') jsonb_path_ops)`);
// (C) generated columns + btree (the RFC M1 proposal)
await db.unsafe(`ALTER TABLE ${TABLE} ADD COLUMN proj_customerid text    GENERATED ALWAYS AS ((data->>'customerId')) STORED`);
await db.unsafe(`ALTER TABLE ${TABLE} ADD COLUMN proj_total       numeric GENERATED ALWAYS AS (((data->>'total')::numeric)) STORED`);
await db.unsafe(`ALTER TABLE ${TABLE} ADD COLUMN proj_region      text    GENERATED ALWAYS AS ((data->>'region')) STORED`);
await db.unsafe(`CREATE INDEX bench_proj_customerid ON ${TABLE} (proj_customerid)`);
await db.unsafe(`CREATE INDEX bench_proj_total      ON ${TABLE} (proj_total)`);
await db.unsafe(`ANALYZE ${TABLE}`);

// helper: run a 3-way comparison for one query.
// exprDDL creates the (B) btree expression index; we measure jsonb BEFORE and AFTER it exists.
type ThreeWay = { group: string; noidx: number; expr: number; gen: number; plans: Record<string, string> };
async function threeWay(group: string, jsonbSql: string, genSql: string, exprDDL: string, exprName: string, params: any[] = []): Promise<ThreeWay> {
    // (A) GIN-only / no usable btree
    await db.unsafe(`DROP INDEX IF EXISTS ${exprName}`);
    await db.unsafe(`ANALYZE ${TABLE}`);
    const noidx = await bench(db, jsonbSql, params);
    const planNoidx = await planOf(db, jsonbSql, params);
    // (B) with btree expression index (what @IndexedField('btree') makes)
    await db.unsafe(exprDDL);
    await db.unsafe(`ANALYZE ${TABLE}`);
    const expr = await bench(db, jsonbSql, params);
    const planExpr = await planOf(db, jsonbSql, params);
    // (C) generated column
    const gen = await bench(db, genSql, params);
    const planGen = await planOf(db, genSql, params);
    return { group, noidx, expr, gen, plans: { noidx: planNoidx, expr: planExpr, gen: planGen } };
}

const results: ThreeWay[] = [];

// Q-FILTER — selective equality, ~1 row
{
    const sample: any[] = await db.unsafe(`SELECT data->>'customerId' AS cid FROM ${TABLE} LIMIT 1`);
    const cid = sample[0].cid as string;
    results.push(await threeWay(
        "Selective filter customerId = <uuid> (~1 row)",
        `SELECT id, data FROM ${TABLE} WHERE data->>'customerId' = $1`,
        `SELECT id, data FROM ${TABLE} WHERE proj_customerid = $1`,
        `CREATE INDEX bench_expr_customerid ON ${TABLE} ((data->>'customerId'))`,
        `bench_expr_customerid`,
        [cid],
    ));
}

// Q-SORT — order by numeric + limit
results.push(await threeWay(
    "Sort + limit  ORDER BY total DESC LIMIT 20",
    `SELECT id FROM ${TABLE} ORDER BY (data->>'total')::numeric DESC LIMIT 20`,
    `SELECT id FROM ${TABLE} ORDER BY proj_total DESC LIMIT 20`,
    `CREATE INDEX bench_expr_total ON ${TABLE} (((data->>'total')::numeric))`,
    `bench_expr_total`,
));

// Q-AGG — SUM GROUP BY (where column statistics matter most)
results.push(await threeWay(
    "Aggregation  SUM(total) GROUP BY region",
    `SELECT data->>'region' AS region, SUM((data->>'total')::numeric) AS s FROM ${TABLE} GROUP BY data->>'region'`,
    `SELECT proj_region AS region, SUM(proj_total) AS s FROM ${TABLE} GROUP BY proj_region`,
    `CREATE INDEX bench_expr_region ON ${TABLE} ((data->>'region'))`,
    `bench_expr_region`,
));

// ---- report ----------------------------------------------------------------
console.log(`\n${"=".repeat(86)}`);
console.log(`PHASE 0 (FAIR 3-WAY) — ${ROWS.toLocaleString()} rows, ${RUNS} runs (median ms)`);
console.log(`A=GIN-only(indexed:true)  B=btree-expr(@IndexedField)  C=generated col (M1)`);
console.log(`${"=".repeat(86)}`);
for (const r of results) {
    console.log(`\n▸ ${r.group}`);
    console.log(`   A jsonb+GIN only   : ${r.noidx.toFixed(2)} ms`);
    console.log(`   B jsonb+btree-expr : ${r.expr.toFixed(2)} ms`);
    console.log(`   C generated col    : ${r.gen.toFixed(2)} ms`);
    console.log(`   A→C speedup: ${(r.noidx / r.gen).toFixed(1)}x   |   B→C speedup (TRUE M1 gain): ${(r.expr / r.gen).toFixed(2)}x`);
    console.log(`   plan A: ${r.plans.noidx}`);
    console.log(`   plan B: ${r.plans.expr}`);
    console.log(`   plan C: ${r.plans.gen}`);
}
console.log(`\n${"=".repeat(86)}`);

await db.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
console.log(`Dropped ${TABLE}.`);
await db.end();
