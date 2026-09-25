#!/usr/bin/env bun
/**
 * One-tree real-PostgreSQL read-path scenario.
 *
 * Invoked by compare-pg.ts, which copies this file plus pg-scale.ts and
 * pg-seed.ts into the tree under test. Uses public Query/GraphQL APIs present
 * on 04f73c6 and on head. CompositeIndex is applied only when that module
 * exists, before ComponentRegistry.registerAllComponents.
 *
 *   BENCH_SCALE=smoke|md|lg
 *   BENCH_CONCURRENCY=N  BENCH_DURATION=S   mixed Query workload (default off)
 *   BENCH_SKIP_SHAPES=1                     seed + concurrency only
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import { IndexedField } from "../../../core/decorators/IndexedField";
import { ComponentRegistry } from "../../../core/components";
import { Entity } from "../../../core/Entity";
import {
    ArcheType,
    ArcheTypeField,
    ArcheTypeFunction,
    BaseArcheType,
    HasMany,
} from "../../../core/ArcheType";
import { Query, FilterOp } from "../../../query/Query";
import db, { getDb } from "../../../database";
import { PrepareDatabase } from "../../../database/DatabaseHelper";
import { getDbStats, resetDbStats } from "../../../database/instrumentedDb";
import { generateGraphQLSchemaV2, createYogaInstance, GraphQLOperation } from "../../../gql";
import { createRequestContextPlugin } from "../../../core/RequestContext";
import BaseService from "../../../service/Service";
import type { ScaleCounts, ScaleName } from "./pg-scale";
import type { SeedReport } from "./pg-seed";
import {
    assertLgMix,
    countsFor,
    positiveInt,
    resolveScale,
} from "./pg-scale";
import { seedDataset } from "./pg-seed";

const SCALE: ScaleName = resolveScale(process.env.BENCH_SCALE);
const COUNTS: ScaleCounts = countsFor(SCALE);
const ITERATIONS = positiveInt(process.env.BENCH_ITERATIONS, SCALE === "smoke" ? 3 : 30);
const WARMUP = positiveInt(process.env.BENCH_WARMUP, SCALE === "smoke" ? 1 : 5);
const CONCURRENCY = positiveInt(process.env.BENCH_CONCURRENCY, 0);
const DURATION_S = positiveInt(process.env.BENCH_DURATION, 30);
const CONCURRENCY_WARMUP_S = positiveInt(process.env.BENCH_CONCURRENCY_WARMUP, 3);
const SKIP_SHAPES = process.env.BENCH_SKIP_SHAPES === "1";
const OUT_PATH = process.env.BENCH_OUT;
const LABEL = process.env.BENCH_LABEL ?? "tree";

/** Same predicate as database/numericJsonField.ts NUMERIC_JSON_TEXT_REGEX. */
const NUMERIC_TEXT = "^-?[0-9]+\\.?[0-9]*$";

@Component
class BenchUser extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    email!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    username!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    status!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    tier!: string;

    @CompData()
    region!: string;

    @CompData()
    orderCount!: number;
}

@Component
class BenchProduct extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    sku!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    category!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    status!: string;

    @CompData()
    @IndexedField("numeric")
    price!: number;

    @CompData()
    @IndexedField("numeric")
    rating!: number;

    /** ~5% of rows omit this key so DESC sorts exercise NULLS LAST. */
    @CompData()
    @IndexedField("numeric")
    score!: number;

    /**
     * Numeric to the sorter. ~0.1% of stored values are the text 'n/a'.
     * Sorted only by g-legacyscore-sort, which is allowed to error.
     */
    @CompData()
    @IndexedField("numeric")
    legacyScore!: number;

    @CompData()
    name!: string;
}

@Component
class BenchOrder extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    userId!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    status!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    paymentMethod!: string;

    @CompData()
    @IndexedField("numeric")
    total!: number;

    @CompData()
    orderNumber!: string;
}

@Component
class BenchOrderFlag extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    fulfilled!: boolean;

    @CompData({ indexed: true })
    @IndexedField("btree")
    channel!: string;
}

@Component
class BenchOrderItem extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    orderId!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    productId!: string;

    @CompData({ indexed: true })
    @IndexedField("btree")
    status!: string;
}

@Component
class BenchReview extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField("btree")
    productId!: string;

    @CompData()
    @IndexedField("numeric")
    rating!: number;
}

@ArcheType({ name: "BenchOrderArch" })
class BenchOrderArch extends BaseArcheType {
    @ArcheTypeField(BenchOrder)
    order!: BenchOrder;
}

@ArcheType({ name: "BenchUserArch" })
class BenchUserArch extends BaseArcheType {
    @ArcheTypeField(BenchUser)
    profile!: BenchUser;

    @HasMany("BenchOrderArch", { foreignKey: "order.userId" })
    orders!: BenchOrderArch[];

    @ArcheTypeFunction({ returnType: "string" })
    async orderCount(entity: Entity): Promise<string> {
        const rows = await new Query()
            .with(BenchOrder, { filters: [Query.filter("userId", FilterOp.EQ, entity.id)] })
            .take(5000)
            .exec();
        return String(rows.length);
    }
}

@ArcheType({ name: "BenchUserArchBatched" })
class BenchUserArchBatched extends BaseArcheType {
    @ArcheTypeField(BenchUser)
    profile!: BenchUser;

    @HasMany("BenchOrderArch", { foreignKey: "order.userId" })
    orders!: BenchOrderArch[];

