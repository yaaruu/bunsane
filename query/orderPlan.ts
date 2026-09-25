/**
 * Canonical list ordering: key expressions, fetch order, and the index-ordered
 * id-select (docs/internal/RFC_INDEX_DRIVEN_LISTS.md, D1/D3).
 *
 * Every sort/keyset key expression the query layer emits comes from here, and
 * so does every key index the schema layer builds (`database/keyIndexSpec.ts`).
 * An index key and the ORDER BY that should use it are therefore the same text
 * by construction — the property the old partial numeric index lacked.
 */
import { getMetadataStorage } from "../core/metadata";
import { assertIdentifier } from "./SqlIdentifier";

/** IMMUTABLE numeric-or-NULL cast. Versioned: a behaviour change is `_v2`, never a replace of v1. */
export const NUMERIC_KEY_FN = "bunsane_num_v1";

/** JSON text that casts cleanly to numeric. jsonb numbers never render exponents. */
export const NUMERIC_TEXT_REGEX = "^-?[0-9]+\\.?[0-9]*$";

/**
 * Inlinable (single SELECT, not STRICT) so the planner sees the CASE expression
 * on both the index and the query side. Never raises, so a non-partial
 * expression index on it cannot fail an INSERT.
 */
export const NUMERIC_KEY_FN_DDL =
    `CREATE FUNCTION ${NUMERIC_KEY_FN}(t text) RETURNS numeric ` +
    `LANGUAGE sql IMMUTABLE PARALLEL SAFE ` +
    `AS $fn$ SELECT CASE WHEN length(t) <= 1000 AND t ~ '${NUMERIC_TEXT_REGEX}' THEN t::numeric END $fn$`;

export type SortKeyKind = "numeric" | "text" | "timestamp" | "boolean";
export type FieldKeyKind = "numeric" | "text";
export type EntityTimestampColumn = "created_at" | "updated_at";
export type SortDirection = "ASC" | "DESC";

function prefix(alias: string | null): string {
    return alias === null ? "" : `${assertIdentifier(alias, "orderPlan.alias")}.`;
}

/** `<alias>.data->>'field'` (top-level JSON property as text). */
export function jsonFieldText(alias: string | null, field: string): string {
    return `${prefix(alias)}data->>'${assertIdentifier(field, "orderPlan.field")}'`;
}

/** Numeric key over any JSON text expression (e.g. a nested `data->'a'->>'b'`). */
export function numericKeyOf(jsonTextExpr: string): string {
    return `${NUMERIC_KEY_FN}(${jsonTextExpr})`;
}

/** Key expression for a component JSON field. `alias = null` is the index DDL form. */
export function jsonFieldKey(alias: string | null, field: string, kind: FieldKeyKind): string {
    const text = jsonFieldText(alias, field);
    return kind === "numeric" ? numericKeyOf(text) : text;
}

/**
 * Timestamp key over a timestamptz column expression: UTC wall time truncated
 * to milliseconds. IMMUTABLE, so indexable, and exactly the precision of a JS
 * `Date` cursor value.
 */
export function timestampKeyOf(columnExpr: string): string {
    return `date_trunc('milliseconds', ${columnExpr} AT TIME ZONE 'UTC')`;
}

/** Entity timestamp key (`entities.created_at` / `updated_at`, or the same-named `rm_` columns). */
export function entityTimestampKey(alias: string | null, column: EntityTimestampColumn): string {
    const col = column === "updated_at" ? "updated_at" : "created_at";
    return timestampKeyOf(`${prefix(alias)}${col}`);
}

/** Placeholder expression comparable with a key of `kind`. */
export function keyParam(kind: SortKeyKind, placeholder: number): string {
    if (kind === "numeric") return `$${placeholder}::numeric`;
    if (kind === "timestamp") return `($${placeholder}::timestamptz AT TIME ZONE 'UTC')`;
    if (kind === "boolean") return `$${placeholder}::boolean`;
    return `$${placeholder}::text`;
}

const kindByComponent = new WeakMap<object, Map<string, FieldKeyKind>>();

/**
 * `numeric` when `@IndexedField("numeric")` or the `@CompData` type is Number,
 * else `text` (strings, enums, booleans, ISO dates). Cached per registered
 * component; unregistered components are not cached (registration may follow).
 */
export function fieldKeyKind(componentName: string, field: string): FieldKeyKind {
    const storage = getMetadataStorage();
    const meta = storage.components_map.get(componentName);
    const hit = meta ? kindByComponent.get(meta)?.get(field) : undefined;
    if (hit) return hit;

    const typeId = storage.getComponentId(componentName);
    const indexed = storage.getIndexedFields(typeId).find((f) => f.propertyKey === field);
    const prop = storage.getComponentProperties(typeId).find((p) => p.propertyKey === field);
    const kind: FieldKeyKind = indexed?.indexType === "numeric" || prop?.propertyType === Number ? "numeric" : "text";

    if (meta) {
        let cache = kindByComponent.get(meta);
        if (!cache) {
            cache = new Map();
            kindByComponent.set(meta, cache);
        }
        cache.set(field, kind);
    }
    return kind;
}

