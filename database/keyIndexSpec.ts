/**
 * Which key indexes a component (and `entities`) should have, and their DDL
 * (docs/internal/RFC_INDEX_DRIVEN_LISTS.md, D2). Pure: no DB access.
 *
 * Key expressions come from `query/orderPlan.ts`, so the index key and the
 * ORDER BY / keyset expression the query layer emits are the same text.
 */
import { createHash } from "crypto";
import { getMetadataStorage } from "../core/metadata";
import {
    entityTimestampKey,
    fieldKeyKind,
    jsonFieldKey,
    type EntityTimestampColumn,
} from "../query/orderPlan";

/** Ownership marker: the reconciler only creates/drops indexes with this prefix. */
export const KEY_INDEX_PREFIX = "bk_";

const MAX_IDENT = 63;
const HASH_LEN = 8;

export interface KeyIndexSpec {
    /** ≤ 63 bytes; ends in a hash of the definition, so a changed definition is a new name. */
    name: string;
    table: string;
    /** Component fields in key order (empty for entity timestamp indexes). */
    fields: readonly string[];
    /** `(<expr>), …, <id column>` — not partial (see buildSpec). */
    columnsSql: string;
    createSql(concurrently: boolean): string;
}

function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Key indexes are deliberately NOT partial (`WHERE deleted_at IS NULL`): the
 * planner ignores statistics of partial expression indexes, and without them
 * `data->>'f' = $1` / `IN (...)` fall back to default selectivity (measured:
 * relation loads estimated 7500 rows instead of ~150 and switched to a hash
 * join over every entity). Queries still filter `deleted_at IS NULL`; soft-
 * deleted rows only cost index entries.
 */
function buildSpec(table: string, slugParts: readonly string[], fields: readonly string[], keyExprs: readonly string[], idColumn: string): KeyIndexSpec {
    const columnsSql = [...keyExprs.map((expr) => `(${expr})`), idColumn].join(", ");
    const hash = createHash("sha256").update(`${table}|${columnsSql}`).digest("hex").slice(0, HASH_LEN);
    const room = MAX_IDENT - KEY_INDEX_PREFIX.length - 1 - HASH_LEN;
    const slug = slugify(slugParts.join("_")).slice(0, room).replace(/_+$/, "");
    const name = `${KEY_INDEX_PREFIX}${slug}_${hash}`;
    return {
        name,
        table,
        fields,
        columnsSql,
        createSql(concurrently: boolean): string {
            return `CREATE INDEX${concurrently ? " CONCURRENTLY" : ""} IF NOT EXISTS ${name} ON ${table} (${columnsSql})`;
        },
    };
}

interface KeyFieldCache {
    keyFields: ReadonlySet<string>;
    composites: readonly (readonly string[])[];
}

const keysByComponent = new WeakMap<object, KeyFieldCache>();

function loadKeys(componentName: string): KeyFieldCache {
    const storage = getMetadataStorage();
    const typeId = storage.getComponentId(componentName);
    const keyFields = new Set<string>();
    for (const prop of storage.getComponentProperties(typeId)) {
        if (prop.indexed && prop.arrayOf == null) keyFields.add(prop.propertyKey);
    }
    for (const indexed of storage.getIndexedFields(typeId)) {
        if (indexed.indexType === "btree" || indexed.indexType === "numeric") keyFields.add(indexed.propertyKey);
    }
    const known = new Set(storage.getComponentProperties(typeId).map((prop) => prop.propertyKey));
    const composites = storage.getCompositeIndexes(typeId).map((composite) => {
        for (const field of composite.fields) {
            if (!known.has(field)) {
                throw new Error(`@CompositeIndex on ${componentName}: '${field}' is not a @CompData property.`);
            }
        }
        return [...composite.fields];
    });
    return { keyFields, composites };
}

function keysOf(componentName: string): KeyFieldCache {
    const meta = getMetadataStorage().components_map.get(componentName);
    if (!meta) return loadKeys(componentName);
    const hit = keysByComponent.get(meta);
    if (hit) return hit;
    const loaded = loadKeys(componentName);
    keysByComponent.set(meta, loaded);
    return loaded;
}

/**
 * Single-field key fields: `@CompData({ indexed: true })` scalars (not
 * `arrayOf`) and `@IndexedField("btree" | "numeric")`. `gin`, `hash`, and
 * `fulltext` keep their own indexes and are not sort keys.
 */
export function keyFieldsOf(componentName: string): string[] {
    return [...keysOf(componentName).keyFields];
}

/** `@CompositeIndex` field lists, validated against the component's `@CompData` properties. */
export function compositeKeysOf(componentName: string): string[][] {
    return keysOf(componentName).composites.map((fields) => [...fields]);
}

/**
 * Key indexes for one component.
 *
 * LIST (default): on the component's leaf, keyed `(k…, entity_id)`.
 * HASH: on the `components` parent with `type_id` leading, so one index serves
 * every component that shares the same field definition.
 */
export function componentKeyIndexSpecs(componentName: string, table: string, strategy: "list" | "hash"): KeyIndexSpec[] {
    const lists: string[][] = [...keyFieldsOf(componentName).map((field) => [field]), ...compositeKeysOf(componentName)];
    const seen = new Set<string>();
    const specs: KeyIndexSpec[] = [];
    for (const fields of lists) {
        const exprs = fields.map((field) => jsonFieldKey(null, field, fieldKeyKind(componentName, field)));
        const keyExprs = strategy === "hash" ? ["type_id", ...exprs] : exprs;
        const spec = buildSpec(table, [table.replace(/^components_/, ""), ...fields], fields, keyExprs, "entity_id");
        if (seen.has(spec.name)) continue;
        seen.add(spec.name);
        specs.push(spec);
    }
    return specs;
}

/** `entities` key indexes for `sortByCreatedAt` / `sortByUpdatedAt`. */
export function entityKeyIndexSpecs(): KeyIndexSpec[] {
    const columns: EntityTimestampColumn[] = ["created_at", "updated_at"];
    return columns.map((column) => buildSpec("entities", ["entities", column], [], [entityTimestampKey(null, column)], "id"));
}

/**
 * Whether a sort on `field` can be served by a key index given the fields this
 * query pins with `=` on the same component (composite prefixes).
 */
export function sortKeyIndexed(componentName: string, field: string, equalityFields: ReadonlySet<string>): boolean {
    const keys = keysOf(componentName);
    if (keys.keyFields.has(field)) return true;
    for (const fields of keys.composites) {
        const at = fields.indexOf(field);
        if (at < 0) continue;
        let prefixed = true;
        for (let i = 0; i < at; i++) {
            if (!equalityFields.has(fields[i]!)) {
                prefixed = false;
                break;
            }
        }
        if (prefixed) return true;
    }
    return false;
}

// QspAlign: key indexes whose expression is already the canonical orderPlan text.
/** `((keyExpr), idColumn)`, named `bk_<slug>_<hash8>`. */
export function expressionKeyIndexSpec(
    table: string,
    slugParts: readonly string[],
    keyExpr: string,
    idColumn = "entity_id",
): KeyIndexSpec {
    return buildSpec(table, slugParts, [], [keyExpr], idColumn);
}
