/**
 * Non-boot database maintenance.
 *
 * Downgrade/repair tools for the removed `entity_components` mirror, and a
 * partition-count benchmark that copies live rows. These must not sit next to
 * startup DDL — a mistaken call during boot would recreate a legacy table or
 * sample production data into a temp partitioned table.
 *
 * Import from `database/maintenance.ts`. Not invoked by App startup.
 */
import db, { DDL_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "./index";
import { dbExec } from "./gateway";
import { logger as MainLogger } from "../core/Logger";
import { getMembershipTable } from "../query/membershipSource";

const logger = MainLogger.child({ scope: "DatabaseMaintenance" });
const schemaQuery = <T = unknown>(label: string, sql: string, params?: unknown[]): Promise<T> =>
    dbExec<T>(sql, params, { lane: "background", label, timeoutMs: QUERY_TIMEOUT_MS });

const schemaDdl = <T = unknown>(label: string, sql: string, params?: unknown[]): Promise<T> =>
    dbExec<T>(sql, params, { lane: "background", label, timeoutMs: DDL_TIMEOUT_MS });


/**
 * Recreate the legacy `entity_components` table. The framework no longer
 * creates this on boot (Phase 3). Only for an explicit downgrade.
 */
export const CreateEntityComponentTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS entity_components (
        entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        type_id VARCHAR(64) NOT NULL,
        component_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        UNIQUE(entity_id, type_id)
    );`;
    const concurrently = process.env.USE_PGLITE ? '' : ' CONCURRENTLY';
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_entity_id ON entity_components (entity_id)`);
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_type_id ON entity_components (type_id)`);
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_type_entity ON entity_components (type_id, entity_id)`);
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_type_entity_deleted ON entity_components (type_id, entity_id, deleted_at)`);
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_deleted_type ON entity_components (deleted_at, type_id) WHERE deleted_at IS NULL`);
    await schemaDdl('schema.CreateEntityComponentTable.create', `CREATE INDEX${concurrently} IF NOT EXISTS idx_entity_components_component_id ON entity_components (component_id)`);

    try {
        await db`ALTER TABLE entity_components ADD COLUMN IF NOT EXISTS component_id UUID`;
        logger.info(`Added component_id column to entity_components table`);
    } catch (error) {
        logger.warn(`Could not add component_id column to entity_components table: ${error}`);
    }
};

/**
 * Rollback/repair tool. Backfills the legacy `entity_components` mirror from
 * `components` (the single source of truth as of Phase 3). Only needed if you
 * intend to downgrade to a build that still reads `entity_components`
 * (BUNSANE_MEMBERSHIP_SOURCE=legacy).
 *
 * The framework no longer creates `entity_components` on boot. If the table is
 * absent this throws a clear error: create it first via
 * `CreateEntityComponentTable()`, then re-run this.
 *
 * Intended for a freshly-created/empty table: ON CONFLICT DO NOTHING skips
 * pre-existing rows, so `deleted_at` drift on them is not reconciled.
 */
export const PopulateComponentIds = async () => {
    const tableExists = await schemaQuery<unknown[]>('schema.PopulateComponentIds.select', `
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'entity_components'
        AND table_schema = 'public'
    `);
    if (!Array.isArray(tableExists) || tableExists.length === 0) {
        throw new Error(
            `Cannot populate entity_components: the table does not exist. ` +
            `It is no longer created since Phase 3 of the entity_components removal. ` +
            `If you need the legacy mirror (e.g. for a downgrade), run ` +
            `CreateEntityComponentTable() first, then re-run PopulateComponentIds(). ` +
            `Both live in database/maintenance.ts.`
        );
    }
    try {
        await db`INSERT INTO entity_components (entity_id, type_id, component_id, deleted_at)
                 SELECT c.entity_id, c.type_id, c.id, c.deleted_at
                 FROM components c
                 ON CONFLICT (entity_id, type_id) DO NOTHING`;
        await db`UPDATE entity_components
                 SET component_id = c.id
                 FROM components c
                 WHERE entity_components.entity_id = c.entity_id
                 AND entity_components.type_id = c.type_id
                 AND entity_components.component_id IS NULL`;

        logger.info(`Backfilled entity_components from components`);
    } catch (error) {
        logger.warn(`Could not backfill entity_components: ${error}`);
        throw error;
    }
};

/**
 * Copies a sample of live `components` rows into a temporary hash-partitioned
 * table and EXPLAINs a membership lookup. Not for boot. Requires a real
 * Postgres (`TABLESAMPLE`); do not call against a production primary casually.
 */
export const BenchmarkPartitionCounts = async (partitionCounts: number[] = [8, 16, 32]) => {
    const results: Array<{ partitionCount: number; planningTime: number; executionTime: number }> = [];

    for (const count of partitionCounts) {
        logger.info(`Benchmarking with ${count} partitions`);

        const tempTableName = `components_benchmark_${count}`;
        await schemaDdl('schema.BenchmarkPartitionCounts.create', `CREATE TABLE ${tempTableName} (
            id UUID,
            entity_id UUID,
            type_id varchar(64) NOT NULL,
            name varchar(128),
            data jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            PRIMARY KEY (id, type_id),
            UNIQUE(entity_id, type_id)
        ) PARTITION BY HASH (type_id);`);

        for (let i = 0; i < count; i++) {
            await schemaDdl('schema.BenchmarkPartitionCounts.create', `CREATE TABLE ${tempTableName}_p${i}
                PARTITION OF ${tempTableName}
                FOR VALUES WITH (MODULUS ${count}, REMAINDER ${i});`);
        }

        await schemaDdl('schema.BenchmarkPartitionCounts.insert', `INSERT INTO ${tempTableName} (id, entity_id, type_id, name, data, created_at, updated_at, deleted_at)
            SELECT id, entity_id, type_id, name, data, created_at, updated_at, deleted_at
            FROM components
            TABLESAMPLE BERNOULLI(10)
            LIMIT 10000;`);

        await schemaDdl('schema.BenchmarkPartitionCounts.create', `CREATE INDEX idx_${tempTableName}_type_id ON ${tempTableName} (type_id)`);
        await schemaDdl('schema.BenchmarkPartitionCounts.analyze', `ANALYZE ${tempTableName}`);

        const explainResult = await schemaDdl<Array<Record<string, unknown>>>('schema.BenchmarkPartitionCounts.explain', `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT DISTINCT ec.entity_id as id
            FROM ${getMembershipTable()} ec
            WHERE ec.type_id = (SELECT type_id FROM ${tempTableName} LIMIT 1)
            AND ec.deleted_at IS NULL`);

        const first = explainResult[0];
        const rawPlan = first?.['QUERY PLAN'];
        const plan: unknown = typeof rawPlan === 'string' ? JSON.parse(rawPlan) : first;
        const planning = plan && typeof plan === 'object' && 'Planning' in plan ? plan.Planning : undefined;
        const execution = plan && typeof plan === 'object' && 'Execution' in plan ? plan.Execution : undefined;
        const planningTime = planning && typeof planning === 'object' && 'Time' in planning && typeof planning.Time === 'number' ? planning.Time : 0;
        const executionTime = execution && typeof execution === 'object' && 'Time' in execution && typeof execution.Time === 'number' ? execution.Time : 0;

        results.push({
            partitionCount: count,
            planningTime,
            executionTime
        });

        await schemaDdl('schema.BenchmarkPartitionCounts.drop', `DROP TABLE ${tempTableName} CASCADE;`);

        logger.info(`Partition count ${count}: planning=${planningTime}ms, execution=${executionTime}ms`);
    }

    return results;
};
