import type { SQL } from "bun";
import db from "../../database";
import { assertIdentifier } from "../../query/SqlIdentifier";
import { sqlTimeBucketFromTs, type TimeTrunc } from "../../query/timeBucket";
import { ReadModelRegistry } from "./ReadModelRegistry";
import { M3_WHERE_OPS, type M3WhereOp, type ReadModelDescriptor, type ReadModelProjectSpec } from "./types";

interface Predicate {
    spec: ReadModelProjectSpec;
    op: M3WhereOp;
    value: unknown;
    not?: boolean;
}

const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 10000;

function isOp(value: unknown): value is M3WhereOp {
    return typeof value === "string" && (M3_WHERE_OPS as readonly string[]).includes(value);
}

function numericOf(value: unknown): number {
    return value == null ? 0 : Number(value);
}

/**
 * Reader for an M3 derived table. Never hydrates entities.
 * `sum()` / `avg()` emit SQL GROUP BY — they do not `Query.exec()` + JS reduce.
 */
export class M3Query {
    private readonly descriptor: ReadModelDescriptor;
    private readonly preds: Predicate[] = [];
    private groupColumn: ReadModelProjectSpec | null = null;
    private bucket: { spec: ReadModelProjectSpec; trunc: TimeTrunc; tzOffsetMinutes: number } | null =
        null;
    private limitN: number | null = null;

    constructor(ctor: Function) {
        this.descriptor = ReadModelRegistry.requireByCtor(ctor);
    }

    where(field: string, value: unknown): this;
    where(field: string, op: M3WhereOp, value: unknown): this;
    where(field: string, opOrValue: unknown, value?: unknown): this {
        const spec = this.specOf(field);
        if (value !== undefined) {
            if (!isOp(opOrValue)) {
                throw new Error(
                    `Unknown ReadModel where op '${String(opOrValue)}' on ${this.descriptor.name}`
                );
            }
            this.preds.push({ spec, op: opOrValue, value: this.coerce(spec, opOrValue, value) });
            return this;
        }
        this.preds.push({ spec, op: "eq", value: this.coerce(spec, "eq", opOrValue) });
        return this;
    }

    whereIn(field: string, values: unknown[]): this {
        return this.where(field, "in", values);
    }

    whereNotIn(field: string, values: unknown[]): this {
        const spec = this.specOf(field);
        const arr = Array.isArray(values) ? values.map((v) => this.coerceOne(spec, v)) : [];
        this.preds.push({ spec, op: "in", value: arr, not: true });
        return this;
    }

    groupBy(field: string): this {
        this.groupColumn = this.specOf(field);
        return this;
    }

    timeBucket(field: string, trunc: TimeTrunc, tzOffsetMinutes = 0): this {
        const spec = this.specOf(field);
        if (spec.sqlType !== "timestamptz") {
            throw new Error(`ReadModel.timeBucket('${field}') requires a Date @Project field`);
        }
        this.bucket = { spec, trunc, tzOffsetMinutes };
        return this;
    }

    limit(n: number): this {
        if (!Number.isInteger(n) || n < 0) {
            throw new Error("ReadModel.limit() requires a non-negative integer");
        }
        this.limitN = Math.min(n, MAX_LIST_LIMIT);
        return this;
    }

    async sum(field: string, trx?: SQL): Promise<number | Array<Record<string, unknown>>> {
        return this.aggregate("SUM", field, trx);
    }

    async avg(field: string, trx?: SQL): Promise<number | Array<Record<string, unknown>>> {
        return this.aggregate("AVG", field, trx);
    }

    async count(trx?: SQL): Promise<number> {
        const table = this.descriptor.tableName;
        const params: unknown[] = [];
        const whereSql = this.buildWhere(table, params);
        const sql = `SELECT COUNT(*)::int AS result FROM ${table} ${whereSql}`;
        const rows = await (trx ?? db).unsafe(sql, params as any[]);
        return numericOf((rows as any[])[0]?.result);
    }

