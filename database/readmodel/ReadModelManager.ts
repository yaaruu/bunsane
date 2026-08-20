import type { SQL } from "bun";
import db from "../index";
import { logger as MainLogger } from "../../core/Logger";
import { getMetadataStorage } from "../../core/metadata";
import { ComponentRegistry } from "../../core/components";
import { getPartitionStrategy, shouldUseDirectPartition } from "../../core/Config";
import type { Entity } from "../../core/Entity";
import { ReadModelRegistry } from "../../core/readmodel/ReadModelRegistry";
import type { ReadModelDescriptor } from "../../core/readmodel/types";
import { assertComponentTableName, assertIdentifier } from "../../query/SqlIdentifier";
import { createM3Table, dropM3Table, ensureStateTable, STATE_TABLE } from "./DDL";
import { assertM3TableName } from "../../core/readmodel/join";

const logger = MainLogger.child({ scope: "ReadModelManager" });

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

function exec<T = any>(sql: string, params: any[] = [], trx?: SQL): Promise<T> {
    return (trx ?? db).unsafe(sql, params) as Promise<T>;
}

function typeId(componentName: string): string {
    return getMetadataStorage().getComponentId(componentName);
}

function jsonExpr(alias: string, field: string, sqlType: string): string {
    const f = assertIdentifier(field, "m3.jsonField");
    const path = `${alias}.data->>'${f}'`;
    if (sqlType === "numeric") return `(${path})::numeric`;
    if (sqlType === "boolean") return `(${path})::boolean`;
    if (sqlType === "timestamptz") return `NULLIF(${path}, '')::timestamptz`;
    return path;
}

function insertColumnList(desc: ReadModelDescriptor): string {
    const extra = desc.projects.map((p) => `"${assertIdentifier(p.columnName, "m3.col")}"`);
    return ["left_entity_id", "right_entity_id", ...extra, "deleted_at", "shape_version"].join(", ");
}

function insertSelectList(desc: ReadModelDescriptor): string {
    const extra = desc.projects.map((p) => {
        const alias = p.component === desc.join.leftComponent ? "l" : "r";
        return jsonExpr(alias, p.field, p.sqlType);
    });
    return ["l.entity_id", "r.entity_id", ...extra, "NULL", "1"].join(", ");
}

/** LIST leaf when direct-partition is on; parent `components` otherwise (HASH / fallback). */
export function readModelScanTable(componentName: string): string {
    if (getPartitionStrategy() === "hash" || !shouldUseDirectPartition()) {
        return "components";
    }
    const id = typeId(componentName);
    const raw = ComponentRegistry.getPartitionTableName(id);
    if (!raw) return "components";
    return assertComponentTableName(raw, "m3.partition");
}

function joinFrom(desc: ReadModelDescriptor): { sql: string; params: any[] } {
    const leftType = typeId(desc.join.leftComponent);
    const rightType = typeId(desc.join.rightComponent);
    const leftTable = readModelScanTable(desc.join.leftComponent);
    const rightTable = readModelScanTable(desc.join.rightComponent);
    const fk = assertIdentifier(desc.join.leftField, "m3.joinField");
    const sql = `FROM ${leftTable} l
        JOIN ${rightTable} r
          ON r.entity_id = NULLIF(l.data->>'${fk}', '')::uuid
         AND r.type_id = $2
         AND r.deleted_at IS NULL
        WHERE l.type_id = $1
          AND l.deleted_at IS NULL
          AND l.data->>'${fk}' ~ '${UUID_RE}'`;
    return { sql, params: [leftType, rightType] };
}

export class ReadModelManager {
    private static _instance: ReadModelManager | null = null;
    /** Dual-write on Entity.save / delete. Tests can pause it to prove rebuild-from-JSONB. */
    dualWrite = true;
    private readyNames = new Set<string>();

    static get instance(): ReadModelManager {
        return (this._instance ??= new ReadModelManager());
    }

    static reset(): void {
        this._instance = null;
    }

    private isReady(name: string): boolean {
        return this.readyNames.has(name);
    }

    async initialize(): Promise<void> {
        await ensureStateTable();
        for (const desc of ReadModelRegistry.all()) {
            await this.ensureModel(desc);
        }
    }

    async ensureModel(desc: ReadModelDescriptor): Promise<void> {
        const rows = await exec<any[]>(
            `SELECT shape_hash FROM ${STATE_TABLE} WHERE name = $1`,
            [desc.name]
        );
        const existing = rows[0]?.shape_hash as string | undefined;
        if (existing && existing !== desc.shapeHash) {
            logger.warn(
                { scope: "m3.reconcile", name: desc.name, existing, next: desc.shapeHash },
                "M3 shape-hash drift — dropping derived table and rebuilding from JSONB"
            );
            await dropM3Table(desc);
        }
        await createM3Table(desc);
        if (!existing || existing !== desc.shapeHash) {
            if (desc.rebuildable) {
                await this.rebuild(desc);
            }
            await exec(
                `INSERT INTO ${STATE_TABLE} (name, shape_hash, status, shape_version)
                 VALUES ($1, $2, 'READY', $3)
                 ON CONFLICT (name) DO UPDATE SET
                   shape_hash = EXCLUDED.shape_hash,
                   status = 'READY',
                   shape_version = EXCLUDED.shape_version,
                   updated_at = now()`,
                [desc.name, desc.shapeHash, desc.shapeVersion]
            );
        }
        this.readyNames.add(desc.name);
    }

