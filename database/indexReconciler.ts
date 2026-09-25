/**
 * Key-index DDL reconciler (docs/internal/RFC_INDEX_DRIVEN_LISTS.md, D1–D2).
 *
 * Desired `bk_` indexes come from `keyIndexSpec` (expressions from
 * `query/orderPlan`). This module is the only writer of those indexes, and
 * the only dropper of the legacy per-field names they replace.
 */
import { createHash } from "crypto";
import { logger as MainLogger } from "../core/Logger";
import { getMetadataStorage } from "../core/metadata";
import { withLock } from "../core/scheduler/withLock";
import { NUMERIC_KEY_FN, NUMERIC_KEY_FN_DDL } from "../query/orderPlan";
import { DDL_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "./index";
import { dbExec } from "./gateway";
import {
    KEY_INDEX_PREFIX,
    componentKeyIndexSpecs,
    entityKeyIndexSpecs,
    keyFieldsOf,
    type KeyIndexSpec,
} from "./keyIndexSpec";

const logger = MainLogger.child({ scope: "indexReconciler" });

const LOCK_KEY = "bunsane:index-reconcile";
const DEFAULT_SYNC_MAX_ROWS = 100_000;
const PG_IDENT_MAX = 63;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LEGACY_SUFFIXES = ["_btree", "_btree_date", "_numeric", "_gin"] as const;

const catalogQuery = <T>(label: string, sql: string): Promise<T> =>
    dbExec<T>(sql, undefined, { lane: "background", label, timeoutMs: QUERY_TIMEOUT_MS });

const ddlStatement = <T>(label: string, sql: string): Promise<T> =>
    dbExec<T>(sql, undefined, { lane: "background", label, timeoutMs: DDL_TIMEOUT_MS });

export interface KeyIndexComponent {
    name: string;
    table: string;
    strategy: "list" | "hash";
}

export interface CatalogIndex {
    name: string;
    table: string;
    valid: boolean;
}

export interface IndexDrop {
    name: string;
    table: string;
    concurrently: boolean;
    reason: "invalid" | "obsolete" | "legacy";
    /** Skip this drop unless this replacement is valid. */
    replacedBy?: string;
    /** Skip unless every named index is valid (`rm_` `__cover`). */
    requireValid?: readonly string[];
}

export interface IndexCreate {
    spec: KeyIndexSpec;
    concurrently: boolean;
}

export interface ReconcilePlan {
    /** Invalid desired indexes. Must run before create of the same name. */
    dropBeforeCreate: IndexDrop[];
    create: IndexCreate[];
    /** Obsolete `bk_` indexes and legacy names, after replacements are valid. */
    dropAfter: IndexDrop[];
    /** Tables that received a new index and need expression stats. */
    analyze: string[];
}

export interface LegacyDropSpec {
    table: string;
    name: string;
    replacedBy: string;
}

/** ≤ 63 bytes. Short names are unchanged so existing gin/hash/fulltext indexes still match. */
export function boundIndexName(name: string): string {
    if (Buffer.byteLength(name) <= PG_IDENT_MAX) return name;
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
    const room = PG_IDENT_MAX - 1 - 8;
    let prefix = name;
    while (Buffer.byteLength(prefix) > room) prefix = prefix.slice(0, -1);
    prefix = prefix.replace(/_+$/, "");
    const bounded = prefix.length === 0 ? `i_${hash}` : `${prefix}_${hash}`;
    return Buffer.byteLength(bounded) <= PG_IDENT_MAX ? bounded : bounded.slice(0, PG_IDENT_MAX);
}

/**
 * PostgreSQL stores over-long unquoted identifiers truncated to 63 bytes.
 * Legacy drops must look up that form, not a new hash.
 */
export function pgTruncatedIdent(name: string): string {
    if (Buffer.byteLength(name) <= PG_IDENT_MAX) return name;
    let bytes = 0;
    let i = 0;
    for (; i < name.length; i++) {
        const width = Buffer.byteLength(name[i]!);
        if (bytes + width > PG_IDENT_MAX) break;
        bytes += width;
    }
    return name.slice(0, i);
}

const LEGACY_GIN = "_gin";
const LARGE_RELATION_BYTES = 64 * 1024 * 1024;
const HASH_SUFFIX = /_[0-9a-f]{8}$/;

/** Historical per-field names a valid `bk_` replacement supersedes. Lowercased: PG folds unquoted idents. */
export function legacyIndexNames(table: string, field: string, includeGin = true): string[] {
    const base = `idx_${table}_${field}`.toLowerCase();
    const suffixes = includeGin
        ? LEGACY_SUFFIXES
        : LEGACY_SUFFIXES.filter((suffix) => suffix !== LEGACY_GIN);
    return suffixes.map((suffix) => pgTruncatedIdent(`${base}${suffix}`));
}

/** `bk_<slug>_<hash8>` → `<slug>`. Distinguishes a definition change from another field. */
export function keyIndexSlug(name: string): string {
    const body = name.startsWith(KEY_INDEX_PREFIX) ? name.slice(KEY_INDEX_PREFIX.length) : name;
    return HASH_SUFFIX.test(body) ? body.slice(0, -9) : body;
}

export function indexSyncMaxRows(): number {
    const raw = process.env.BUNSANE_INDEX_SYNC_MAX_ROWS;
    if (raw == null || raw.trim() === "") return DEFAULT_SYNC_MAX_ROWS;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_SYNC_MAX_ROWS;
}

/**
 * Known `reltuples` uses the row threshold. Negative or unknown stats fall
 * back to relation size: above 64MB is large. Missing size still counts as small.
 */
export function tableIsSmall(
    reltuples: number | null,
    maxRows: number = indexSyncMaxRows(),
    bytes: number | null = null,
): boolean {
    if (reltuples != null && Number.isFinite(reltuples) && reltuples >= 0) return reltuples < maxRows;
    if (bytes != null && Number.isFinite(bytes) && bytes > LARGE_RELATION_BYTES) return false;
    return true;
}

/** A create race is unknown, not success. Drops wait for `indisvalid`. */
export function replacementAllowsDrop(
    outcome: "created" | "unknown" | "failed" | "existing",
    valid: boolean | undefined,
): boolean {
    if (outcome === "unknown" || outcome === "failed") return false;
    return valid === true;
}

function quoteIdent(name: string): string {
    if (!IDENT.test(name) || Buffer.byteLength(name) > PG_IDENT_MAX) {
        throw new Error(`Invalid identifier: ${name}`);
    }
    return name;
}

function sqlList(names: readonly string[]): string {
    return names.map((name) => `'${quoteIdent(name)}'`).join(", ");
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
    const e = error as { code?: unknown; errno?: unknown } | null;
    if (typeof e?.code === "string") return e.code;
    if (typeof e?.errno === "string") return e.errno;
    return undefined;
}

function isDuplicateFunction(error: unknown): boolean {
    const code = errorCode(error);
    const message = errorText(error);
    return code === "42723"
        || message.includes("tuple concurrently updated")
        || message.includes("already exists");
}

function isBenignIndexRace(error: unknown): boolean {
    const code = errorCode(error);
    const message = errorText(error);
    return code === "42P07"
        || code === "42710"
        || message.includes("already exists")
        || message.includes("duplicate key value violates unique constraint")
        || message.includes("tuple concurrently updated");
}


/**
 * Create `bunsane_num_v1` if `pg_proc` does not already have it.
 * Never `CREATE OR REPLACE` — a behaviour change is `_v2`.
 * Concurrent boots: 42723 duplicate_function and "tuple concurrently updated" are success.
 */
export async function ensureNumericKeyFunction(): Promise<void> {
    const rows = await catalogQuery<Array<{ ok: number }>>(
        "schema.numericKeyFn.exists",
        `SELECT 1 AS ok FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '${quoteIdent(NUMERIC_KEY_FN)}'`,
    );
    if (rows.length > 0) return;
    try {
        await ddlStatement("schema.numericKeyFn.create", NUMERIC_KEY_FN_DDL);
        logger.info(`Created ${NUMERIC_KEY_FN}`);
    } catch (error) {
        if (isDuplicateFunction(error)) return;
        throw error;
    }
}

export function planKeyIndexReconcile(input: {
    desired: readonly KeyIndexSpec[];
    catalog: readonly CatalogIndex[];
    ownedTables: readonly string[];
    legacy: readonly LegacyDropSpec[];
    useConcurrently: (table: string) => boolean;
    /**
     * True when `desired` is the complete set for each owned table (full boot,
     * or every component that shares a HASH parent). False drops only a
     * different hash of a desired slug, so a late register cannot delete
     * another component's index.
     */
    dropUndesired?: boolean;
    coverIndexes?: readonly { table: string; name: string }[];
}): ReconcilePlan {
    const desiredByName = new Map<string, KeyIndexSpec>();
    for (const spec of input.desired) desiredByName.set(spec.name, spec);
    const owned = new Set(input.ownedTables);
    const catalogKey = (table: string, name: string) => `${table}\0${name}`;
    const byKey = new Map<string, CatalogIndex>();
    for (const row of input.catalog) byKey.set(catalogKey(row.table, row.name), row);

    const dropBeforeCreate: IndexDrop[] = [];
    const create: IndexCreate[] = [];
    const dropAfter: IndexDrop[] = [];
    const analyze = new Set<string>();
    const seenAfter = new Set<string>();

    const pushAfter = (drop: IndexDrop): void => {
        const key = `${drop.table}\0${drop.name}`;
        if (seenAfter.has(key)) return;
        seenAfter.add(key);
        dropAfter.push(drop);
    };

    for (const spec of desiredByName.values()) {
        const existing = byKey.get(catalogKey(spec.table, spec.name));
        const concurrently = input.useConcurrently(spec.table);
        if (existing?.valid) continue;
        if (existing && !existing.valid) {
            dropBeforeCreate.push({
                name: spec.name,
                table: spec.table,
                concurrently,
                reason: "invalid",
            });
        }
        create.push({ spec, concurrently });
        analyze.add(spec.table);
    }

    const desiredNames = new Set(desiredByName.keys());
    const replacementBySlug = new Map<string, string>();
    for (const spec of desiredByName.values()) {
        replacementBySlug.set(`${spec.table}\0${keyIndexSlug(spec.name)}`, spec.name);
    }
    for (const row of input.catalog) {
        if (!owned.has(row.table)) continue;
        if (!row.name.startsWith(KEY_INDEX_PREFIX)) continue;
        if (desiredNames.has(row.name)) continue;
        if (!IDENT.test(row.name) || Buffer.byteLength(row.name) > PG_IDENT_MAX) continue;
        const replacedBy = replacementBySlug.get(`${row.table}\0${keyIndexSlug(row.name)}`);
        if (!input.dropUndesired && !replacedBy) continue;
        pushAfter({
            name: row.name,
            table: row.table,
            concurrently: input.useConcurrently(row.table),
            reason: "obsolete",
            replacedBy,
        });
    }

    for (const legacy of input.legacy) {
        if (!byKey.has(catalogKey(legacy.table, legacy.name))) continue;
        const spec = desiredByName.get(legacy.replacedBy);
        if (!spec || spec.table !== legacy.table) continue;
        const existing = byKey.get(catalogKey(spec.table, spec.name));
        const willCreate = create.some((item) => item.spec.name === spec.name && item.spec.table === spec.table);
        if (!willCreate && existing?.valid !== true) continue;
        if (!IDENT.test(legacy.name)) continue;
        pushAfter({
            name: legacy.name,
            table: legacy.table,
            concurrently: input.useConcurrently(legacy.table),
            reason: "legacy",
            replacedBy: spec.name,
        });
    }

    for (const cover of input.coverIndexes ?? []) {
        if (!byKey.has(catalogKey(cover.table, cover.name))) continue;
        if (!IDENT.test(cover.name)) continue;
        const requireValid = [...desiredByName.values()]
            .filter((spec) => spec.table === cover.table)
            .map((spec) => spec.name);
        if (requireValid.length === 0) continue;
        pushAfter({
            name: cover.name,
            table: cover.table,
            concurrently: input.useConcurrently(cover.table),
            reason: "legacy",
            requireValid,
        });
    }

    return {
        dropBeforeCreate,
        create,
        dropAfter,
        analyze: [...analyze],
    };
}

function filterPlan(plan: ReconcilePlan, tables: ReadonlySet<string>): ReconcilePlan {
    const keep = (table: string) => tables.has(table);
    return {
        dropBeforeCreate: plan.dropBeforeCreate.filter((drop) => keep(drop.table)),
        create: plan.create.filter((item) => keep(item.spec.table)),
        dropAfter: plan.dropAfter.filter((drop) => keep(drop.table)),
        analyze: plan.analyze.filter(keep),
    };
}


interface TableStat {
    reltuples: number | null;
    bytes: number | null;
    partitioned: boolean;
}

async function readCatalog(tables: readonly string[]): Promise<CatalogIndex[]> {
    if (tables.length === 0) return [];
    const rows = await catalogQuery<Array<{ index_name: string; table_name: string; valid: unknown }>>(
        "index.reconcile.catalog",
        `SELECT c.relname AS index_name, t.relname AS table_name, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname IN (${sqlList(tables)})`,
    );
    return rows.map((row) => ({
        name: row.index_name,
        table: row.table_name,
        valid: row.valid === true || row.valid === "t" || row.valid === "true" || row.valid === 1,
    }));
}

async function readTableStats(tables: readonly string[]): Promise<Map<string, TableStat>> {
    const stats = new Map<string, TableStat>();
    for (const table of tables) stats.set(table, { reltuples: null, bytes: null, partitioned: false });
    if (tables.length === 0) return stats;
    const list = sqlList(tables);
    const rows = await catalogQuery<Array<{ relname: string; relkind: string; reltuples: unknown; bytes: unknown }>>(
        "index.reconcile.reltuples",
        `SELECT c.relname, c.relkind, c.reltuples, pg_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN (${list})`,
    );
    for (const row of rows) {
        const reltuples = Number(row.reltuples);
        const bytes = Number(row.bytes);
        stats.set(row.relname, {
            partitioned: row.relkind === "p",
            reltuples: Number.isFinite(reltuples) ? reltuples : null,
            bytes: Number.isFinite(bytes) ? bytes : null,
        });
    }
    const children = await catalogQuery<Array<{ parent: string; reltuples: unknown; bytes: unknown }>>(
        "index.reconcile.childtuples",
        `SELECT parent.relname AS parent, child.reltuples, pg_relation_size(child.oid) AS bytes
         FROM pg_inherits i
         JOIN pg_class parent ON parent.oid = i.inhparent
         JOIN pg_class child ON child.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = parent.relnamespace
         WHERE n.nspname = 'public' AND parent.relname IN (${list})`,
    );
    const byParent = new Map<string, { reltuples: number; bytes: number }[]>();
    for (const row of children) {
        const values = byParent.get(row.parent) ?? [];
        values.push({ reltuples: Number(row.reltuples), bytes: Number(row.bytes) });
        byParent.set(row.parent, values);
    }
    for (const [parent, values] of byParent) {
        const stat = stats.get(parent);
        if (!stat) continue;
        stat.partitioned = true;
        stat.bytes = values.reduce((sum, value) => sum + (Number.isFinite(value.bytes) && value.bytes >= 0 ? value.bytes : 0), 0);
        if (values.length === 0 || values.some((value) => !Number.isFinite(value.reltuples) || value.reltuples < 0)) {
            stat.reltuples = -1;
        } else {
            stat.reltuples = values.reduce((sum, value) => sum + value.reltuples, 0);
        }
    }
    return stats;
}

function useConcurrently(table: string, stats: ReadonlyMap<string, TableStat>): boolean {
    if (process.env.USE_PGLITE === "true") return false;
    if (stats.get(table)?.partitioned) return false;
    return true;
}

function specsFor(
    components: readonly KeyIndexComponent[],
    includeEntities: boolean,
): { specs: KeyIndexSpec[]; legacy: LegacyDropSpec[]; tables: string[] } {
    const specs: KeyIndexSpec[] = [];
    const legacy: LegacyDropSpec[] = [];
    const tables = new Set<string>();
    if (includeEntities) {
        for (const spec of entityKeyIndexSpecs()) {
            specs.push(spec);
            tables.add(spec.table);
        }
    }
    for (const component of components) {
        const componentSpecs = componentKeyIndexSpecs(component.name, component.table, component.strategy);
        specs.push(...componentSpecs);
        tables.add(component.table);
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(component.name);
        const compDataScalar = new Set(
            storage.getComponentProperties(typeId)
                .filter((prop) => prop.indexed && prop.arrayOf == null)
                .map((prop) => prop.propertyKey),
        );
        const explicitGin = new Set(
            storage.getIndexedFields(typeId)
                .filter((field) => field.indexType === "gin")
                .map((field) => field.propertyKey),
        );
        for (const field of keyFieldsOf(component.name)) {
            const spec = componentSpecs.find((item) => item.fields.length === 1 && item.fields[0] === field);
            if (!spec) continue;
            const includeGin = compDataScalar.has(field) && !explicitGin.has(field);
            for (const name of legacyIndexNames(component.table, field, includeGin)) {
                legacy.push({ table: component.table, name, replacedBy: spec.name });
            }
        }
    }
    return { specs, legacy, tables: [...tables] };
}

async function dropIndex(drop: IndexDrop): Promise<boolean> {
    const name = quoteIdent(drop.name);
    const sql = `DROP INDEX${drop.concurrently ? " CONCURRENTLY" : ""} IF EXISTS ${name}`;
    const started = performance.now();
    try {
        await ddlStatement("index.reconcile.drop", sql);
        logger.info(
            `Dropped ${drop.reason} index ${name} on ${drop.table} in ${Math.round(performance.now() - started)}ms`,
        );
        return true;
    } catch (error) {
        logger.warn(`Failed to drop ${drop.reason} index ${name} on ${drop.table}: ${errorText(error)}`);
        return false;
    }
}

type CreateOutcome = "created" | "unknown" | "failed";

async function createIndex(item: IndexCreate): Promise<CreateOutcome> {
    const sql = item.spec.createSql(item.concurrently);
    const started = performance.now();
    try {
        await ddlStatement("index.reconcile.create", sql);
        logger.info(
            `Created key index ${item.spec.name} on ${item.spec.table} in ${Math.round(performance.now() - started)}ms` +
            `${item.concurrently ? " (concurrently)" : ""}`,
        );
        return "created";
    } catch (error) {
        if (isBenignIndexRace(error)) {
            logger.info(`Key index ${item.spec.name} already exists; not treating it as valid this pass`);
            return "unknown";
        }
        logger.error(
            `Failed to create key index ${item.spec.name} on ${item.spec.table} (retried next boot): ${errorText(error)}`,
        );
        return "failed";
    }
}

async function readIndexValidity(names: readonly string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const safe = names.filter((name) => IDENT.test(name) && Buffer.byteLength(name) <= PG_IDENT_MAX);
    if (safe.length === 0) return out;
    const rows = await catalogQuery<Array<{ index_name: string; valid: unknown }>>(
        "index.reconcile.valid",
        `SELECT c.relname AS index_name, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN (${sqlList(safe)})`,
    );
    for (const row of rows) {
        out.set(
            row.index_name,
            row.valid === true || row.valid === "t" || row.valid === "true" || row.valid === 1,
        );
    }
    return out;
}

function dropBlocked(
    drop: IndexDrop,
    outcomes: ReadonlyMap<string, CreateOutcome>,
    validNow: ReadonlyMap<string, boolean>,
): boolean {
    const names = [
        ...(drop.replacedBy ? [drop.replacedBy] : []),
        ...(drop.requireValid ?? []),
    ];
    for (const name of names) {
        const outcome = outcomes.get(name) ?? "existing";
        if (!replacementAllowsDrop(outcome, validNow.get(name))) return true;
    }
    return false;
}

async function analyzeTable(table: string): Promise<void> {
    const started = performance.now();
    try {
        await ddlStatement("index.reconcile.analyze", `ANALYZE ${quoteIdent(table)}`);
        logger.info(`ANALYZE ${table} after key indexes in ${Math.round(performance.now() - started)}ms`);
    } catch (error) {
        logger.warn(`Failed to ANALYZE ${table} after key indexes: ${errorText(error)}`);
    }
}

async function executePlan(plan: ReconcilePlan): Promise<void> {
    if (
        plan.dropBeforeCreate.length === 0
        && plan.create.length === 0
        && plan.dropAfter.length === 0
    ) {
        return;
    }
    const started = performance.now();
    const failedDrops = new Set<string>();
    for (const drop of plan.dropBeforeCreate) {
        if (stopRequested) return;
        const ok = await dropIndex(drop);
        if (!ok) failedDrops.add(`${drop.table}\0${drop.name}`);
    }
    const outcomes = new Map<string, CreateOutcome>();
    const createdTables = new Set<string>();
    for (const item of plan.create) {
        if (stopRequested) return;
        if (failedDrops.has(`${item.spec.table}\0${item.spec.name}`)) {
            outcomes.set(item.spec.name, "failed");
            continue;
        }
        const outcome = await createIndex(item);
        outcomes.set(item.spec.name, outcome);
        if (outcome === "created") createdTables.add(item.spec.table);
    }
    const toCheck: string[] = [];
    for (const drop of plan.dropAfter) {
        if (drop.replacedBy) toCheck.push(drop.replacedBy);
        if (drop.requireValid) toCheck.push(...drop.requireValid);
    }
    const validNow = await readIndexValidity(toCheck);
    for (const drop of plan.dropAfter) {
        if (stopRequested) return;
        if (dropBlocked(drop, outcomes, validNow)) {
            logger.info(`Keeping ${drop.name} on ${drop.table}; replacement is not valid yet`);
            continue;
        }
        await dropIndex(drop);
    }
    for (const table of plan.analyze) {
        if (stopRequested) return;
        if (!createdTables.has(table)) continue;
        await analyzeTable(table);
    }
    logger.info(`Key index reconcile pass finished in ${Math.round(performance.now() - started)}ms`);
}

interface PreparedReconcile {
    specs: readonly KeyIndexSpec[];
    legacy: readonly LegacyDropSpec[];
    tables: readonly string[];
    dropUndesired: boolean;
    coverIndexes: readonly { table: string; name: string }[];
}

interface DeferredWork {
    prepared: PreparedReconcile;
}

let deferred: DeferredWork[] = [];
let inflight: Promise<void> | null = null;
let startTimer: NodeJS.Timeout | null = null;
let stopRequested = false;
let stopping: Promise<void> | null = null;
/** Set once App.init() has handed off, so later queues start after boot. */
let handoff = false;

function statIsSmall(stat: TableStat | undefined): boolean {
    return tableIsSmall(stat?.reltuples ?? null, indexSyncMaxRows(), stat?.bytes ?? null);
}

function planTouchesTable(plan: ReconcilePlan, table: string): boolean {
    for (const drop of plan.dropBeforeCreate) if (drop.table === table) return true;
    for (const item of plan.create) if (item.spec.table === table) return true;
    for (const drop of plan.dropAfter) if (drop.table === table) return true;
    return false;
}

async function executeDeferred(item: DeferredWork): Promise<void> {
    await ensureNumericKeyFunction();
    const prepared = item.prepared;
    const tables = [...prepared.tables];
    if (tables.length === 0) return;
    const [catalog, stats] = await Promise.all([readCatalog(tables), readTableStats(tables)]);
    const plan = planKeyIndexReconcile({
        desired: prepared.specs,
        catalog,
        ownedTables: tables,
        legacy: prepared.legacy,
        useConcurrently: (table) => useConcurrently(table, stats),
        dropUndesired: prepared.dropUndesired,
        coverIndexes: prepared.coverIndexes,
    });
    await executePlan(plan);
}

async function runBackground(work: DeferredWork[]): Promise<void> {
    if (stopRequested || work.length === 0) return;
    const started = performance.now();
    logger.info(`Key index reconcile starting in background (${work.length} group(s))`);
    try {
        const outcome = await withLock(LOCK_KEY, async () => {
            for (const item of work) {
                if (stopRequested) return;
                await executeDeferred(item);
            }
        }, { leaseTtlMs: 120_000 });
        if (!outcome.acquired) {
            logger.info(
                "Key index reconcile skipped; another instance holds bunsane:index-reconcile (retried next boot)",
            );
            return;
        }
        logger.info(`Key index reconcile background finished in ${Math.round(performance.now() - started)}ms`);
    } catch (error) {
        logger.error(`Key index reconcile failed (retried next boot): ${errorText(error)}`);
    }
}

function startBackgroundNow(): Promise<void> {
    if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
    }
    if (inflight) return inflight;
    if (stopRequested || deferred.length === 0) return Promise.resolve();
    const work = deferred.splice(0, deferred.length);
    const run = runBackground(work).then(() => {
        if (inflight === run) inflight = null;
        if (deferred.length > 0 && !stopRequested) return startBackgroundNow();
    });
    inflight = run;
    return run;
}

