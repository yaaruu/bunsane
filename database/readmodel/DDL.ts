import type { SQL } from "bun";
import { DDL_TIMEOUT_MS } from "../index";
import { dbExec } from "../gateway";
import { assertIdentifier } from "../../query/SqlIdentifier";
import { assertM3TableName } from "../../core/readmodel/join";
import type { ReadModelDescriptor } from "../../core/readmodel/types";
import type { ProjectionSqlType } from "../projection/types";

const SQL_TYPES: Record<ProjectionSqlType, string> = {
    text: "text",
    numeric: "numeric",
    timestamptz: "timestamptz",
    boolean: "boolean",
    uuid: "uuid",
};

/**
 * Schema DDL. Background lane, long budget, no serverTimeout: that option
 * opens a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.
 */
function execDdl(sql: string, trx?: SQL): Promise<unknown> {
    return dbExec(sql, undefined, {
        conn: trx,
        callerOwnsConn: !!trx,
        lane: "background",
        label: "readmodel.ddl",
        timeoutMs: DDL_TIMEOUT_MS,
    });
}

export const STATE_TABLE = "m3_readmodel_state";

export async function ensureStateTable(trx?: SQL): Promise<void> {
    await execDdl(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
        name text PRIMARY KEY,
        shape_hash text NOT NULL,
        status text NOT NULL DEFAULT 'READY',
        shape_version int NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
    )`, trx);
}

export async function createM3Table(desc: ReadModelDescriptor, trx?: SQL): Promise<void> {
    const tableName = assertM3TableName(desc.tableName);
    const columnDefs = desc.projects.map((col) => {
        const columnName = assertIdentifier(col.columnName, "m3Column");
        const mapped = SQL_TYPES[col.sqlType];
        if (!mapped) throw new Error(`Unsupported m3 sqlType: ${col.sqlType}`);
        return `"${columnName}" ${mapped}`;
    });
    const extra = columnDefs.length > 0 ? `,\n        ${columnDefs.join(",\n        ")}` : "";
    await execDdl(`CREATE TABLE IF NOT EXISTS ${tableName} (
        left_entity_id uuid NOT NULL,
        right_entity_id uuid NOT NULL${extra},
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        shape_version int NOT NULL DEFAULT 1,
        PRIMARY KEY (left_entity_id, right_entity_id)
    )`, trx);
    await createM3Indexes(desc, trx);
}

/**
 * Filter/group covering index plus a right-entity lookup and per-timestamptz range indexes.
 * CONCURRENTLY is skipped inside a transaction and on PGlite (same gate as QSP).
 */
export async function createM3Indexes(desc: ReadModelDescriptor, trx?: SQL): Promise<void> {
    const tableName = assertM3TableName(desc.tableName);
    const concurrently = trx ? "" : process.env.USE_PGLITE ? "" : " CONCURRENTLY";
    const ident = (name: string, ctx: string) => assertIdentifier(name.slice(0, 63), ctx);


    const rightName = ident(`idx_${tableName}__right`, "m3Index");
    await execDdl(
        `CREATE INDEX${concurrently} IF NOT EXISTS ${rightName} ON ${tableName} (right_entity_id) WHERE deleted_at IS NULL`,
        trx
    );

    const filterCols = desc.projects.filter((p) => p.sqlType !== "numeric");
    const metricCols = desc.projects.filter((p) => p.sqlType === "numeric");
    if (filterCols.length > 0) {
        const coverName = ident(`idx_${tableName}__cover`, "m3Index");
        const keys = filterCols
            .map((p) => `"${assertIdentifier(p.columnName, "m3IndexColumn")}"`)
            .join(", ");
        const include =
            metricCols.length > 0
                ? ` INCLUDE (${metricCols
                      .map((p) => `"${assertIdentifier(p.columnName, "m3IndexInclude")}"`)
                      .join(", ")})`
                : "";
        await execDdl(
            `CREATE INDEX${concurrently} IF NOT EXISTS ${coverName} ON ${tableName} (${keys})${include} WHERE deleted_at IS NULL`,
            trx
        );
    }

    for (const p of desc.projects.filter((col) => col.sqlType === "timestamptz")) {
        const col = assertIdentifier(p.columnName, "m3IndexColumn");
        const rangeName = ident(`idx_${tableName}__${col.toLowerCase()}`, "m3Index");
        await execDdl(
            `CREATE INDEX${concurrently} IF NOT EXISTS ${rangeName} ON ${tableName} ("${col}") WHERE deleted_at IS NULL`,
            trx
        );
    }
}

export async function dropM3Table(desc: ReadModelDescriptor, trx?: SQL): Promise<void> {
    const tableName = assertM3TableName(desc.tableName);
    await execDdl(`DROP TABLE IF EXISTS ${tableName}`, trx);
}