    /** Full rebuild from live JSONB components. Source of truth stays ECS. */
    async rebuild(desc: ReadModelDescriptor, trx?: SQL): Promise<number> {
        const table = assertM3TableName(desc.tableName);
        const { sql: fromSql, params } = joinFrom(desc);
        await exec(`DELETE FROM ${table}`, undefined as any, trx);
        const insertSql = `INSERT INTO ${table} (${insertColumnList(desc)})
            SELECT ${insertSelectList(desc)}
            ${fromSql}
            ON CONFLICT (left_entity_id, right_entity_id) DO UPDATE SET
            ${desc.projects.map((p) => `"${p.columnName}" = EXCLUDED."${p.columnName}"`).join(", ")},
            updated_at = now(),
            deleted_at = NULL`;
        const inserted = await exec<any[]>(insertSql, params, trx);
        return Array.isArray(inserted) ? inserted.length : 0;
    }

    async rebuildAll(trx?: SQL): Promise<void> {
        for (const desc of ReadModelRegistry.all()) {
            if (desc.rebuildable) await this.rebuild(desc, trx);
        }
    }

    async syncOnSave(entity: Entity, trx?: SQL): Promise<void> {
        if (!this.dualWrite) return;
        const models = ReadModelRegistry.all();
        if (models.length === 0) return;
        const present = new Set<string>();
        for (const comp of entity.components.values()) {
            present.add(comp.constructor.name);
        }
        for (const desc of models) {
            if (!this.isReady(desc.name)) continue;
            if (present.has(desc.join.leftComponent)) {
                await this.refreshLeft(desc, entity.id, trx);
            } else if (present.has(desc.join.rightComponent)) {
                await this.refreshRight(desc, entity.id, trx);
            }
        }
    }

    async syncOnDelete(entityId: string, _force: boolean, trx?: SQL): Promise<void> {
        if (!this.dualWrite) return;
        for (const desc of ReadModelRegistry.all()) {
            if (!this.isReady(desc.name)) continue;
            const table = assertM3TableName(desc.tableName);
            if (_force) {
                await exec(
                    `DELETE FROM ${table} WHERE left_entity_id = $1 OR right_entity_id = $1`,
                    [entityId],
                    trx
                );
            } else {
                await exec(
                    `UPDATE ${table} SET deleted_at = now(), updated_at = now()
                     WHERE deleted_at IS NULL AND (left_entity_id = $1 OR right_entity_id = $1)`,
                    [entityId],
                    trx
                );
            }
        }
    }

    private async refreshLeft(desc: ReadModelDescriptor, leftEntityId: string, trx?: SQL): Promise<void> {
        const table = assertM3TableName(desc.tableName);
        await exec(`DELETE FROM ${table} WHERE left_entity_id = $1`, [leftEntityId], trx);
        const { sql: fromSql, params } = joinFrom(desc);
        const extraWhere = `AND l.entity_id = $3`;
        const insertSql = `INSERT INTO ${table} (${insertColumnList(desc)})
            SELECT ${insertSelectList(desc)}
            ${fromSql} ${extraWhere}
            ON CONFLICT (left_entity_id, right_entity_id) DO UPDATE SET
            ${desc.projects.map((p) => `"${p.columnName}" = EXCLUDED."${p.columnName}"`).join(", ")},
            updated_at = now(),
            deleted_at = NULL`;
        await exec(insertSql, [...params, leftEntityId], trx);
    }

    private async refreshRight(desc: ReadModelDescriptor, rightEntityId: string, trx?: SQL): Promise<void> {
        const table = assertM3TableName(desc.tableName);
        await exec(`DELETE FROM ${table} WHERE right_entity_id = $1`, [rightEntityId], trx);
        const { sql: fromSql, params } = joinFrom(desc);
        const insertSql = `INSERT INTO ${table} (${insertColumnList(desc)})
            SELECT ${insertSelectList(desc)}
            ${fromSql} AND r.entity_id = $3
            ON CONFLICT (left_entity_id, right_entity_id) DO UPDATE SET
            ${desc.projects.map((p) => `"${p.columnName}" = EXCLUDED."${p.columnName}"`).join(", ")},
            updated_at = now(),
            deleted_at = NULL`;
        await exec(insertSql, [...params, rightEntityId], trx);
    }
}

export async function InitializeReadModels(): Promise<void> {
    if (ReadModelRegistry.all().length === 0) return;
    try {
        await ReadModelManager.instance.initialize();
    } catch (error) {
        logger.warn(`Failed to initialize M3 read models: ${error}`);
    }
}