    // HEAD-only. Base stores the extra `batch` option and never resolves this
    // field; the e2 shape is skipped there. One GROUP BY over the parent ids.
    @ArcheTypeFunction({ returnType: "string", batch: true })
    async orderCount(parents: readonly Entity[]): Promise<Map<string, string>> {
        const ids = parents.map((parent) => parent.id);
        const counts = new Map<string, string>();
        for (const id of ids) counts.set(id, "0");
        if (ids.length === 0) return counts;
        const rows = await new Query()
            .with(BenchOrder, { filters: [Query.filter("userId", FilterOp.IN, ids)] })
            .groupBy(BenchOrder, "userId")
            .countBy();
        for (const row of rows) {
            const id = row["userId"];
            if (typeof id !== "string") continue;
            counts.set(id, String(row["count"] ?? 0));
        }
        return counts;
    }
}

class BenchListService extends BaseService {
    constructor() {
        super();
        const host = this as unknown as {
            __graphqlFields?: Array<{ type: string; field: string; propertyKey: string }>;
        } & Record<string, unknown>;
        new BenchUserArch().registerFieldResolvers(host);
        new BenchOrderArch().registerFieldResolvers(host);
        new BenchUserArchBatched().registerFieldResolvers(host);
    }

    @GraphQLOperation({ type: "Query", output: [new BenchUserArch()] })
    async benchUsers(): Promise<BenchUserArch[]> {
        const rows = await new Query()
            .with(BenchUser)
            .sortBy(BenchUser, "username", "ASC")
            .take(50)
            .exec();
        return rows.map((row) => {
            return { id: row.id } as unknown as BenchUserArch;
        });
    }

    @GraphQLOperation({ type: "Query", output: [new BenchUserArchBatched()] })
    async benchUsersBatched(): Promise<BenchUserArchBatched[]> {
        const rows = await new Query()
            .with(BenchUser)
            .sortBy(BenchUser, "username", "ASC")
            .take(50)
            .exec();
        return rows.map((row) => {
            return { id: row.id } as unknown as BenchUserArchBatched;
        });
    }
}

interface ShapeResult {
    name: string;
    skipped?: string;
    iterations: number;
    warmup: number;
    rowsReturned: number;
    idHash: string;
    /** Returned ids, in result order. Not part of the timed loop. */
    ids?: string[];
    /** Order-independent hash of ids. Unsorted/populate/count sets compare on this. */
    idSetHash?: string;
    /** Sort-key text aligned with ids. Null means missing or non-numeric. */
    sortKeys?: Array<string | null>;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    statementsPerIter: number;
    sql?: string;
    explain?: string;
    explainSummary?: string;
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

interface TimedQuery {
    debugMode(enabled?: boolean): TimedQuery;
    explainAnalyze(buffers?: boolean): Promise<string>;
    exec(): Promise<Array<{ id: string }>>;
}

interface RunOutcome {
    ids: string[];
    rowsReturned: number;
}

interface Job {
    name: string;
    run: () => Promise<unknown>;
}

interface Tokens {
    ratingNext?: string;
    ratingDeep?: string;
    ratingBefore?: string;
    scoreNulls?: string;
    createdAtNext?: string;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx] ?? 0;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function hashIds(ids: readonly string[]): string {
    const hash = createHash("sha256");
    for (const id of ids) {
        hash.update(id);
        hash.update("\n");
    }
    return hash.digest("hex");
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function idsOf(rows: readonly unknown[]): string[] {
    const ids: string[] = [];
    for (const row of rows) {
        if (row && typeof row === "object" && "id" in row && typeof row.id === "string") {
            ids.push(row.id);
            continue;
        }
        ids.push(JSON.stringify(row));
    }
    return ids;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidInList(ids: readonly string[]): string {
    if (ids.length === 0) return "NULL";
    return ids.map((id) => {
        if (!UUID_RE.test(id)) throw new Error(`refusing non-uuid id ${id}`);
        return `'${id}'::uuid`;
    }).join(", ");
}

async function alignKeys(ids: readonly string[], sql: string): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    const rows = await db.unsafe<Array<{ id: string; key: string | null }>>(sql);
    const byId = new Map<string, string | null>();
    for (const row of rows) byId.set(row.id, row.key ?? null);
    return ids.map((id) => byId.get(id) ?? null);
}

function componentKeys(component: string, field: string, numeric: boolean): (ids: readonly string[]) => Promise<Array<string | null>> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(component) || !/^[A-Za-z][A-Za-z0-9]*$/.test(field)) {
        throw new Error(`bad key lookup ${component}.${field}`);
    }
    const expr = numeric
        ? `CASE WHEN c.data->>'${field}' ~ '${NUMERIC_TEXT}' THEN c.data->>'${field}' END`
        : `c.data->>'${field}'`;
    return (ids) => alignKeys(
        ids,
        `SELECT c.entity_id::text AS id, ${expr} AS key FROM components c WHERE c.name = '${component}' AND c.deleted_at IS NULL AND c.entity_id IN (${uuidInList(ids)})`,
    );
}

function createdAtKeys(ids: readonly string[]): Promise<Array<string | null>> {
    return alignKeys(
        ids,
        `SELECT id::text AS id, to_char(date_trunc('milliseconds', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS key FROM entities WHERE id IN (${uuidInList(ids)})`,
    );
}


function summarizeExplain(explain: string | undefined): string {
    if (!explain) return "";
    const nodes: string[] = [];
    let buffers = "";
    for (const raw of explain.split("\n")) {
        const line = raw.trim().replace(/\s+/g, " ");
        if (!buffers && line.startsWith("Buffers:")) buffers = line;
        if (/Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan|Sort |Hash Join|Nested Loop|Merge Join|Aggregate|Limit/.test(line)) {
            nodes.push(line.slice(0, 240));
        }
    }
    const body = nodes.slice(0, 6).join(" || ");
    return buffers ? `${body} || ${buffers}` : body;
}

function asTimed(query: object): TimedQuery {
    return query as unknown as TimedQuery;
}

function hasSortByCreatedAt(): boolean {
    return typeof new Query().sortByCreatedAt === "function";
}