function armTimer(): void {
    if (stopRequested || inflight || startTimer || deferred.length === 0) return;
    startTimer = setTimeout(() => {
        startTimer = null;
        void startBackgroundNow();
    }, 0);
    startTimer.unref?.();
}

/**
 * Synchronous when `reltuples` is under `BUNSANE_INDEX_SYNC_MAX_ROWS` (default
 * 100000). Negative stats use relation size (above 64MB is background).
 * Unknown `@CompositeIndex` fields throw. Index DDL errors are logged and
 * retried next boot — they do not throw.
 *
 * `dropUndesired` must be true only when `components` is the complete set for
 * every shared table in the call (full boot, or every HASH component).
 */
export async function reconcileKeyIndexes(input: {
    components: readonly KeyIndexComponent[];
    includeEntities?: boolean;
    dropUndesired?: boolean;
}): Promise<void> {
    const includeEntities = input.includeEntities !== false;
    const built = specsFor(input.components, includeEntities);
    await reconcileKeyIndexSpecs({
        specs: built.specs,
        legacy: built.legacy,
        dropUndesired: input.dropUndesired === true,
    });
}

/**
 * Same sync/background split, lock, and invalid rebuild as
 * {@link reconcileKeyIndexes}, for specs that are not component JSON keys
 * (`rm_` projected columns). `__cover` is dropped only after every replacement
 * on that table is valid.
 */
