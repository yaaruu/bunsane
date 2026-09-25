import db, { DDL_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "./index";
import { dbExec } from "./gateway";
import { logger as MainLogger } from "../core/Logger";
import { getMetadataStorage } from "../core/metadata";
import { ensureMultipleJSONBPathIndexes, type IndexBootContext, indexCatalogKey } from "./IndexingStrategy";
import { boundIndexName, ensureNumericKeyFunction } from "./indexReconciler";
import { ProjectionManager, qspActive } from "./projection";
const logger = MainLogger.child({ scope: "DatabaseHelper" });

/**
 * WHY THE `` db`…` `` TAGGED TEMPLATES IN THIS FILE ARE NOT MIGRATED
 *
 * The 37 `db.unsafe(...)` call sites route through the seam below. The 25
 * tagged-template statements do NOT, and that is deliberate: they are a
 * different WIRE PROTOCOL, not just different syntax. Bun sends `` db`…` ``
 * through the extended (prepared) path and `db.unsafe(sql)` through the simple
 * one, so rewriting one into the other silently changes how every one of those
 * statements is executed.
 *
 * Measured, not assumed: converting all 62 sites made the full suite fail with
 *   PostgresError: prepared statement
 *   "PSELECT DISTINCT ec.entity_id as id FROM $8" already exists   (42P05)
 * in an unrelated Query test. Bun derives a prepared statement's name from a
 * truncated prefix of the SQL, so shifting statements between protocols
 * changes which names get registered on a connection and two different queries
 * sharing a ~40-character prefix collide. Reverting only the tagged templates
 * (gateway still in place for the other 37) restored 1017/0, and bypassing the
 * gateway entirely while keeping the rewrite still failed — so the rewrite was
 * the cause and the seam was not.
 *
 * The cost of leaving them is small and bounded: all 25 are boot DDL that runs
 * before `armGateway()`, where admission is a passthrough anyway, so they would
 * gain only a timeout. The cost of converting them is a protocol change across
 * the whole schema path. They stay, with an allow-list entry in the grep ban.
 */

/**
 * Schema catalog reads — `information_schema`, `pg_indexes`, `pg_class`.
 *
 * Most of this module runs during boot, BEFORE `armGateway()`, so admission is
 * a passthrough there and the practical effect of routing through the seam is a
 * timeout, a label and a metric where previously there were none. That matters:
 * an unbounded catalog read against a wedged database is a boot that hangs
 * forever instead of failing.
 *
 * The lane matters for the calls that happen at RUNTIME — lazy partition attach
 * (`CreateComponentPartitionTable`), index maintenance, `ANALYZE` — which must
 * not take pool capacity from request traffic.
 *
 * `params` is optional and NOT defaulted to `[]`: see the note on `timedUnsafe`.
 * An empty array puts Bun on the extended (prepared) path, which is a different
 * protocol from passing nothing.
 */
const schemaQuery = <T = any>(label: string, sql: string, params?: any[]): Promise<T> =>
    dbExec<T>(sql, params, { lane: "background", label, timeoutMs: QUERY_TIMEOUT_MS });

/**
 * Schema DDL and bulk data migration.
 *
 * `DDL_TIMEOUT_MS` (10 min) because `CREATE INDEX CONCURRENTLY`, partition
 * attach on a populated table, and the one-off backfills here are long-running
 * by design. The bound exists so a wedged statement eventually releases its
 * admission permit, not as a target.
 */
const schemaDdl = <T = any>(label: string, sql: string, params?: any[]): Promise<T> =>
    dbExec<T>(sql, params, { lane: "background", label, timeoutMs: DDL_TIMEOUT_MS });

const BUNSANE_RELATION_TYPED_COLUMN = process.env.BUNSANE_RELATION_TYPED_COLUMN === 'true' || false;

const validateIdentifier = (str: string, maxLength: number = 64): string => {
    if (!str || typeof str !== 'string' || str.length === 0 || str.length > maxLength) {
        throw new Error(`Invalid identifier: ${str}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
        throw new Error(`Invalid identifier format: ${str}`);
    }
    return str;
}

/** Set after the components table is created or first successfully read. */
let partitionStrategyMemo: 'list' | 'hash' | null | undefined;

export function rememberPartitionStrategy(strategy: 'list' | 'hash' | null): void {
    partitionStrategyMemo = strategy;
}

async function readPartitionStrategyFromCatalog(): Promise<'list' | 'hash' | null> {
    const result = await schemaQuery<Array<{ strategy: 'list' | 'hash' | null }>>('schema.GetPartitionStrategy.select', `
        SELECT
            CASE
                WHEN partstrat = 'l' THEN 'list'
                WHEN partstrat = 'h' THEN 'hash'
                ELSE NULL
            END as strategy
        FROM pg_partitioned_table
        WHERE partrelid = (SELECT oid FROM pg_class WHERE relname = 'components' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
    `);
    return result.length > 0 ? result[0]!.strategy : null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryWithBackoff = async (fn: () => Promise<void>, maxRetries: number = 3, baseDelay: number = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await fn();
            return;
        } catch (error: any) {
            const isDeadlock = error?.code === '40P01' || error?.message?.includes('deadlock');
            if (i === maxRetries - 1) throw error;
            const delay = baseDelay * Math.pow(2, i);
            if (isDeadlock) {
                logger.warn(`Deadlock detected, retrying in ${delay}ms (attempt ${i + 1}/${maxRetries})`);
            } else {
                logger.warn(`Operation failed, retrying in ${delay}ms: ${error}`);
            }
            await sleep(delay);
        }
    }
};

export const GetSchema = async () => {
    const dbSchema = await db`SELECT table_name 
        FROM information_schema.tables 
    WHERE table_type = 'BASE TABLE' 
        AND table_schema NOT IN 
            ('pg_catalog', 'information_schema');`.values();
    const tables = dbSchema.map((row: string[]) => row[0]);
    return tables;
}

export const HasValidBaseTable = async (): Promise<boolean> => {
    const tables = await GetSchema();
    const neededTables = ["entities", "components"];
    return neededTables.every(t => tables.includes(t));
}

export const PrepareDatabase = async () => {
    logger.trace(`Initializing Database.`);
    try {
        await ensureNumericKeyFunction();
    } catch (error) {
        logger.error(`Failed to create numeric key function: ${error}`);
        throw error;
    }
    try {
        await SetupDatabaseExtensions();
    } catch (error) {
        logger.error(`Failed to setup database extensions: ${error}`);
        throw error;
    }
    try {
        await CreateEntityTable();
    } catch (error) {
        logger.error(`Failed to create entity table: ${error}`);
        throw error;
    }
    try {
        await CreateComponentTable();
    } catch (error) {
        logger.error(`Failed to create component table: ${error}`);
        throw error;
    }
    // `entity_components` is no longer created or written. `components`
    // (UNIQUE(entity_id, type_id)) is the single source of membership truth
    // as of Phase 3 of docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md.
    try {
        await MigrateTimestampsToTimestamptz();
    } catch (error) {
        logger.error(`Failed to migrate timestamp columns to timestamptz: ${error}`);
        throw error;
    }
    if (qspActive()) {
        try {
            await CreateProjectionStateTable();
        } catch (error) {
            logger.error(`Failed to create projection_state table: ${error}`);
            throw error;
        }
    }
}

/**
 * Auto-migrate base-table timestamp columns from `timestamp without time zone`
 * to `timestamptz`. Idempotent: only ALTERs columns still typed as bare
 * timestamp, so fresh DBs (created with TIMESTAMPTZ DDL) and already-migrated
 * DBs are no-ops. Existing bare-timestamp values are interpreted as UTC — the
 * framework only ever writes them via NOW()/CURRENT_TIMESTAMP, which assume the
 * DB session timezone; UTC is the correct assumption for any DB run in UTC.
 * `components` is partitioned — PostgreSQL propagates the type change to every
 * partition (a rewrite that briefly locks the table; one-time cost).
 */
export const MigrateTimestampsToTimestamptz = async () => {
    const targets: Array<{ table: string; columns: string[] }> = [
        { table: "entities", columns: ["created_at", "updated_at", "deleted_at"] },
        { table: "components", columns: ["created_at", "updated_at", "deleted_at"] },
    ];
    for (const { table, columns } of targets) {
        for (const col of columns) {
            const rows = await schemaQuery('schema.MigrateTimestampsToTimestamptz.select', `
                SELECT data_type FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${col}'
            `);
            if (rows.length === 0) continue; // table or column absent
            if ((rows[0] as any).data_type !== "timestamp without time zone") continue; // already timestamptz
            logger.warn(`Migrating ${table}.${col} timestamp → timestamptz (assuming stored values are UTC)...`);
            await schemaDdl('schema.MigrateTimestampsToTimestamptz.alter', `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE timestamptz USING ${col} AT TIME ZONE 'UTC'`);
        }
    }
}

export const GetDatabaseDataSize = async () => {
    const result = await db`SELECT
        relname AS table_name,
        pg_size_pretty(pg_total_relation_size(oid)) AS total_size_pretty,
        ROUND(pg_total_relation_size(oid) / (1024.0 * 1024.0), 2) AS total_size_mb
    FROM
        pg_class
    WHERE
        relkind = 'r' -- 'r' for regular table, 'p' for partitioned table
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') -- Or your specific schema
    ORDER BY
        pg_total_relation_size(oid) DESC;`;
    return result;
}


export const SetupDatabaseExtensions = async () => {
}
export const InitializeProjections = async () => {
    if (!qspActive()) return;
    try {
        await CreateProjectionStateTable();
        await ProjectionManager.instance.initialize();
    } catch (error) {
        logger.warn(`Failed to initialize projections: ${error}`);
    }
}

export const CreateEntityTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS entities (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
    );`;

    // Add partial index for soft-delete queries - critical for 1M+ scale
    // This allows efficient filtering of non-deleted entities
    await schemaDdl('schema.CreateEntityTable.create', `
        CREATE INDEX IF NOT EXISTS idx_entities_deleted_null
        ON entities (id)
        WHERE deleted_at IS NULL
    `);
}

export const CreateProjectionStateTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS projection_state (
        archetype text PRIMARY KEY,
        shape_hash text NOT NULL,
        status text NOT NULL DEFAULT 'DISABLED',
        shape_version int NOT NULL DEFAULT 1,
        watermark uuid,
        field_state jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
    );`;
}
export const CreateComponentTable = async () => {
    const partitionStrategy = process.env.BUNSANE_PARTITION_STRATEGY === 'hash' ? 'hash' : 'list'; // Default to list (LIST+Direct is the recommended strategy)

    // Check if the table already exists and what partitioning strategy it uses
    const existingStrategy = await readPartitionStrategyFromCatalog();
    const tableExists = await schemaQuery('schema.CreateComponentTable.select', `
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'components'
        AND table_schema = 'public'
    `);

    // If the table exists but has a different partitioning strategy, we need to recreate it
    if (tableExists.length > 0 && existingStrategy !== partitionStrategy) {
        await assertComponentDataSafeToDrop(existingStrategy, partitionStrategy);
        logger.warn(`Partitioning strategy changed from ${existingStrategy} to ${partitionStrategy}. Recreating components table...`);

        // Drop the existing table and all its partitions
        await schemaDdl('schema.CreateComponentTable.drop', `DROP TABLE IF EXISTS components CASCADE`);

        // Also clean up any orphaned partition tables
        await dropOrphanedPartitionTables();
    }

    if (partitionStrategy === 'hash') {
        await CreateHashPartitionedComponentTable();
    } else {
        // Original LIST partitioning
        await db`CREATE TABLE IF NOT EXISTS components (
            id UUID,
            entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
            type_id varchar(64) NOT NULL,
            name varchar(128),
            data jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            PRIMARY KEY (id, type_id),
            UNIQUE(entity_id, type_id)
        ) PARTITION BY LIST (type_id);`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components (entity_id)`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_type_id ON components (type_id)`;
        await ensureDataGinIndex();
        await db`CREATE INDEX IF NOT EXISTS idx_components_entity_type_deleted ON components (entity_id, type_id, deleted_at)`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_type_deleted ON components (type_id, deleted_at) WHERE deleted_at IS NULL`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_deleted_entity ON components (deleted_at, entity_id) WHERE deleted_at IS NULL`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_entity_created_desc ON components (entity_id, created_at DESC)`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_type_entity_created ON components (type_id, entity_id, created_at DESC)`;
    }
    rememberPartitionStrategy(partitionStrategy);
}

/**
 * Pure decision: may the components table be dropped for a partition strategy
 * switch? Returns null when safe, otherwise the refusal error message.
 */
export const partitionRecreateRefusal = (
    hasData: boolean,
    forceFlag: string | undefined,
    existingStrategy: string | null,
    requestedStrategy: string
): string | null => {
    if (!hasData) return null;
    if (forceFlag === 'true') return null;
    return (
        `Refusing to recreate 'components' table: partition strategy changed from '${existingStrategy}' to '${requestedStrategy}' but the table contains data. ` +
        `Recreating would permanently delete all component data. Options: ` +
        `(1) set BUNSANE_PARTITION_STRATEGY back to '${existingStrategy}' to keep the current layout; ` +
        `(2) back up component data, then restart once with BUNSANE_FORCE_PARTITION_RECREATE=true to drop and recreate (DESTRUCTIVE); ` +
        `(3) migrate the data manually to the new layout before switching.`
    );
}

export const assertComponentDataSafeToDrop = async (existingStrategy: string | null, requestedStrategy: string) => {
    let hasData = false;
    try {
        const rows = await schemaQuery('schema.assertComponentDataSafeToDrop.select', `SELECT 1 FROM components LIMIT 1`);
        hasData = rows.length > 0;
    } catch (error) {
        logger.warn(`Could not check components table for data before recreate: ${error}`);
    }

    const refusal = partitionRecreateRefusal(
        hasData,
        process.env.BUNSANE_FORCE_PARTITION_RECREATE,
        existingStrategy,
        requestedStrategy
    );
    if (refusal) throw new Error(refusal);

    if (hasData) {
        logger.warn(`BUNSANE_FORCE_PARTITION_RECREATE=true — dropping components table WITH DATA to switch partition strategy from '${existingStrategy}' to '${requestedStrategy}'. This permanently deletes all component data.`);
    }
}

const dropOrphanedPartitionTables = async () => {
    const orphanedPartitions = await schemaQuery('schema.assertComponentDataSafeToDrop.select', `
        SELECT tablename
        FROM pg_tables
        WHERE tablename LIKE 'components_%'
        AND schemaname = 'public'
        AND tablename != 'components'
    `);

    for (const partition of orphanedPartitions) {
        await schemaDdl('schema.assertComponentDataSafeToDrop.drop', `DROP TABLE IF EXISTS ${partition.tablename} CASCADE`);
    }

    if (orphanedPartitions.length > 0) {
        logger.info(`Cleaned up ${orphanedPartitions.length} orphaned partition tables`);
    }
}

/**
 * The whole-`data` GIN index (`idx_components_data_gin`) only serves top-level
 * JSONB containment / existence on the entire `data` column (`data @> ...`,
 * `data ? key`, `data ?| / ?&`). The Query layer never emits those forms — it
 * uses per-field text extraction (`data->>'field'`, served by per-field
 * btree/expression indexes) and sub-path containment (`data->'field' @> ...`,
 * served by per-field sub-path GIN). So this index is pure write amplification
 * for framework queries AND it blocks HOT updates (any `data` write must touch
 * it). It is therefore OPT-IN. Set BUNSANE_COMPONENTS_DATA_GIN=true only if you
 * run raw SQL doing top-level containment on the whole component payload.
 */
const ensureDataGinIndex = async (): Promise<void> => {
    if (process.env.BUNSANE_COMPONENTS_DATA_GIN === 'true') {
        await db`CREATE INDEX IF NOT EXISTS idx_components_data_gin ON components USING GIN (data)`;
        logger.info("Created whole-data GIN index idx_components_data_gin (BUNSANE_COMPONENTS_DATA_GIN=true).");
    } else {
        logger.info(
            "Skipped whole-data GIN index idx_components_data_gin to cut write amplification and enable HOT updates " +
            "(BUNSANE_COMPONENTS_DATA_GIN!=true). Per-field indexes serve all framework queries. A pre-existing DB " +
            "that still has it can drop it manually: DROP INDEX CONCURRENTLY IF EXISTS idx_components_data_gin;"
        );
    }
};

export const CreateHashPartitionedComponentTable = async (partitionCount: number = 16) => {
    await db`CREATE TABLE IF NOT EXISTS components (
        id UUID,
        entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        type_id varchar(64) NOT NULL,
        name varchar(128),
        data jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        PRIMARY KEY (id, type_id),
        UNIQUE(entity_id, type_id)
    ) PARTITION BY HASH (type_id);`;

    // Create hash partitions
    for (let i = 0; i < partitionCount; i++) {
        await schemaDdl('schema.CreateHashPartitionedComponentTable.create', `CREATE TABLE IF NOT EXISTS components_p${i}
            PARTITION OF components
            FOR VALUES WITH (MODULUS ${partitionCount}, REMAINDER ${i});`);
    }

    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components (entity_id)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_id ON components (type_id)`;
    await ensureDataGinIndex();
    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_type_deleted ON components (entity_id, type_id, deleted_at)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_deleted ON components (type_id, deleted_at) WHERE deleted_at IS NULL`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_deleted_entity ON components (deleted_at, entity_id) WHERE deleted_at IS NULL`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_created_desc ON components (entity_id, created_at DESC)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_entity_created ON components (type_id, entity_id, created_at DESC)`;
}
export const CreateComponentPartitionTable = async (
    comp_name: string,
    type_id: string,
    opts?: { strategy?: 'list' | 'hash' | null; boot?: IndexBootContext },
): Promise<boolean> => {
    comp_name = validateIdentifier(comp_name);
    logger.trace(`Attempt adding partition table for component: ${comp_name}`);

    const partitionStrategy = opts && opts.strategy !== undefined
        ? opts.strategy
        : await GetPartitionStrategy();
    logger.trace(`Current partition strategy: ${partitionStrategy}`);

    if (partitionStrategy === 'hash') {
        logger.info(`Component ${comp_name} will use existing hash partitions`);
        return false;
    }

    const table_name = GenerateTableName(comp_name);
    const existingPartition = await schemaQuery('schema.CreateComponentPartitionTable.select', `SELECT 1 FROM information_schema.tables
        WHERE table_name = '${table_name}'
        AND table_schema = 'public'`);
    if (existingPartition.length > 0) {
        logger.info(`Partition table ${table_name} already exists`);
        return false;
    }

    await retryWithBackoff(async () => {
        await schemaDdl('schema.CreateComponentPartitionTable.create', `CREATE TABLE IF NOT EXISTS ${table_name}
            PARTITION OF components
            FOR VALUES IN ('${type_id}')`);
    });
    logger.trace(`Successfully created partition table: ${table_name}`);

    const storage = getMetadataStorage();
    const componentId = storage.getComponentId(comp_name);
    const indexedFields = storage.getIndexedFields(componentId).filter(
        (field) => field.indexType !== "btree" && field.indexType !== "numeric",
    );
    if (indexedFields.length > 0) {
        const indexDefinitions = indexedFields.map(field => ({
            tableName: table_name,
            field: field.propertyKey,
            indexType: field.indexType,
            isDateField: field.isDateField
        }));
        await ensureMultipleJSONBPathIndexes(table_name, indexDefinitions, opts?.boot);
    }
    return true;
};

export const DeleteComponentPartitionTable = async (comp_name: string) => {
    try {
        comp_name = validateIdentifier(comp_name);
        
        // Check partitioning strategy
        const partitionStrategy = await GetPartitionStrategy();
        
        if (partitionStrategy === 'hash') {
            // For HASH partitioning, partitions are managed automatically
            // No individual partition tables to delete
            logger.info(`Component ${comp_name} uses hash partitions - no individual table to delete`);
            return;
        }
        
        // Original LIST partitioning logic
        const table_name = `components_${comp_name.toLowerCase().replace(/\s+/g, '_')}`;

        const existingPartition = await schemaQuery('schema.DeleteComponentPartitionTable.select', `
            SELECT 1 FROM information_schema.tables
            WHERE table_name = '${table_name}'
            AND table_schema = 'public'
        `);

        if (existingPartition.length === 0) {
            logger.info(`Partition table ${table_name} does not exist`);
            return;
        }

        await retryWithBackoff(async () => {
            await schemaDdl('schema.DeleteComponentPartitionTable.drop', `DROP TABLE IF EXISTS ${table_name}`);
        });
        logger.info(`Successfully deleted partition table: ${table_name}`);

    } catch (error) {
        logger.error(`Failed to delete component partition table for ${comp_name}: ${error}`);
        // Graceful degradation: log error without crashing
    }
}


export const EnsureDatabaseMigrations = async () => {
    logger.trace(`Checking for database migrations...`);
    await ensureNumericKeyFunction();

    // `entity_components` is no longer created, migrated, or written (Phase 3
    // of docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md). Any pre-existing table is
    // left in place, untouched — never auto-dropped. Membership now lives
    // solely in `components` (UNIQUE(entity_id, type_id)). To backfill the
    // legacy table for a downgrade, import `PopulateComponentIds` from
    // `database/maintenance.ts` (after `CreateEntityComponentTable()`).
    const orphanCheck = await schemaQuery('schema.EnsureDatabaseMigrations.select', `
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'entity_components'
        AND table_schema = 'public'
    `);
    if (orphanCheck.length > 0) {
        logger.info(
            `[entity_components] Orphaned table detected. ` +
            `This table is no longer used by the framework (see docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md). ` +
            `Verify your upgrade succeeded (run a smoke-test query against the 'components' table), ` +
            `then drop the orphan manually: DROP TABLE entity_components;`
        );
    }
}

export const AnalyzeAllComponentTables = async (): Promise<void> => {
    try {
        logger.trace(`Analyzing all component tables`);

        // Check partitioning strategy
        const partitionStrategy = await GetPartitionStrategy();
        
        let tablePattern: string;
        if (partitionStrategy === 'hash') {
            // For hash partitioning, analyze the hash partition tables
            tablePattern = 'components_p%';
        } else {
            // For list partitioning, analyze the component-specific partition tables
            tablePattern = 'components_%';
        }

        // Get all component partition tables
        const tables = await schemaQuery('schema.AnalyzeAllComponentTables.select', `
            SELECT tablename
            FROM pg_tables
            WHERE tablename LIKE '${tablePattern}' AND schemaname = 'public'
        `);

        for (const row of tables) {
            logger.trace(`Running ANALYZE on table ${row.tablename}`);
            await schemaDdl('schema.AnalyzeAllComponentTables.analyze', `ANALYZE ${row.tablename}`);
            logger.trace(`Completed ANALYZE on table ${row.tablename}`);
        }

        logger.info(`Completed ANALYZE on ${tables.length} component tables`);
    } catch (error) {
        logger.error(`Failed to analyze component tables: ${error}`);
        throw error;
    }
}

export const GetPartitionStrategy = async (): Promise<'list' | 'hash' | null> => {
    if (partitionStrategyMemo !== undefined) return partitionStrategyMemo;
    try {
        const strategy = await readPartitionStrategyFromCatalog();
        if (strategy) partitionStrategyMemo = strategy;
        return strategy;
    } catch (error) {
        logger.warn(`Could not determine partition strategy: ${error}`);
        return null;
    }
}


export const GenerateTableName = (name: string) => `components_${name.toLowerCase().replace(/\s+/g, '_')}`;

/**
 * Creates a GIN index on a JSONB foreign key field for optimized relation queries.
 * This significantly improves @HasMany and @BelongsTo relation resolution performance.
 *
 * @param tableName The component table name (e.g., 'components_userprofile')
 * @param foreignKeyField The JSONB field name that holds the foreign key (e.g., 'user_id')
 * @returns Promise<boolean> - true if index was created, false if it already exists
 *
 * @example
 * // Create index for user_id foreign key
 * await CreateForeignKeyIndex('components_userprofile', 'user_id');
 */
export const CreateForeignKeyIndex = async (
    tableName: string,
    foreignKeyField: string,
    boot?: IndexBootContext,
): Promise<boolean> => {
    tableName = validateIdentifier(tableName);
    foreignKeyField = validateIdentifier(foreignKeyField);

    const indexName = boundIndexName(`idx_${tableName}_fk_${foreignKeyField}`);
    const catalogKey = indexCatalogKey(tableName, indexName);
    if (boot?.existing.has(catalogKey)) {
        logger.trace(`Foreign key index ${indexName} already exists`);
        return false;
    }

    if (!boot) {
        const existingIndex = await schemaQuery('schema.CreateForeignKeyIndex.select', `
            SELECT 1 FROM pg_indexes
            WHERE tablename = '${tableName}' AND indexname = '${indexName}'
        `);
        if (existingIndex.length > 0) {
            logger.trace(`Foreign key index ${indexName} already exists`);
            return false;
        }
    }

    const partitionStrategy = boot?.partitionStrategy ?? await GetPartitionStrategy();
    const useConcurrently = partitionStrategy !== 'hash' && !process.env.USE_PGLITE;

    try {
        await retryWithBackoff(async () => {
            await schemaDdl('schema.CreateForeignKeyIndex.create', `
                CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} IF NOT EXISTS ${indexName}
                ON ${tableName} ((data->>'${foreignKeyField}'))
                WHERE deleted_at IS NULL
            `);
        });
        if (boot) {
            boot.existing.add(catalogKey);
            boot.indexCreated = true;
        }
        logger.info(`Created foreign key index ${indexName} on ${tableName}.data->>'${foreignKeyField}'`);
        return true;
    } catch (error: any) {
        if (error.message?.includes('duplicate key value violates unique constraint')) {
            logger.trace(`Foreign key index ${indexName} already exists (concurrent creation)`);
            if (boot) boot.existing.add(catalogKey);
            return false;
        }
        throw error;
    }
};

/**
 * Creates foreign key indexes for all relation fields defined in archetypes.
 * Should be called during database initialization for optimal relation query performance.
 */
export const CreateRelationIndexes = async (boot?: IndexBootContext): Promise<boolean> => {
    const storage = getMetadataStorage();
    const createdIndexes: string[] = [];

    for (const [archetypeId, relations] of storage.archetypes_relations_map) {
        for (const relation of relations) {
            if (!relation.options?.foreignKey) continue;

            const foreignKey = relation.options.foreignKey;
            if (foreignKey.includes('.')) continue;

            const archetypeMetadata = storage.archetypes.find(a =>
                storage.getComponentId(a.name) === archetypeId || a.typeId === archetypeId
            );

            if (!archetypeMetadata) continue;

            const archetypeFields = storage.archetypes_field_map.get(archetypeId) || [];

            for (const field of archetypeFields) {
                const componentId = storage.getComponentId(field.component.name);
                const componentProps = storage.getComponentProperties(componentId);
                const hasForeignKey = componentProps.some(prop => prop.propertyKey === foreignKey);

                if (hasForeignKey) {
                    const tableName = GenerateTableName(field.component.name);
                    try {
                        const created = await CreateForeignKeyIndex(tableName, foreignKey, boot);
                        if (created) {
                            createdIndexes.push(`${tableName}.${foreignKey}`);
                        }
                    } catch (error) {
                        logger.warn(`Failed to create FK index for ${tableName}.${foreignKey}: ${error}`);
                    }
                }
            }
        }
    }

    if (createdIndexes.length > 0) {
        logger.info(`Created ${createdIndexes.length} relation foreign key indexes`);
    }
    return createdIndexes.length > 0;
};
