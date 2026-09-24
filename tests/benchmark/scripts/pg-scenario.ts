#!/usr/bin/env bun
/**
 * One-tree real-PostgreSQL read-path scenario.
 *
 * Invoked by compare-pg.ts with DB_CONNECTION_URL already pointing at a scratch
 * database. Uses only public APIs present on both bfa9b6b and 7255442:
 * Query.with/sortBy/sortByCreatedAt/populate/take/sortedCursor/explainAnalyze,
 * string-target @HasMany (not a thunk), non-batch @ArcheTypeFunction, and
 * archetype.registerFieldResolvers so base installs relation resolvers.
 *
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
import db from "../../../database";
import { PrepareDatabase } from "../../../database/DatabaseHelper";
import { getDbStats, resetDbStats } from "../../../database/instrumentedDb";
import { generateGraphQLSchemaV2, createYogaInstance, GraphQLOperation } from "../../../gql";
import { createRequestContextPlugin } from "../../../core/RequestContext";
import BaseService from "../../../service/Service";

class Rng {
    private state: number;
    constructor(seed: number) {
        this.state = seed;
    }
    next(): number {
        let t = this.state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    pick<T>(arr: readonly T[]): T {
        return arr[Math.floor(this.next() * arr.length)]!;
    }
    pickWeighted<T>(arr: readonly T[], weights: number[]): T {
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        let r = this.next() * total;
        for (let i = 0; i < arr.length; i++) {
            r -= weights[i]!;
            if (r <= 0) return arr[i]!;
        }
        return arr[arr.length - 1]!;
    }
    powerLaw(min: number, max: number, alpha: number): number {
        const u = this.next();
        const minP = Math.pow(min, 1 - alpha);
        const maxP = Math.pow(max, 1 - alpha);
        return Math.pow((maxP - minP) * u + minP, 1 / (1 - alpha));
    }
}

const USER_TIERS = ["free", "basic", "premium", "enterprise"] as const;
const USER_STATUSES = ["active", "inactive", "suspended"] as const;
const PRODUCT_STATUSES = ["active", "inactive", "discontinued"] as const;
const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "refunded"] as const;
const ORDER_ITEM_STATUSES = ["pending", "fulfilled", "returned", "refunded"] as const;
const PAYMENT_METHODS = ["card", "paypal", "bank", "crypto"] as const;
const REGIONS = ["us-east", "us-west", "eu-west", "ap-south"] as const;
const CATEGORIES = ["Electronics", "Home", "Sports", "Books"] as const;
const BRANDS = ["Nova", "Peak", "Lumen", "Arbor"] as const;

const SCALE = process.env.BENCH_SCALE === "smoke" ? "smoke" : "md";
const ITERATIONS = positiveInt(process.env.BENCH_ITERATIONS, SCALE === "smoke" ? 3 : 30);
const WARMUP = positiveInt(process.env.BENCH_WARMUP, SCALE === "smoke" ? 1 : 5);
const OUT_PATH = process.env.BENCH_OUT;
const LABEL = process.env.BENCH_LABEL ?? "tree";

const COUNTS = SCALE === "smoke"
    ? { users: 40, products: 40, orders: 80, orderItems: 40, reviews: 20 }
    : { users: 10000, products: 20000, orders: 30000, orderItems: 30000, reviews: 10000 };

const EPOCH_MS = Date.UTC(2024, 0, 1);
const FIRST_NAMES = ["James", "Mary", "John", "Patricia", "Alex", "Emma"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Lee", "Garcia"];

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
        // Base does not auto-attach archetype field resolvers. Head's registrar
        // is idempotent, so calling it on both commits is the shared path.
        // Cast: registerFieldResolvers mutates a string-keyed field bag; the service class has no index signature.
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
            // Resolvers read parent.id only. The archetype is not hydrated here.
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

interface TimedQuery {
    debugMode(enabled?: boolean): TimedQuery;
    explainAnalyze(buffers?: boolean): Promise<string>;
    exec(): Promise<Array<{ id: string }>>;
}

interface EntityInsert {
    id: string;
    created_at: Date;
    updated_at: Date;
}

interface ComponentInsert {
    id: string;
    entity_id: string;
    type_id: string;
    name: string;
    data: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
}

function positiveInt(raw: string | undefined, fallback: number): number {
    const n = parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function detUuid(n: number): string {
    const hex = createHash("sha256").update(`bunsane-bench-v1:${n}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx] ?? 0;
}

let idSeq = 1;
function nextId(): string {
    const id = detUuid(idSeq);
    idSeq += 1;
    return id;
}

async function insertBatch(table: "entities" | "components", rows: EntityInsert[] | ComponentInsert[]): Promise<void> {
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
        const batch = rows.slice(i, i + chunk);
        // Bun.SQL's helper wants an index signature; the row interfaces are fixed keys.
        const sqlRows = batch as unknown as Array<{ [key: string]: unknown }>;
        if (table === "entities") {
            await db`INSERT INTO entities ${db(sqlRows, "id", "created_at", "updated_at")}`;
        } else {
            await db`INSERT INTO components ${db(sqlRows, "id", "entity_id", "type_id", "name", "data", "created_at", "updated_at")}`;
        }
    }
}

function pushComponent(
    components: ComponentInsert[],
    entityId: string,
    ctor: new () => BaseComponent,
    name: string,
    data: Record<string, unknown>,
    at: Date,
): void {
    components.push({
        id: nextId(),
        entity_id: entityId,
        type_id: new ctor().getTypeID(),
        name,
        data,
        created_at: at,
        updated_at: at,
    });
}

async function seed(): Promise<{ entities: number; componentRows: number }> {
    const rng = new Rng(42);
    const entities: EntityInsert[] = [];
    const components: ComponentInsert[] = [];
    const userIds: string[] = [];
    const productIds: string[] = [];
    const orderIds: string[] = [];

    for (let i = 0; i < COUNTS.users; i++) {
        const id = nextId();
        const at = new Date(EPOCH_MS + i * 1000);
        userIds.push(id);
        entities.push({ id, created_at: at, updated_at: at });
        const first = FIRST_NAMES[i % FIRST_NAMES.length] ?? "Alex";
        const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length] ?? "Lee";
        pushComponent(components, id, BenchUser, "BenchUser", {
            email: `${first.toLowerCase()}${last.toLowerCase()}${i}@example.com`,
            username: `${first.toLowerCase()}${last.toLowerCase()}${i}`,
            status: rng.pickWeighted(USER_STATUSES, [0.85, 0.12, 0.03]),
            tier: rng.pickWeighted(USER_TIERS, [0.6, 0.25, 0.12, 0.03]),
            region: rng.pick(REGIONS),
            orderCount: 0,
        }, at);
    }

    for (let i = 0; i < COUNTS.products; i++) {
        const id = nextId();
        const at = new Date(EPOCH_MS + (COUNTS.users + i) * 1000);
        productIds.push(id);
        entities.push({ id, created_at: at, updated_at: at });
        const category = rng.pick(CATEGORIES);
        pushComponent(components, id, BenchProduct, "BenchProduct", {
            sku: `${category.slice(0, 3).toUpperCase()}-${String(i).padStart(6, "0")}`,
            name: `${rng.pick(BRANDS)} ${category} ${i}`,
            category,
            status: rng.pickWeighted(PRODUCT_STATUSES, [0.85, 0.1, 0.05]),
            price: Math.floor(rng.powerLaw(10, 1000, 1.2)),
            rating: Math.round((3 + rng.next() * 2) * 10) / 10,
        }, at);
    }

    for (let i = 0; i < COUNTS.orders; i++) {
        const id = nextId();
        const at = new Date(EPOCH_MS + (COUNTS.users + COUNTS.products + i) * 1000);
        const userId = userIds[Math.floor(rng.next() * userIds.length)] ?? userIds[0]!;
        const status = rng.pickWeighted(ORDER_STATUSES, [0.05, 0.1, 0.15, 0.6, 0.07, 0.03]);
        orderIds.push(id);
        entities.push({ id, created_at: at, updated_at: at });
        pushComponent(components, id, BenchOrder, "BenchOrder", {
            userId,
            status,
            paymentMethod: rng.pick(PAYMENT_METHODS),
            total: Math.floor(rng.powerLaw(20, 500, 1.3)),
            orderNumber: `ORD-${String(i).padStart(6, "0")}`,
        }, at);
        // Independent of status so the two-component filter is a real intersect.
        pushComponent(components, id, BenchOrderFlag, "BenchOrderFlag", {
            fulfilled: rng.next() < 0.3,
            channel: rng.next() < 0.5 ? "web" : "store",
        }, at);
    }

    for (let i = 0; i < COUNTS.orderItems; i++) {
        const id = nextId();
        const at = new Date(EPOCH_MS + (COUNTS.users + COUNTS.products + COUNTS.orders + i) * 1000);
        entities.push({ id, created_at: at, updated_at: at });
        pushComponent(components, id, BenchOrderItem, "BenchOrderItem", {
            orderId: orderIds[i % orderIds.length] ?? orderIds[0]!,
            productId: productIds[Math.floor(rng.next() * productIds.length)] ?? productIds[0]!,
            status: rng.pick(ORDER_ITEM_STATUSES),
        }, at);
    }

    for (let i = 0; i < COUNTS.reviews; i++) {
        const id = nextId();
        const at = new Date(EPOCH_MS + (COUNTS.users + COUNTS.products + COUNTS.orders + COUNTS.orderItems + i) * 1000);
        entities.push({ id, created_at: at, updated_at: at });
        pushComponent(components, id, BenchReview, "BenchReview", {
            productId: productIds[Math.floor(rng.next() * productIds.length)] ?? productIds[0]!,
            rating: Math.round((1 + rng.next() * 4) * 10) / 10,
        }, at);
    }

    console.log(`[pg-scenario] inserting ${entities.length} entities / ${components.length} components`);
    await insertBatch("entities", entities);
    await insertBatch("components", components);
    await db`ANALYZE entities`;
    await db`ANALYZE components`;
    return { entities: entities.length, componentRows: components.length };
}

async function timeShape(
    name: string,
    run: () => Promise<unknown[]>,
    capture?: () => Promise<{ sql?: string; explain?: string }>,
): Promise<ShapeResult> {
    for (let i = 0; i < WARMUP; i++) await run();
    const times: number[] = [];
    let statements = 0;
    let rowsReturned = 0;
    for (let i = 0; i < ITERATIONS; i++) {
        resetDbStats();
        const start = performance.now();
        const rows = await run();
        times.push(performance.now() - start);
        statements += getDbStats().totalCount;
        rowsReturned = rows.length;
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
    const result: ShapeResult = {
        name,
        iterations: ITERATIONS,
        warmup: WARMUP,
        rowsReturned,
        p50Ms: round2(percentile(sorted, 0.5)),
        p95Ms: round2(percentile(sorted, 0.95)),
        meanMs: round2(mean),
        minMs: round2(sorted[0] ?? 0),
        maxMs: round2(sorted[sorted.length - 1] ?? 0),
        statementsPerIter: round2(statements / times.length),
        sql,
        explain,
    };
    console.log(
        `[pg-scenario] ${name} rows=${rowsReturned} p50=${result.p50Ms}ms p95=${result.p95Ms}ms stmts=${result.statementsPerIter}`,
    );
    return result;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

async function capturePlan(build: () => TimedQuery): Promise<{ sql?: string; explain?: string }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    try {
        await build().debugMode(true).exec();
    } finally {
        console.log = original;
    }
    const sqlLine = lines.find((line) => line.startsWith("SQL:"));
    let explain: string | undefined;
    try {
        explain = await build().explainAnalyze(true);
    } catch (error: unknown) {
        explain = `EXPLAIN failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { sql: sqlLine?.slice(4).trim(), explain };
}

function asTimed(query: object): TimedQuery {
    // Fluent Query return types differ across the two commits; the methods do not.
    return query as unknown as TimedQuery;
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

function headBatchApi(): boolean {
    // core/archetype/functionReturn.ts shipped with batch:true. Absent on bfa9b6b.
    return existsSync(fileURLToPath(new URL("../../../core/archetype/functionReturn.ts", import.meta.url)));
}

async function ratingCursorToken(): Promise<string> {
    const page1 = await new Query()
        .with(BenchProduct)
        .sortBy(BenchProduct, "rating", "DESC")
        .take(20)
        .exec();
    const last = page1[page1.length - 1];
    if (!last) throw new Error("keyset page 1 was empty");
    const ratingRows = await db`
        SELECT (data->>'rating')::float8 AS rating
        FROM components
        WHERE entity_id = ${last.id}::uuid AND name = 'BenchProduct'
        LIMIT 1
    `;
    const rating = Number(ratingRows[0]?.rating);
    if (!Number.isFinite(rating)) throw new Error(`missing rating for ${last.id}`);
    return Query.encodeSortedCursor(rating, last.id);
}

function keysetNext(token: string): Promise<Array<{ id: string }>> {
    return new Query()
        .with(BenchProduct)
        .sortBy(BenchProduct, "rating", "DESC")
        .take(20)
        .sortedCursor(token)
        .exec();
}

function skipped(name: string, reason: string): ShapeResult {
    console.log(`[pg-scenario] ${name} skipped: ${reason}`);
    return {
        name,
        skipped: reason,
        iterations: 0,
        warmup: 0,
        rowsReturned: 0,
        p50Ms: 0,
        p95Ms: 0,
        meanMs: 0,
        minMs: 0,
        maxMs: 0,
        statementsPerIter: 0,
    };
}

function hasSortByCreatedAt(): boolean {
    return typeof new Query().sortByCreatedAt === "function";
}

function hasSortedCursor(): boolean {
    return typeof new Query().sortedCursor === "function" && typeof Query.encodeSortedCursor === "function";
}

async function closePool(): Promise<void> {
    const closer = db as unknown as { close?: () => Promise<void>; end?: () => Promise<void> };
    if (closer.close) await closer.close();
    else if (closer.end) await closer.end();
}

async function main(): Promise<void> {
    if (!process.env.DB_CONNECTION_URL) {
        throw new Error("DB_CONNECTION_URL must be set before this process starts");
    }
    const seedStart = performance.now();
    await db`SELECT 1`;
    await PrepareDatabase();
    await ComponentRegistry.registerAllComponents();
    const seeded = await seed();
    const seedMs = Math.round(performance.now() - seedStart);
    console.log(`[pg-scenario] seed done in ${seedMs}ms`);

    const shapes: ShapeResult[] = [];

    shapes.push(await timeShape(
        "a-sort-rating-20",
        () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20)).exec(),
        () => capturePlan(() => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20))),
    ));
    shapes.push(await timeShape(
        "a-sort-rating-100",
        () => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(100)).exec(),
        () => capturePlan(() => asTimed(new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(100))),
    ));

    if (!hasSortByCreatedAt()) {
        shapes.push(skipped("b-created-at-20", "sortByCreatedAt absent"));
        shapes.push(skipped("b-created-at-100", "sortByCreatedAt absent"));
    } else {
        shapes.push(await timeShape(
            "b-created-at-20",
            () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20)).exec(),
            () => capturePlan(() => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(20))),
        ));
        shapes.push(await timeShape(
            "b-created-at-100",
            () => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(100)).exec(),
            () => capturePlan(() => asTimed(new Query().with(BenchOrder).sortByCreatedAt("DESC").take(100))),
        ));
    }

    const twoFilter = () => new Query()
        .with(BenchOrder, { filters: [Query.filter("status", FilterOp.EQ, "delivered")] })
        .with(BenchOrderFlag, { filters: [Query.filter("fulfilled", FilterOp.EQ, true)] })
        .sortBy(BenchOrder, "total", "DESC")
        .take(20);
    shapes.push(await timeShape(
        "c-two-filter-sort-20",
        () => asTimed(twoFilter()).exec(),
        () => capturePlan(() => asTimed(twoFilter())),
    ));

    shapes.push(await timeShape(
        "d-populate-100",
        () => asTimed(
            new Query().with(BenchOrder).with(BenchOrderFlag).populate().take(100),
        ).exec(),
        () => capturePlan(() => asTimed(new Query().with(BenchOrder).with(BenchOrderFlag).populate().take(100))),
    ));

    try {
        const yoga = await graphqlYoga();
        shapes.push(await timeShape("e-graphql-list-50", () => yoga.fetchList()));
        if (!headBatchApi()) {
            shapes.push(skipped(
                "e2-graphql-list-50-batched",
                "head-only: @ArcheTypeFunction({ batch: true }) is not on this commit",
            ));
        } else {
            shapes.push(await timeShape("e2-graphql-list-50-batched", () => yoga.fetchBatched()));
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        shapes.push({ ...skipped("e-graphql-list-50", message), error: message });
    }

    if (!hasSortedCursor()) {
        shapes.push(skipped("f-keyset-next-20", "sortedCursor/encodeSortedCursor absent"));
    } else {
        try {
            const token = await ratingCursorToken();
            shapes.push(await timeShape(
                "f-keyset-next-20",
                () => keysetNext(token),
                () => capturePlan(() => asTimed(
                    new Query().with(BenchProduct).sortBy(BenchProduct, "rating", "DESC").take(20).sortedCursor(token),
                )),
            ));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            shapes.push({ ...skipped("f-keyset-next-20", message), error: message });
        }
    }

    const versionRows = await db`SELECT version() AS version`;
    const pgVersion = String(versionRows[0]?.version ?? "unknown");
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
    const cpu = cpus()[0]?.model ?? "unknown";
    const result = {
        label: LABEL,
        commit,
        packageVersion,
        scale: SCALE,
        dataset: { ...COUNTS, flags: COUNTS.orders, entities: seeded.entities, componentRows: seeded.componentRows },
        seedMs,
        pgVersion,
        bunVersion: process.versions.bun ?? "unknown",
        platform: `${platform()}-${arch()}`,
        cpu,
        memoryGb: Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10,
        shapes,
    };
    if (!OUT_PATH) throw new Error("BENCH_OUT is required");
    writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
    console.log(`[pg-scenario] wrote ${OUT_PATH}`);
    await closePool();
}

await main();