export async function reconcileKeyIndexSpecs(input: {
    specs: readonly KeyIndexSpec[];
    legacy?: readonly LegacyDropSpec[];
    dropUndesired?: boolean;
    coverIndexes?: readonly { table: string; name: string }[];
}): Promise<void> {
    await ensureNumericKeyFunction();
    const tables = [...new Set(input.specs.map((spec) => spec.table))];
    for (const cover of input.coverIndexes ?? []) {
        if (!tables.includes(cover.table)) tables.push(cover.table);
    }
    if (tables.length === 0) return;
    const prepared: PreparedReconcile = {
        specs: input.specs,
        legacy: input.legacy ?? [],
        tables,
        dropUndesired: input.dropUndesired === true,
        coverIndexes: input.coverIndexes ?? [],
    };
    try {
        const [catalog, stats] = await Promise.all([readCatalog(tables), readTableStats(tables)]);
        const plan = planKeyIndexReconcile({
            desired: prepared.specs,
            catalog,
            ownedTables: tables,
            legacy: prepared.legacy,
            useConcurrently: (table) => useConcurrently(table, stats),
            dropUndesired: prepared.dropUndesired,
            coverIndexes: prepared.coverIndexes,
        });
        const small = new Set(tables.filter((table) => statIsSmall(stats.get(table))));
        await executePlan(filterPlan(plan, small));
        const largeTables = tables.filter((table) => !small.has(table) && planTouchesTable(plan, table));
        if (largeTables.length === 0) return;
        deferred.push({
            prepared: {
                specs: prepared.specs.filter((spec) => largeTables.includes(spec.table)),
                legacy: prepared.legacy.filter((drop) => largeTables.includes(drop.table)),
                tables: largeTables,
                dropUndesired: prepared.dropUndesired,
                coverIndexes: prepared.coverIndexes.filter((cover) => largeTables.includes(cover.table)),
            },
        });
        if (handoff) armTimer();
    } catch (error) {
        logger.error(`Key index reconcile failed (retried next boot): ${errorText(error)}`);
    }
}

/** Start queued large-table builds after `App.init()` returns. Idempotent. */
export function scheduleBackgroundIndexReconcile(): void {
    handoff = true;
    armTimer();
}

/** Wait until queued background builds finish. Starts them if init has not. */
export function awaitIndexReconcile(): Promise<void> {
    return startBackgroundNow();
}

/**
 * Stop starting further indexes and wait for the in-flight statement.
 * Safe to call when nothing is running. Does not cancel a server-side
 * `CREATE INDEX CONCURRENTLY` already in progress — it waits for that one.
 */
export function stopIndexReconcile(): Promise<void> {
    if (stopping) return stopping;
    stopRequested = true;
    if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
    }
    deferred = [];
    const pending = inflight ?? Promise.resolve();
    stopping = pending.finally(() => {
        stopRequested = false;
        stopping = null;
    });
    return stopping;
}