function hasSortedCursor(): boolean {
    return typeof new Query().sortedCursor === "function" && typeof Query.encodeSortedCursor === "function";
}

function headBatchApi(): boolean {
    return existsSync(fileURLToPath(new URL("../../../core/archetype/functionReturn.ts", import.meta.url)));
}

async function importUnknown(specifier: string): Promise<unknown> {
    return import(specifier);
}

async function applyCompositeIndexIfPresent(): Promise<boolean> {
    const fileUrl = new URL("../../../core/decorators/CompositeIndex.ts", import.meta.url);
    if (!existsSync(fileURLToPath(fileUrl))) {
        console.log("[pg-scenario] CompositeIndex absent; no (status, total) composite index");
        return false;
    }
    const loaded = await importUnknown(fileUrl.href);
    if (!loaded || typeof loaded !== "object" || !("CompositeIndex" in loaded)) {
        throw new Error("CompositeIndex.ts exists but does not export CompositeIndex");
    }
    const factory = loaded.CompositeIndex;
    if (typeof factory !== "function") {
        throw new Error("CompositeIndex export is not a function");
    }
    const build = factory as (fields: string[]) => unknown;
    const decorator = build(["status", "total"]);
    if (typeof decorator !== "function") {
        throw new Error("CompositeIndex(fields) did not return a decorator");
    }
    const apply = decorator as (ctor: typeof BenchOrder) => unknown;
    apply(BenchOrder);
    console.log("[pg-scenario] Applied CompositeIndex([status, total]) to BenchOrder");
    return true;
}

function skipped(name: string, reason: string): ShapeResult {
    console.log(`[pg-scenario] ${name} skipped: ${reason}`);
    return {
        name,
        skipped: reason,
        iterations: 0,
        warmup: 0,
        rowsReturned: 0,
        idHash: "",
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        meanMs: 0,
        minMs: 0,
        maxMs: 0,
        statementsPerIter: 0,
    };
}

function errored(name: string, message: string, captured?: { sql?: string; explain?: string }): ShapeResult {
    const explain = captured?.explain;
    return {
        name,
        iterations: 0,
        warmup: 0,
        rowsReturned: 0,
        idHash: createHash("sha256").update(`error:${message}`).digest("hex"),
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        meanMs: 0,
        minMs: 0,
        maxMs: 0,
        statementsPerIter: 0,
        sql: captured?.sql,
        explain,
        explainSummary: summarizeExplain(explain),
        error: message,
    };
}

async function timeShape(
    name: string,
    run: () => Promise<RunOutcome>,
    capture?: () => Promise<{ sql?: string; explain?: string }>,
    keysOf?: (ids: readonly string[]) => Promise<Array<string | null>>,
): Promise<ShapeResult> {
    for (let i = 0; i < WARMUP; i++) await run();
    const times: number[] = [];
    let statements = 0;
    let outcome: RunOutcome = { ids: [], rowsReturned: 0 };
    for (let i = 0; i < ITERATIONS; i++) {
        resetDbStats();
        const start = performance.now();
        outcome = await run();
        times.push(performance.now() - start);
        statements += getDbStats().totalCount;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
    let sql: string | undefined;
    let explain: string | undefined;
    if (capture) {
        const captured = await capture();
        sql = captured.sql;
        explain = captured.explain;
    }
    let sortKeys: Array<string | null> | undefined;
    if (keysOf) {
        sortKeys = await keysOf(outcome.ids);
    }
    const result: ShapeResult = {
        name,
        iterations: ITERATIONS,
        warmup: WARMUP,
        rowsReturned: outcome.rowsReturned,
        idHash: hashIds(outcome.ids),
        ids: outcome.ids,
        idSetHash: hashIds([...outcome.ids].sort()),
        sortKeys,
        p50Ms: round2(percentile(sorted, 0.5)),
        p95Ms: round2(percentile(sorted, 0.95)),
        p99Ms: round2(percentile(sorted, 0.99)),
        meanMs: round2(mean),
        minMs: round2(sorted[0] ?? 0),
        maxMs: round2(sorted[sorted.length - 1] ?? 0),
        statementsPerIter: round2(statements / times.length),
        sql,
        explain,
        explainSummary: summarizeExplain(explain),
    };
    const keyPreview = sortKeys ? ` keys=${sortKeys.slice(0, 3).map((k) => k ?? "null").join(",")}` : "";
    console.log(
        `[pg-scenario] ${name} rows=${result.rowsReturned} idHash=${result.idHash.slice(0, 12)} p50=${result.p50Ms}ms p95=${result.p95Ms}ms stmts=${result.statementsPerIter}${keyPreview}`,
    );
    return result;
}
let shapeLog: ShapeResult[] = [];

async function runMeasured(
    name: string,
    run: () => Promise<RunOutcome>,
    capture?: () => Promise<{ sql?: string; explain?: string }>,
    keysOf?: (ids: readonly string[]) => Promise<Array<string | null>>,
): Promise<void> {
    try {
        shapeLog.push(await timeShape(name, run, capture, keysOf));
    } catch (error: unknown) {
        const message = errorText(error);
        let captured: { sql?: string; explain?: string } | undefined;
        if (capture) {
            try {
                captured = await capture();
            } catch {
                captured = undefined;
            }
        }
        console.log(`[pg-scenario] ${name} error: ${message}`);
        shapeLog.push(errored(name, message, captured));
    }
}

function captureLines(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    return {
        lines,
        restore: () => {
            console.log = original;
        },
    };
}

async function capturePlan(build: () => TimedQuery): Promise<{ sql?: string; explain?: string }> {
    const captured = captureLines();
    try {
        await build().debugMode(true).exec();
    } catch (error: unknown) {
        captured.lines.push(`EXEC failed: ${errorText(error)}`);
    } finally {
        captured.restore();
    }
    const sqlLine = captured.lines.find((line) => line.startsWith("SQL:"));
    let explain: string | undefined;
    try {
        explain = await build().explainAnalyze(true);
    } catch (error: unknown) {
        explain = `EXPLAIN failed: ${errorText(error)}`;
    }
    return { sql: sqlLine?.slice(4).trim(), explain };
}

async function captureCount(): Promise<{ sql?: string; explain?: string }> {
    const captured = captureLines();
    try {
        await new Query().with(BenchOrder).with(BenchOrderFlag).debugMode(true).count();
    } finally {
        captured.restore();
    }
    const sqlLine = captured.lines.find((line) => line.startsWith("SQL:"));
    const paramsLine = captured.lines.find((line) => line.startsWith("Params:"));
    const sql = sqlLine?.slice(4).trim();
    if (!sql) return {};
    let params: unknown[] = [];
    if (paramsLine) {
        try {
            const parsed: unknown = JSON.parse(paramsLine.slice("Params:".length).trim());
            if (Array.isArray(parsed)) params = parsed;
        } catch {
            params = [];
        }
    }
    try {
        const explained = await db.unsafe<Array<Record<string, unknown>>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        const explain = explained.map((row) => String(row["QUERY PLAN"] ?? "")).join("\n");
        return { sql, explain };
    } catch (error: unknown) {
        return { sql, explain: `EXPLAIN failed: ${errorText(error)}` };
    }
}

async function outcomeOf(run: () => Promise<readonly unknown[]>): Promise<RunOutcome> {
    const rows = await run();
    return { ids: idsOf(rows), rowsReturned: rows.length };
}

function ratingQuery(direction: "ASC" | "DESC", take: number): TimedQuery {
    return asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", direction).take(take));
}

function countNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    throw new Error(`expected count, got ${JSON.stringify(value)}`);
}