    async countBy(trx?: SQL): Promise<Array<Record<string, unknown>>> {
        const table = this.descriptor.tableName;
        const params: unknown[] = [];
        const whereSql = this.buildWhere(table, params);
        const groups = this.groupSelect(table, params);
        if (groups.select.length === 0) {
            throw new Error("ReadModel.countBy() requires .groupBy() or .timeBucket()");
        }
        const sql = `SELECT ${groups.select.join(", ")}, COUNT(*)::int AS count
                     FROM ${table} ${whereSql}
                     GROUP BY ${groups.select.map((_, i) => String(i + 1)).join(", ")}`;
        const rows = await (trx ?? db).unsafe(sql, params as any[]);
        return (rows as any[]).map((r) => this.mapGroupRow(r, null, r.count));
    }

    async rows(trx?: SQL): Promise<Array<Record<string, unknown>>> {
        const table = this.descriptor.tableName;
        const params: unknown[] = [];
        const whereSql = this.buildWhere(table, params);
        const cols = [
            "left_entity_id",
            "right_entity_id",
            ...this.descriptor.projects.map((p) => `"${p.columnName}"`),
        ].join(", ");
        let sql = `SELECT ${cols} FROM ${table} ${whereSql}`;
        if (this.limitN != null) {
            params.push(this.limitN);
            sql += ` LIMIT $${params.length}`;
        }
        const raw = (await (trx ?? db).unsafe(sql, params as any[])) as any[];
        return raw.map((row) => this.mapRow(row));
    }

    private async aggregate(
        fn: "SUM" | "AVG",
        field: string,
        trx?: SQL
    ): Promise<number | Array<Record<string, unknown>>> {
        const spec = this.specOf(field);
        if (spec.sqlType !== "numeric") {
            throw new Error(`ReadModel.${fn.toLowerCase()}('${field}') requires a numeric @Project field`);
        }
        const table = this.descriptor.tableName;
        const metric = spec.columnName;
        const key = spec.propertyKey;
        const params: unknown[] = [];
        const whereSql = this.buildWhere(table, params);
        const conn = trx ?? db;
        const groups = this.groupSelect(table, params);
        if (groups.select.length > 0) {
            const sql = `SELECT ${groups.select.join(", ")}, ${fn}("${metric}")::numeric AS "${metric}"
                         FROM ${table} ${whereSql}
                         GROUP BY ${groups.select.map((_, i) => String(i + 1)).join(", ")}`;
            const rows = await conn.unsafe(sql, params as any[]);
            return (rows as any[]).map((r) => this.mapGroupRow(r, key, r[metric]));
        }
        const sql = `SELECT COALESCE(${fn}("${metric}"), 0)::numeric AS result FROM ${table} ${whereSql}`;
        const rows = await conn.unsafe(sql, params as any[]);
        return numericOf((rows as any[])[0]?.result);
    }

    private groupSelect(
        table: string,
        params: unknown[]
    ): { select: string[]; params: unknown[] } {
        const select: string[] = [];
        if (this.bucket) {
            params.push(this.bucket.tzOffsetMinutes);
            const ts = `"${table}"."${this.bucket.spec.columnName}"`;
            const expr = sqlTimeBucketFromTs(ts, this.bucket.trunc, `$${params.length}`);
            select.push(`${expr} AS bucket`);
        }
        if (this.groupColumn) {
            const g = this.groupColumn.columnName;
            select.push(`"${table}"."${g}" AS "${g}"`);
        }
        return { select, params };
    }