/** Fetch order for a page: `'before'` reverses direction and NULLS placement. */
export function fetchOrder(
    direction: SortDirection,
    nullsFirst: boolean,
    isBefore: boolean,
): { direction: SortDirection; nullsFirst: boolean } {
    if (!isBefore) return { direction, nullsFirst };
    return { direction: direction === "DESC" ? "ASC" : "DESC", nullsFirst: !nullsFirst };
}

export interface OrderKey {
    expr: string;
    kind: SortKeyKind;
    /** Fetch direction (already reversed for `'before'`). The id tiebreak follows it. */
    direction: SortDirection;
    /** Fetch NULLS placement (already reversed for `'before'`). */
    nullsFirst: boolean;
}

/** Cursor row position. `value = null` means the cursor row's key was NULL. */
export interface KeysetPosition {
    value: string | null;
    id: string;
}

export interface OrderedIdSelectSpec {
    /** Id column, e.g. `s.entity_id` or `e.id`. */
    idExpr: string;
    /** FROM body, e.g. `components_product s` (joins allowed). */
    fromSql: string;
    /** Already-parameterized predicates, AND-ed. Emitted once per branch (placeholders are reused). */
    where: readonly string[];
    key: OrderKey;
    cursor: KeysetPosition | null;
    limit: number | null;
    offset: number;
    /** Pushes a bind value and returns its 1-based placeholder number. */
    addParam: (value: unknown) => number;
    /**
     * An index `(key ASC NULLS LAST, id)` exists. Emits the null-split plan
     * (two index-ordered branches). Without it, one statement with an OR
     * keyset so an unindexed sort pays for one scan, not two.
     */
    indexed: boolean;
}

/**
 * `SELECT … AS id` in canonical order: non-null keys `key D, id D`, NULL keys
 * `id D`, groups ordered by NULLS placement, then LIMIT/OFFSET.
 */
export function buildOrderedIdSelect(spec: OrderedIdSelectSpec): string {
    return spec.indexed ? buildSplit(spec) : buildSingle(spec);
}

function comparator(direction: SortDirection): ">" | "<" {
    return direction === "ASC" ? ">" : "<";
}