async function scalarRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    return db.unsafe<T[]>(sql, params);
}

async function prepareTokens(productType: string): Promise<Tokens> {
    const tokens: Tokens = {};
    if (!hasSortedCursor()) return tokens;
    try {
        const page1 = await new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20).exec();
        const last = page1[page1.length - 1];
        if (!last) throw new Error("keyset page 1 was empty");
        const ratingRows = await db`
            SELECT (data->>'rating') AS rating
            FROM components
            WHERE entity_id = ${last.id}::uuid AND name = 'BenchProduct'
            LIMIT 1
        `;
        const rating = ratingRows[0]?.rating;
        if (typeof rating !== "string" && typeof rating !== "number") throw new Error(`missing rating for ${last.id}`);
        tokens.ratingNext = Query.encodeSortedCursor(rating, last.id);
    } catch (error: unknown) {
        console.log(`[pg-scenario] rating next token failed: ${errorText(error)}`);
    }
    try {
        const counted = await scalarRows<{ n: unknown }>(
            `SELECT count(*)::int AS n FROM components WHERE type_id = $1 AND deleted_at IS NULL AND name = 'BenchProduct'`,
            [productType],
        );
        const n = countNumber(counted[0]?.n);
        const deepOffset = Math.min(n - 1, Math.floor(n * 0.4));
        const beforeOffset = Math.min(n - 1, 39);
        const at = async (offset: number): Promise<string> => {
            const rows = await scalarRows<{ entity_id: string; rating: string }>(
                `SELECT c.entity_id::text AS entity_id, c.data->>'rating' AS rating
                 FROM components c
                 WHERE c.type_id = $1 AND c.deleted_at IS NULL AND c.name = 'BenchProduct'
                 ORDER BY (c.data->>'rating')::numeric DESC, c.entity_id ASC
                 OFFSET $2 LIMIT 1`,
                [productType, offset],
            );
            const row = rows[0];
            if (!row?.entity_id || typeof row.rating !== "string") throw new Error(`no rating row at offset ${offset}`);
            return Query.encodeSortedCursor(row.rating, row.entity_id);
        };
        if (deepOffset >= 0) tokens.ratingDeep = await at(deepOffset);
        if (beforeOffset >= 0) tokens.ratingBefore = await at(beforeOffset);
    } catch (error: unknown) {
        console.log(`[pg-scenario] rating depth token failed: ${errorText(error)}`);
    }
    try {
        // Last non-null score in the engine's DESC order.
        // New engine (orderPlan.ts): score DESC, entity_id DESC → min score, smallest id.
        // Old engine: score DESC, entity_id ASC → min score, largest id.
        const descTieIsDesc = existsSync(fileURLToPath(new URL("../../../query/orderPlan.ts", import.meta.url)));
        const idDir = descTieIsDesc ? "ASC" : "DESC";
        console.log(`[pg-scenario] score-nulls cursor tie entity_id ${descTieIsDesc ? "DESC" : "ASC"} (lookup ${idDir})`);
        const rows = await scalarRows<{ entity_id: string; score: string }>(
            `SELECT c.entity_id::text AS entity_id, c.data->>'score' AS score
             FROM components c
             WHERE c.type_id = $1 AND c.deleted_at IS NULL AND c.name = 'BenchProduct'
               AND c.data ? 'score' AND (c.data->>'score') ~ '${NUMERIC_TEXT}'
             ORDER BY (c.data->>'score')::numeric ASC, c.entity_id ${idDir}
             LIMIT 1`,
            [productType],
        );
        const row = rows[0];
        if (!row?.entity_id || typeof row.score !== "string") throw new Error("no non-null score row");
        tokens.scoreNulls = Query.encodeSortedCursor(row.score, row.entity_id);
    } catch (error: unknown) {
        console.log(`[pg-scenario] score-nulls token failed: ${errorText(error)}`);
    }
    if (hasSortByCreatedAt()) {
        try {
            const page1 = await new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20).exec();
            const last = page1[page1.length - 1];
            if (!last) throw new Error("created-at page 1 was empty");
            const rows = await db`SELECT created_at FROM entities WHERE id = ${last.id}::uuid LIMIT 1`;
            const raw = rows[0]?.created_at;
            const at = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : undefined;
            if (!at || Number.isNaN(at.getTime())) throw new Error(`missing created_at for ${last.id}`);
            tokens.createdAtNext = Query.encodeSortedCursor(at, last.id);
        } catch (error: unknown) {
            console.log(`[pg-scenario] created-at token failed: ${errorText(error)}`);
        }
    }
    return tokens;
}