    private mapGroupRow(
        row: Record<string, unknown>,
        metricKey: string | null,
        metricVal: unknown
    ): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        if (this.bucket) out.bucket = row.bucket;
        if (this.groupColumn) {
            out[this.groupColumn.propertyKey] = this.coerceOut(
                this.groupColumn,
                row[this.groupColumn.columnName]
            );
        }
        if (metricKey) out[metricKey] = numericOf(metricVal);
        else out.count = numericOf(metricVal);
        return out;
    }

    private buildWhere(table: string, params: unknown[]): string {
        const where: string[] = [`"${table}".deleted_at IS NULL`];
        for (const pred of this.preds) {
            const col = `"${table}"."${pred.spec.columnName}"`;
            if (pred.op === "in") {
                const arr = Array.isArray(pred.value) ? pred.value : [];
                if (arr.length === 0) {
                    if (!pred.not) where.push("FALSE");
                    continue;
                }
                const placeholders = arr.map((v) => {
                    params.push(v);
                    return `$${params.length}`;
                });
                where.push(
                    pred.not
                        ? `${col} NOT IN (${placeholders.join(", ")})`
                        : `${col} IN (${placeholders.join(", ")})`
                );
                continue;
            }
            params.push(pred.value);
            const idx = `$${params.length}`;
            switch (pred.op) {
                case "eq":
                    where.push(`${col} = ${idx}`);
                    break;
                case "ne":
                    where.push(`${col} <> ${idx}`);
                    break;
                case "gt":
                    where.push(`${col} > ${idx}`);
                    break;
                case "gte":
                    where.push(`${col} >= ${idx}`);
                    break;
                case "lt":
                    where.push(`${col} < ${idx}`);
                    break;
                case "lte":
                    where.push(`${col} <= ${idx}`);
                    break;
            }
        }
        return `WHERE ${where.join(" AND ")}`;
    }

    private specOf(field: string): ReadModelProjectSpec {
        const ident = assertIdentifier(field, "ReadModel.query.field");
        const hit = this.descriptor.projects.find(
            (p) => p.propertyKey === ident || p.columnName === ident || p.field === ident
        );
        if (!hit) {
            throw new Error(`Unknown ReadModel field '${field}' on ${this.descriptor.name}`);
        }
        return hit;
    }

    private coerce(spec: ReadModelProjectSpec, op: M3WhereOp, value: unknown): unknown {
        if (op === "in") {
            if (!Array.isArray(value)) {
                throw new Error(`ReadModel.where('${spec.propertyKey}', 'in', …) requires an array`);
            }
            return value.map((v) => this.coerceOne(spec, v));
        }
        return this.coerceOne(spec, value);
    }

    private coerceOne(spec: ReadModelProjectSpec, value: unknown): unknown {
        if (spec.sqlType === "numeric") {
            const n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n)) {
                throw new Error(`ReadModel field '${spec.propertyKey}' expects a finite number`);
            }
            return n;
        }
        if (spec.sqlType === "timestamptz") {
            if (value instanceof Date) {
                if (Number.isNaN(value.getTime())) {
                    throw new Error(`ReadModel field '${spec.propertyKey}' expects a valid Date`);
                }
                return value;
            }
            const d = new Date(String(value));
            if (Number.isNaN(d.getTime())) {
                throw new Error(`ReadModel field '${spec.propertyKey}' expects a valid date`);
            }
            return d;
        }
        if (spec.sqlType === "boolean") {
            if (typeof value === "boolean") return value;
            if (value === "true") return true;
            if (value === "false") return false;
            throw new Error(`ReadModel field '${spec.propertyKey}' expects a boolean`);
        }
        return value;
    }

    private coerceOut(spec: ReadModelProjectSpec, value: unknown): unknown {
        if (spec.sqlType === "numeric") return numericOf(value);
        if (spec.sqlType === "timestamptz" && typeof value === "string") return new Date(value);
        return value;
    }

    private mapRow(row: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {
            leftEntityId: row.left_entity_id,
            rightEntityId: row.right_entity_id,
        };
        for (const p of this.descriptor.projects) {
            out[p.propertyKey] = this.coerceOut(p, row[p.columnName]);
        }
        return out;
    }
}

export function clampReadModelListLimit(n: unknown): number {
    if (n == null || n === undefined) return DEFAULT_LIST_LIMIT;
    const v = Number(n);
    if (!Number.isInteger(v) || v < 0) {
        throw new Error("ReadModel list limit must be a non-negative integer");
    }
    return Math.min(v, MAX_LIST_LIMIT);
}