function whereSql(parts: readonly string[]): string {
    return parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`;
}

function pagingSql(spec: OrderedIdSelectSpec, limit: number | null, offset: number): string {
    let sql = "";
    if (limit !== null) sql += ` LIMIT $${spec.addParam(limit)}`;
    if (offset > 0) sql += ` OFFSET $${spec.addParam(offset)}`;
    return sql;
}

type Group = "nonnull" | "null";

interface Branch {
    group: Group;
    preds: string[];
}

interface SelectShape {
    idAlias: string;
    extraSelect: readonly string[];
}

const DEFAULT_SHAPE: SelectShape = { idAlias: "id", extraSelect: [] };

function buildSplit(spec: OrderedIdSelectSpec, shape: SelectShape = DEFAULT_SHAPE): string {
    const { key, idExpr, cursor } = spec;
    const dir = key.direction;
    const cmp = comparator(dir);
    const columns = [`${idExpr} AS ${shape.idAlias}`, ...shape.extraSelect].join(", ");
    const outerColumns = [shape.idAlias, ...shape.extraSelect].join(", ");
    // The index is ASC NULLS LAST; its forward scan is `ASC NULLS LAST`, its
    // backward scan `DESC NULLS FIRST`. Each branch asks for exactly that order
    // so the planner matches the index pathkeys (the null branch otherwise
    // walks the (entity_id, type_id) unique index and filters every row).
    const scanOrder = `${key.expr} ${dir} ${dir === "ASC" ? "NULLS LAST" : "NULLS FIRST"}, ${idExpr} ${dir}`;
    const groups: Group[] = key.nullsFirst ? ["null", "nonnull"] : ["nonnull", "null"];

    const branches: Branch[] = [];
    for (const group of groups) {
        if (group === "nonnull") {
            const preds = [`${key.expr} IS NOT NULL`];
            if (cursor) {
                if (cursor.value === null) {
                    // Cursor is in the NULL group: non-null rows follow only under NULLS FIRST.
                    if (!key.nullsFirst) continue;
                } else {
                    const v = keyParam(key.kind, spec.addParam(cursor.value));
                    const id = spec.addParam(cursor.id);
                    preds.push(`(${key.expr}, ${idExpr}) ${cmp} (${v}, $${id}::uuid)`);
                }
            }
            branches.push({ group, preds });
        } else {
            const preds = [`${key.expr} IS NULL`];
            if (cursor) {
                if (cursor.value === null) {
                    preds.push(`${idExpr} ${cmp} $${spec.addParam(cursor.id)}::uuid`);
                } else if (key.nullsFirst) {
                    // Cursor is non-null and NULLs came first: they are all behind it.
                    continue;
                }
            }
            branches.push({ group, preds });
        }
    }

    if (branches.length === 1) {
        const only = branches[0]!;
        return (
            `SELECT ${columns} FROM ${spec.fromSql}${whereSql([...spec.where, ...only.preds])}` +
            ` ORDER BY ${scanOrder}${pagingSql(spec, spec.limit, spec.offset)}`
        );
    }

    const branchLimit = spec.limit === null ? null : spec.limit + spec.offset;
    const parts = branches.map((branch, ordinal) => {
        const keyCol = branch.group === "nonnull" ? key.expr : "NULL";
        return (
            `(SELECT ${columns}, ${ordinal} AS g, ${keyCol} AS k FROM ${spec.fromSql}` +
            `${whereSql([...spec.where, ...branch.preds])} ORDER BY ${scanOrder}${pagingSql(spec, branchLimit, 0)})`
        );
    });
    return (
        `SELECT ${outerColumns} FROM (${parts.join(" UNION ALL ")}) AS ordered_page` +
        ` ORDER BY g, k ${dir}, ${shape.idAlias} ${dir}${pagingSql(spec, spec.limit, spec.offset)}`
    );
}

function buildSingle(spec: OrderedIdSelectSpec, shape: SelectShape = DEFAULT_SHAPE): string {
    const { key, idExpr, cursor } = spec;
    const dir = key.direction;
    const cmp = comparator(dir);
    const columns = [`${idExpr} AS ${shape.idAlias}`, ...shape.extraSelect].join(", ");
    const preds = [...spec.where];
    if (cursor) {
        if (cursor.value === null) {
            const core = `(${key.expr} IS NULL AND ${idExpr} ${cmp} $${spec.addParam(cursor.id)}::uuid)`;
            preds.push(key.nullsFirst ? `(${core} OR ${key.expr} IS NOT NULL)` : core);
        } else {
            const v = keyParam(key.kind, spec.addParam(cursor.value));
            const id = spec.addParam(cursor.id);
            const core = `(${key.expr}, ${idExpr}) ${cmp} (${v}, $${id}::uuid)`;
            preds.push(key.nullsFirst ? core : `(${core} OR ${key.expr} IS NULL)`);
        }
    }
    const nulls = key.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
    return (
        `SELECT ${columns} FROM ${spec.fromSql}${whereSql(preds)}` +
        ` ORDER BY ${key.expr} ${dir} ${nulls}, ${idExpr} ${dir}${pagingSql(spec, spec.limit, spec.offset)}`
    );
}

// EntitySort: identical UTC-millisecond values to entityTimestampKey, but the
// parentheses keep it from matching the bk_ entities index (hash-join + top-N).
export function entityTimestampFallbackKey(alias: string | null, column: EntityTimestampColumn): string {
    const col = column === "updated_at" ? "updated_at" : "created_at";
    return `(date_trunc('milliseconds', ${prefix(alias)}${col}) AT TIME ZONE 'UTC')`;
}

// QspAlign: typed rm_ column keys, and the same ordered select with hydrate columns.
export type RmColumnSqlType = "text" | "numeric" | "timestamptz" | "boolean" | "uuid";

/**
 * Sort/index key for a typed `rm_` column. `quotedColumn` is already quoted
 * (`"total"`). uuid (`__cid`) is not a sort key.
 */
export function rmColumnKey(
    quotedColumn: string,
    sqlType: RmColumnSqlType,
): { expr: string; kind: SortKeyKind } | null {
    switch (sqlType) {
        case "numeric":
            return { expr: quotedColumn, kind: "numeric" };
        case "timestamptz":
            return { expr: timestampKeyOf(quotedColumn), kind: "timestamp" };
        case "boolean":
            return { expr: quotedColumn, kind: "boolean" };
        case "text":
            return { expr: quotedColumn, kind: "text" };
        case "uuid":
            return null;
    }
}

export interface OrderedRowSelectOptions {
    /** Output name of the id column. Default `id`, matching `buildOrderedIdSelect`. */
    idAlias?: string;
    /** Extra select items from the same FROM scope, carried through every branch. */
    extraSelect?: readonly string[];
}

/** Same plan as `buildOrderedIdSelect`, with a caller-chosen id alias and extra output columns. */
export function buildOrderedRowSelect(
    spec: OrderedIdSelectSpec,
    options: OrderedRowSelectOptions = {},
): string {
    const shape: SelectShape = {
        idAlias: assertIdentifier(options.idAlias ?? "id", "orderPlan.idAlias"),
        extraSelect: options.extraSelect ?? [],
    };
    return spec.indexed ? buildSplit(spec, shape) : buildSingle(spec, shape);
}