async function graphqlYoga(): Promise<{
    fetchList: () => Promise<unknown[]>;
    fetchBatched: () => Promise<unknown[]>;
}> {
    const service = new BenchListService();
    const generated = generateGraphQLSchemaV2([service]);
    if (!generated.schema) throw new Error("generateGraphQLSchemaV2 returned no schema");
    const yoga = createYogaInstance(generated.schema, [createRequestContextPlugin()], undefined, {
        introspection: false,
        graphiql: false,
        maxComplexity: 1_000_000,
        maxDepth: 8,
    });
    const post = async (query: string, field: string): Promise<unknown[]> => {
        const response = await yoga.fetch("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query }),
        });
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") throw new Error("yoga returned a non-object body");
        const record = body as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
        if (record.errors && record.errors.length > 0) {
            throw new Error(record.errors.map((err) => err.message ?? "graphql error").join("; "));
        }
        const rows = record.data?.[field];
        return Array.isArray(rows) ? rows : [];
    };
    const listQuery = `query BenchList {
        benchUsers {
            id
            profile { username status }
            orders { id }
            orderCount
        }
    }`;
    const batchedQuery = `query BenchListBatched {
        benchUsersBatched {
            id
            profile { username status }
            orders { id }
            orderCount
        }
    }`;
    return {
        fetchList: () => post(listQuery, "benchUsers"),
        fetchBatched: () => post(batchedQuery, "benchUsersBatched"),
    };
}

function queryJobs(tokens: Tokens): Job[] {
    const jobs: Job[] = [
        { name: "a-sort-rating-20", run: () => ratingQuery("DESC", 20).exec() },
        { name: "a-sort-rating-100", run: () => ratingQuery("DESC", 100).exec() },
        { name: "a-sort-rating-asc-20", run: () => ratingQuery("ASC", 20).exec() },
        {
            name: "a-sort-username-asc-50",
            run: () => asTimed(new Query().with(BenchUser).sortBy(BenchUser, "username", "ASC").take(50)).exec(),
        },
        {
            name: "a-sort-score-desc-20",
            run: () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "score", "DESC").take(20)).exec(),
        },
        {
            name: "c-two-filter-sort-20",
            run: () => asTimed(
                new Query()
                    .with(BenchOrder, { filters: [Query.filter("status", FilterOp.EQ, "delivered")] })
                    .with(BenchOrderFlag, { filters: [Query.filter("fulfilled", FilterOp.EQ, true)] })
                    .sortBy(BenchOrder, "total", "DESC")
                    .take(20),
            ).exec(),
        },
        {
            name: "c-selective-filter-sort-20",
            run: () => asTimed(
                new Query()
                    .with(BenchOrder, { filters: [Query.filter("status", FilterOp.EQ, "cancelled")] })
                    .sortBy(BenchOrder, "total", "DESC")
                    .take(20),
            ).exec(),
        },
        {
            name: "d-populate-100",
            run: () => asTimed(new Query().with(BenchOrder).with(BenchOrderFlag).populate().take(100)).exec(),
        },
        {
            name: "d-count-two-components",
            run: () => new Query().with(BenchOrder).with(BenchOrderFlag).count(),
        },
    ];
    if (hasSortByCreatedAt()) {
        jobs.push(
            { name: "b-created-at-20", run: () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20)).exec() },
            { name: "b-created-at-100", run: () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(100)).exec() },
            { name: "b-created-at-review-desc-20", run: () => asTimed(new Query().with(BenchReview).sortByCreatedAt("DESC").take(20)).exec() },
            { name: "b-created-at-review-asc-20", run: () => asTimed(new Query().with(BenchReview).sortByCreatedAt("ASC").take(20)).exec() },
        );
        if (tokens.createdAtNext) {
            const token = tokens.createdAtNext;
            jobs.push({
                name: "b-created-at-keyset-20",
                run: () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20).sortedCursor(token)).exec(),
            });
        }
    }
    if (tokens.ratingNext) {
        const token = tokens.ratingNext;
        jobs.push({
            name: "f-keyset-next-20",
            run: () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20).sortedCursor(token)).exec(),
        });
    }
    if (tokens.ratingDeep) {
        const token = tokens.ratingDeep;
        jobs.push({
            name: "f-keyset-deep-20",
            run: () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20).sortedCursor(token)).exec(),
        });
    }
    if (tokens.ratingBefore) {
        const token = tokens.ratingBefore;
        jobs.push({
            name: "f-keyset-before-20",
            run: () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20).sortedCursor(token, "before")).exec(),
        });
    }
    if (tokens.scoreNulls) {
        const token = tokens.scoreNulls;
        jobs.push({
            name: "f-keyset-score-into-nulls",
            run: () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "score", "DESC").take(20).sortedCursor(token)).exec(),
        });
    }
    return jobs;
}

async function runConcurrency(jobs: Job[]): Promise<ConcurrencyResult> {
    const usable: Job[] = [];
    for (const job of jobs) {
        try {
            await job.run();
            usable.push(job);
        } catch (error: unknown) {
            console.log(`[pg-scenario] concurrency excludes ${job.name}: ${errorText(error)}`);
        }
    }
    if (usable.length === 0) throw new Error("concurrency mix is empty");
    const poolMax = positiveInt(process.env.POSTGRES_MAX_CONNECTIONS, CONCURRENCY);
    console.log(
        `[pg-scenario] concurrency warmup ${CONCURRENCY_WARMUP_S}s then ${DURATION_S}s x ${CONCURRENCY} clients, ${usable.length} shapes, pool ${poolMax}`,
    );
    const loop = async (clientId: number, stopAt: number, record: boolean, samples: Array<{ name: string; ms: number; ok: boolean }>): Promise<void> => {
        let cursor = clientId;
        while (performance.now() < stopAt) {
            const job = usable[cursor % usable.length];
            cursor += 1;
            if (!job) break;
            const start = performance.now();
            try {
                await job.run();
                if (record) samples.push({ name: job.name, ms: performance.now() - start, ok: true });
            } catch {
                if (record) samples.push({ name: job.name, ms: performance.now() - start, ok: false });
            }
        }
    };
    const warmupStop = performance.now() + CONCURRENCY_WARMUP_S * 1000;
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => loop(id, warmupStop, false, [])));
    const samples: Array<{ name: string; ms: number; ok: boolean }> = [];
    const measuredStart = performance.now();
    const stopAt = measuredStart + DURATION_S * 1000;
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => loop(id, stopAt, true, samples)));
    const elapsedMs = performance.now() - measuredStart;
    const byName = new Map<string, { ok: number[]; errors: number }>();
    let queries = 0;
    let errors = 0;
    for (const sample of samples) {
        let bucket = byName.get(sample.name);
        if (!bucket) {
            bucket = { ok: [], errors: 0 };
            byName.set(sample.name, bucket);
        }
        if (sample.ok) {
            bucket.ok.push(sample.ms);
            queries += 1;
        } else {
            bucket.errors += 1;
            errors += 1;
        }
    }
    const shapes: ConcurrencyShape[] = [];
    for (const job of usable) {
        const bucket = byName.get(job.name) ?? { ok: [], errors: 0 };
        const sorted = [...bucket.ok].sort((a, b) => a - b);
        shapes.push({
            name: job.name,
            samples: bucket.ok.length,
            errors: bucket.errors,
            p50Ms: round2(percentile(sorted, 0.5)),
            p95Ms: round2(percentile(sorted, 0.95)),
            p99Ms: round2(percentile(sorted, 0.99)),
        });
    }
    const result: ConcurrencyResult = {
        clients: CONCURRENCY,
        durationS: DURATION_S,
        warmupS: CONCURRENCY_WARMUP_S,
        poolMax,
        elapsedMs: Math.round(elapsedMs),
        queries,
        errors,
        queriesPerSec: round2(queries / (elapsedMs / 1000)),
        shapes,
    };
    console.log(
        `[pg-scenario] concurrency queries=${queries} errors=${errors} qps=${result.queriesPerSec}`,
    );
    return result;
}

async function closePool(): Promise<void> {
    const closer = db as unknown as { close?: () => Promise<void>; end?: () => Promise<void> };
    if (closer.close) await closer.close();
    else if (closer.end) await closer.end();
}

async function traceGraphql(): Promise<void> {
    const real = getDb() as {
        unsafe: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const orig = real.unsafe.bind(real);
    const calls: Array<{ ms: number; sql: string; params: unknown[] }> = [];
    real.unsafe = (sql: string, params?: unknown[]) => {
        const t0 = performance.now();
        const pending = params === undefined ? orig(sql) : orig(sql, params);
        return Promise.resolve(pending).finally(() => {
            calls.push({
                ms: Math.round((performance.now() - t0) * 100) / 100,
                sql,
                params: params ?? [],
            });
        });
    };
    const yoga = await graphqlYoga();
    calls.length = 0;
    const eStart = performance.now();
    await yoga.fetchList();
    const eMs = Math.round(performance.now() - eStart);
    const eCalls = calls.splice(0);
    const e2Start = performance.now();
    await yoga.fetchBatched();
    const e2Ms = Math.round(performance.now() - e2Start);
    const e2Calls = calls.splice(0);
    real.unsafe = orig;

    async function explainSlow(traced: Array<{ ms: number; sql: string; params: unknown[] }>) {
        const top = [...traced].sort((a, b) => b.ms - a.ms).slice(0, 3);
        const plans: Array<{ ms: number; sql: string; explain: string }> = [];
        for (const call of top) {
            try {
                const rows = await db.unsafe<Array<Record<string, unknown>>>(
                    `EXPLAIN (ANALYZE, BUFFERS) ${call.sql}`,
                    call.params,
                );
                plans.push({
                    ms: call.ms,
                    sql: call.sql,
                    explain: rows.map((row) => String(row["QUERY PLAN"] ?? "")).join("\n"),
                });
            } catch (error: unknown) {
                plans.push({ ms: call.ms, sql: call.sql, explain: `EXPLAIN failed: ${errorText(error)}` });
            }
        }
        return plans;
    }

    const result = {
        label: LABEL,
        scale: SCALE,
        shapes: [],
        diag: {
            eMs,
            e2Ms,
            eCalls,
            e2Calls,
            ePlans: await explainSlow(eCalls),
            e2Plans: await explainSlow(e2Calls),
        },
    };
    if (!OUT_PATH) throw new Error("BENCH_OUT is required");
    writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
    console.log(`[pg-scenario] graphql diag e=${eMs}ms stmts=${eCalls.length} e2=${e2Ms}ms stmts=${e2Calls.length}`);
    for (const call of [...eCalls, ...e2Calls].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
        console.log(`[pg-scenario] ${call.ms}ms ${call.sql.replace(/\s+/g, " ").slice(0, 200)}`);
    }
}


async function main(): Promise<void> {
    assertLgMix();
    if (!process.env.DB_CONNECTION_URL) {
        throw new Error("DB_CONNECTION_URL must be set before this process starts");
    }
    if (!OUT_PATH) throw new Error("BENCH_OUT is required");
    console.log(
        `[pg-scenario] scale=${SCALE} iterations=${ITERATIONS} warmup=${WARMUP} concurrency=${CONCURRENCY} skipShapes=${SKIP_SHAPES}`,
    );
    const seedStart = performance.now();
    await db`SELECT 1`;
    await PrepareDatabase();
    const compositeIndex = await applyCompositeIndexIfPresent();
    await ComponentRegistry.registerAllComponents();
    const seeded: SeedReport = await seedDataset(COUNTS, {
        user: new BenchUser().getTypeID(),
        product: new BenchProduct().getTypeID(),
        order: new BenchOrder().getTypeID(),
        flag: new BenchOrderFlag().getTypeID(),
        item: new BenchOrderItem().getTypeID(),
        review: new BenchReview().getTypeID(),
    });
    const seedMs = Math.round(performance.now() - seedStart);
    console.log(
        `[pg-scenario] seed done in ${seedMs}ms (insert ${seeded.insertMs}ms) entities=${seeded.entities} components=${seeded.componentRows} cancelled=${seeded.cancelled} missingScore=${seeded.missingScore} dirty=${seeded.dirtyLegacy}`,
    );
    if (process.env.BENCH_DIAG === "graphql") {
        await traceGraphql();
        return;
    }

    const tokens = await prepareTokens(new BenchProduct().getTypeID());
    const shapes: ShapeResult[] = [];
    shapeLog = shapes;
    const ratingKeys = componentKeys("BenchProduct", "rating", true);
    const scoreKeys = componentKeys("BenchProduct", "score", true);
    const userKeys = componentKeys("BenchUser", "username", false);
    const totalKeys = componentKeys("BenchOrder", "total", true);
    const legacyKeys = componentKeys("BenchProduct", "legacyScore", true);

    if (!SKIP_SHAPES) {
        await runMeasured("a-sort-rating-20", () => outcomeOf(() => ratingQuery("DESC", 20).exec()), () => capturePlan(() => ratingQuery("DESC", 20)), ratingKeys);
        await runMeasured("a-sort-rating-100", () => outcomeOf(() => ratingQuery("DESC", 100).exec()), () => capturePlan(() => ratingQuery("DESC", 100)), ratingKeys);
        await runMeasured("a-sort-rating-asc-20", () => outcomeOf(() => ratingQuery("ASC", 20).exec()), () => capturePlan(() => ratingQuery("ASC", 20)), ratingKeys);
        const username = () => asTimed(new Query().with(BenchUser).sortBy(BenchUser, "username", "ASC").take(50));
        await runMeasured("a-sort-username-asc-50", () => outcomeOf(() => username().exec()), () => capturePlan(username), userKeys);
        const score = () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "score", "DESC").take(20));
        await runMeasured("a-sort-score-desc-20", () => outcomeOf(() => score().exec()), () => capturePlan(score), scoreKeys);

        if (!hasSortByCreatedAt()) {
            shapes.push(skipped("b-created-at-20", "sortByCreatedAt absent"));
            shapes.push(skipped("b-created-at-100", "sortByCreatedAt absent"));
            shapes.push(skipped("b-created-at-review-desc-20", "sortByCreatedAt absent"));
            shapes.push(skipped("b-created-at-review-asc-20", "sortByCreatedAt absent"));
            shapes.push(skipped("b-created-at-keyset-20", "sortByCreatedAt absent"));
        } else {
            const created = (dir: "ASC" | "DESC", take: number, comp: new () => BaseComponent) =>
                asTimed(new Query().with(comp).sortByCreatedAt(dir).take(take));
            await runMeasured("b-created-at-20", () => outcomeOf(() => created("DESC", 20, BenchOrder).exec()), () => capturePlan(() => created("DESC", 20, BenchOrder)), createdAtKeys);
            await runMeasured("b-created-at-100", () => outcomeOf(() => created("DESC", 100, BenchOrder).exec()), () => capturePlan(() => created("DESC", 100, BenchOrder)), createdAtKeys);
            await runMeasured("b-created-at-review-desc-20", () => outcomeOf(() => created("DESC", 20, BenchReview).exec()), () => capturePlan(() => created("DESC", 20, BenchReview)), createdAtKeys);
            await runMeasured("b-created-at-review-asc-20", () => outcomeOf(() => created("ASC", 20, BenchReview).exec()), () => capturePlan(() => created("ASC", 20, BenchReview)), createdAtKeys);
            if (!hasSortedCursor() || !tokens.createdAtNext) {
                shapes.push(skipped("b-created-at-keyset-20", tokens.createdAtNext ? "sortedCursor absent" : "created-at token unavailable"));
            } else {
                const token = tokens.createdAtNext;
                const keyset = () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20).sortedCursor(token));
                await runMeasured("b-created-at-keyset-20", () => outcomeOf(() => keyset().exec()), () => capturePlan(keyset), createdAtKeys);
            }
        }

        const twoFilter = () => asTimed(
            new Query()
                .with(BenchOrder, { filters: [Query.filter("status", FilterOp.EQ, "delivered")] })
                .with(BenchOrderFlag, { filters: [Query.filter("fulfilled", FilterOp.EQ, true)] })
                .sortBy(BenchOrder, "total", "DESC")
                .take(20),
        );
        await runMeasured("c-two-filter-sort-20", () => outcomeOf(() => twoFilter().exec()), () => capturePlan(twoFilter), totalKeys);
        const selective = () => asTimed(
            new Query()
                .with(BenchOrder, { filters: [Query.filter("status", FilterOp.EQ, "cancelled")] })
                .sortBy(BenchOrder, "total", "DESC")
                .take(20),
        );
        await runMeasured("c-selective-filter-sort-20", () => outcomeOf(() => selective().exec()), () => capturePlan(selective), totalKeys);

        const populate = () => asTimed(new Query().with(BenchOrder).with(BenchOrderFlag).populate().take(100));
        await runMeasured("d-populate-100", () => outcomeOf(() => populate().exec()), () => capturePlan(populate));
        await runMeasured(
            "d-count-two-components",
            async () => {
                const n = await new Query().with(BenchOrder).with(BenchOrderFlag).count();
                return { ids: [`count:${n}`], rowsReturned: n };
            },
            captureCount,
        );

        try {
            const yoga = await graphqlYoga();
            await runMeasured("e-graphql-list-50", () => outcomeOf(() => yoga.fetchList()), undefined, userKeys);
            if (!headBatchApi()) {
                shapes.push(skipped(
                    "e2-graphql-list-50-batched",
                    "head-only: @ArcheTypeFunction({ batch: true }) is not on this commit",
                ));
            } else {
                await runMeasured("e2-graphql-list-50-batched", () => outcomeOf(() => yoga.fetchBatched()), undefined, userKeys);
            }
        } catch (error: unknown) {
            const message = errorText(error);
            shapes.push(errored("e-graphql-list-50", message));
            shapes.push(errored("e2-graphql-list-50-batched", message));
        }

        if (!hasSortedCursor()) {
            shapes.push(skipped("f-keyset-next-20", "sortedCursor/encodeSortedCursor absent"));
            shapes.push(skipped("f-keyset-deep-20", "sortedCursor/encodeSortedCursor absent"));
            shapes.push(skipped("f-keyset-before-20", "sortedCursor/encodeSortedCursor absent"));
            shapes.push(skipped("f-keyset-score-into-nulls", "sortedCursor/encodeSortedCursor absent"));
        } else {
            const keyset = (token: string | undefined, direction?: "before") => {
                if (!token) throw new Error("cursor token unavailable");
                const query = new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20);
                return asTimed(direction ? query.sortedCursor(token, direction) : query.sortedCursor(token));
            };
            if (!tokens.ratingNext) shapes.push(errored("f-keyset-next-20", "rating next token unavailable"));
            else {
                const token = tokens.ratingNext;
                await runMeasured("f-keyset-next-20", () => outcomeOf(() => keyset(token).exec()), () => capturePlan(() => keyset(token)), ratingKeys);
            }
            if (!tokens.ratingDeep) shapes.push(errored("f-keyset-deep-20", "rating deep token unavailable"));
            else {
                const token = tokens.ratingDeep;
                await runMeasured("f-keyset-deep-20", () => outcomeOf(() => keyset(token).exec()), () => capturePlan(() => keyset(token)), ratingKeys);
            }
            if (!tokens.ratingBefore) shapes.push(errored("f-keyset-before-20", "rating before token unavailable"));
            else {
                const token = tokens.ratingBefore;
                await runMeasured("f-keyset-before-20", () => outcomeOf(() => keyset(token, "before").exec()), () => capturePlan(() => keyset(token, "before")), ratingKeys);
            }
            if (!tokens.scoreNulls) shapes.push(errored("f-keyset-score-into-nulls", "score nulls token unavailable"));
            else {
                const token = tokens.scoreNulls;
                const scoreKeyset = () => asTimed(
                    new Query().with(BenchProduct).sortBy(BenchProduct, "score", "DESC").take(20).sortedCursor(token),
                );
                await runMeasured("f-keyset-score-into-nulls", () => outcomeOf(() => scoreKeyset().exec()), () => capturePlan(scoreKeyset), scoreKeys);
            }
        }

        const legacy = () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "legacyScore", "DESC").take(20));
        await runMeasured("g-legacyscore-sort", () => outcomeOf(() => legacy().exec()), () => capturePlan(legacy), legacyKeys);
    }

    let concurrency: ConcurrencyResult | undefined;
    if (CONCURRENCY > 0) {
        concurrency = await runConcurrency(queryJobs(tokens));
    }

    const versionRows = await db`SELECT version() AS version`;
    const pgVersion = String(versionRows[0]?.version ?? "unknown");
    const parallelRows = await db`SHOW max_parallel_workers_per_gather`;
    const maxParallelWorkersPerGather = String(parallelRows[0]?.max_parallel_workers_per_gather ?? "unknown");
    console.log(`[pg-scenario] max_parallel_workers_per_gather=${maxParallelWorkersPerGather}`);
    let commit = "unknown";
    try {
        commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
        commit = "unknown";
    }
    let packageVersion = "unknown";
    try {
        const pkg: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
        if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
            packageVersion = pkg.version;
        }
    } catch {
        packageVersion = "unknown";
    }
    const result = {
        label: LABEL,
        commit,
        packageVersion,
        scale: SCALE,
        compositeIndex,
        maxParallelWorkersPerGather,
        dataset: {
            ...COUNTS,
            flags: COUNTS.orders,
            entities: seeded.entities,
            componentRows: seeded.componentRows,
            insertMs: seeded.insertMs,
            cancelled: seeded.cancelled,
            missingScore: seeded.missingScore,
            dirtyLegacy: seeded.dirtyLegacy,
        },
        seedChecks: seeded,
        seedMs,
        pgVersion,
        bunVersion: process.versions.bun ?? "unknown",
        platform: `${platform()}-${arch()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        memoryGb: Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10,
        shapes,
        concurrency,
    };
    writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
    console.log(`[pg-scenario] wrote ${OUT_PATH}`);
}

try {
    await main();
} finally {
    await closePool();
}
