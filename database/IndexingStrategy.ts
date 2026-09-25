import { DDL_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "./index";
import { dbExec } from "./gateway";
import { logger } from "../core/Logger";
import { boundIndexName } from "./indexReconciler";

/**
 * Catalog lookup — "does this index exist", "is this table partitioned".
 *
 * Gets the ordinary query budget rather than a bespoke number. These run at
 * boot too, where the database may be cold and `information_schema` scans are
 * slower than the millisecond they cost in steady state; inventing a tighter
 * limit here would turn a slow start into a failed one. Two budgets total —
 * query and DDL — is the whole rule.
 */
const catalogQuery = <T = any>(label: string, sql: string): Promise<T> =>
    dbExec<T>(sql, undefined, { lane: "background", label, timeoutMs: QUERY_TIMEOUT_MS });

/**
 * Schema DDL — index builds, ANALYZE, DROP INDEX.
 *
 * Long budget (`DDL_TIMEOUT_MS`, 10 min) because `CREATE INDEX CONCURRENTLY` on
 * a large table routinely outlives any query timeout. Aborting it would not stop
 * the build server-side (docs/POOLING.md B8a) — it would only make the framework
 * log a failure and potentially retry against a table already being indexed.
 *
 * Background lane, so a burst of index creation cannot take pool capacity from
 * request traffic. Bounding how many index builds run at once is a feature here,
 * not a cost.
 */
const ddlStatement = <T = any>(label: string, sql: string): Promise<T> =>
    dbExec<T>(sql, undefined, { lane: "background", label, timeoutMs: DDL_TIMEOUT_MS });

const validateIdentifier = (str: string, maxLength: number = 64): string => {
    if (!str || typeof str !== 'string' || str.length === 0 || str.length > maxLength) {
        throw new Error(`Invalid identifier: ${str}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
        throw new Error(`Invalid identifier format: ${str}`);
    }
    return str;
};

/** One catalog snapshot per boot. Callers pass this instead of querying pg_indexes per field. */
export type IndexBootContext = {
    existing: Set<string>;
    partitionStrategy: 'list' | 'hash' | null;
    indexCreated: boolean;
};

export function indexCatalogKey(tableName: string, indexName: string): string {
    return `${tableName}\0${indexName}`;
}

/** One pg_indexes read for every components* table. */
export async function loadComponentIndexCatalog(): Promise<Set<string>> {
    const rows = await catalogQuery<Array<{ tablename: string; indexname: string }>>("index.catalog", `
        SELECT tablename, indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename LIKE 'components%'
    `);
    const existing = new Set<string>();
    for (const row of rows) {
        if (row?.tablename && row?.indexname) existing.add(indexCatalogKey(row.tablename, row.indexname));
    }
    return existing;
}

async function indexAlreadyExists(tableName: string, indexName: string, boot?: IndexBootContext): Promise<boolean> {
    if (boot) return boot.existing.has(indexCatalogKey(tableName, indexName));
    const rows = await catalogQuery<Array<{ indexname: string }>>("index.exists", `
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = '${tableName}' AND indexname = '${indexName}'
    `);
    return rows.length > 0;
}

async function tableIsPartitioned(tableName: string, boot?: IndexBootContext): Promise<boolean> {
    if (boot) return boot.partitionStrategy === 'hash' && tableName === 'components';
    const partitionCheck = await catalogQuery<Array<{ relkind: string }>>("index.partitionCheck", `
        SELECT relkind
        FROM pg_class
        WHERE relname = '${tableName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `);
    return partitionCheck.length > 0 && partitionCheck[0]!.relkind === 'p';
}

function noteIndexCreated(boot: IndexBootContext | undefined, tableName: string, indexName: string): void {
    if (!boot) return;
    boot.existing.add(indexCatalogKey(tableName, indexName));
    boot.indexCreated = true;
}


export type IndexType = 'gin' | 'btree' | 'hash' | 'numeric' | 'fulltext';

export interface IndexDefinition {
    tableName: string;
    field: string;
    indexType: IndexType;
    isDateField?: boolean;
}

/**
 * Ensures a JSONB path-specific index exists on a table
 * @param tableName The table name to create index on
 * @param field The JSONB field path to index
 * @param indexType The type of index to create
 * @param isDateField Whether this field should be cast to DATE for BTREE indexing
 */
export const ensureJSONBPathIndex = async (
    tableName: string,
    field: string,
    indexType: IndexType = 'gin',
    isDateField: boolean = false,
    boot?: IndexBootContext,
): Promise<boolean> => {
    tableName = validateIdentifier(tableName);
    field = validateIdentifier(field);

    const indexName = boundIndexName(`idx_${tableName}_${field}_${indexType}${isDateField ? '_date' : ''}`);

    try {

        logger.trace(`Ensuring ${indexType.toUpperCase()} index ${indexName} on ${tableName} for field ${field}${isDateField ? ' (date field - indexed as text)' : ''}`);

        if (await indexAlreadyExists(tableName, indexName, boot)) {
            logger.trace(`Index ${indexName} already exists`);
            return false;
        }

        const isPartitioned = await tableIsPartitioned(tableName, boot);
        const useConcurrently = !isPartitioned && !process.env.USE_PGLITE;

        let indexSQL: string;

        switch (indexType) {
            case 'gin':
                // GIN indexes always use CONCURRENTLY for non-blocking operation (if not partitioned)
                indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} USING GIN ((data->'${field}') jsonb_path_ops)`;
                break;


            case 'hash':
                // HASH index (generally not recommended for JSONB fields)
                indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} USING HASH ((data->>'${field}'))`;
                break;

            default:
                throw new Error(`Unsupported index type: ${indexType}`);
        }

        logger.trace(`Creating index with SQL: ${indexSQL}`);
        await ddlStatement("index.create", indexSQL);
        logger.info(`Created ${indexType.toUpperCase()} index ${indexName} on ${tableName}${useConcurrently ? ' (concurrently)' : ' (blocking)'}`);
        noteIndexCreated(boot, tableName, indexName);
        return true;

    } catch (error: any) {
        // Check if the error is about duplicate key or relation already exists (race condition handling)
        if (error.message && (
            error.message.includes('duplicate key value violates unique constraint "pg_class_relname_nsp_index"') ||
            error.message.includes('already exists') ||
            error.code === '42P07' // PostgreSQL error code for duplicate_table/relation
        )) {
            logger.trace(`Index ${indexName} already exists (confirmed by error), skipping creation`);
            if (boot) boot.existing.add(indexCatalogKey(tableName, indexName));
            return false;
        }
        // Handle deadlock by checking if index was created by another process
        if (error.code === '40P01' || (error.message && error.message.includes('deadlock'))) {
            logger.warn(`Deadlock detected while creating index ${indexName}, checking if it exists now...`);
            // Wait a bit and check if index exists now (created by another process)
            await new Promise(resolve => setTimeout(resolve, 500));
            const checkAgain = await catalogQuery<any[]>("index.exists.recheck", `
                SELECT indexname FROM pg_indexes
                WHERE tablename = '${tableName}' AND indexname = '${indexName}'
            `);
            if (checkAgain.length > 0) {
                logger.trace(`Index ${indexName} was created by another process during deadlock`);
                return false;
            }
            // If still doesn't exist, log but don't throw - index creation is best-effort
            logger.warn(`Index ${indexName} still doesn't exist after deadlock, skipping`);
            return false;
        }
        logger.error(`Failed to create ${indexType} index on ${tableName} for field ${field}: ${error}`);
        throw error;
    }
};

/**
 * Ensures multiple JSONB path indexes exist on a table
 * @param tableName The table name to create indexes on
 * @param indexDefinitions Array of index definitions to create
 */
export const ensureMultipleJSONBPathIndexes = async (
    tableName: string,
    indexDefinitions: IndexDefinition[],
    boot?: IndexBootContext,
): Promise<boolean> => {
    let created = false;
    for (const def of indexDefinitions) {
        // btree/numeric are key indexes (bk_), created by the reconciler.
        if (def.indexType === 'btree' || def.indexType === 'numeric') continue;
        if (def.indexType === 'fulltext') {
            created = await ensureFullTextIndex(def.tableName, def.field, 'english', boot) || created;
        } else {
            created = await ensureJSONBPathIndex(
                def.tableName,
                def.field,
                def.indexType,
                def.isDateField,
                boot,
            ) || created;
        }
    }
    return created;
};

/**
 * Analyzes a table to update query planner statistics
 * @param tableName The table name to analyze
 */
export const analyzeTable = async (tableName: string): Promise<void> => {
    try {
        tableName = validateIdentifier(tableName);
        logger.trace(`Running ANALYZE on table ${tableName}`);
        await ddlStatement("index.analyze", `ANALYZE ${tableName}`);
        logger.info(`Completed ANALYZE on table ${tableName}`);
    } catch (error) {
        logger.error(`Failed to ANALYZE table ${tableName}: ${error}`);
        throw error;
    }
};


/**
 * Creates a GIN index on a JSONB field for full-text search using to_tsvector.
 *
 * The index expression MUST match FullTextSearchBuilder's vectorSql exactly:
 *   to_tsvector('<language>', <alias>.data->'<field>')
 * so PostgreSQL can use this index for those predicates.
 *
 * @param tableName The table name to create index on
 * @param field The JSONB field path containing text for full-text search
 * @param language PostgreSQL text search language (default 'english')
 */
export const ensureFullTextIndex = async (
    tableName: string,
    field: string,
    language: string = 'english',
    boot?: IndexBootContext,
): Promise<boolean> => {
    tableName = validateIdentifier(tableName);
    field = validateIdentifier(field);

    const indexName = boundIndexName(`idx_${tableName}_${field}_fts`);

    try {
        logger.trace(`Ensuring full-text GIN index ${indexName} on ${tableName} for field ${field} (language: ${language})`);

        if (await indexAlreadyExists(tableName, indexName, boot)) {
            logger.trace(`Index ${indexName} already exists`);
            return false;
        }

        const isPartitioned = await tableIsPartitioned(tableName, boot);
        const useConcurrently = !isPartitioned && !process.env.USE_PGLITE;

        // Expression matches FullTextSearchBuilder.vectorSql: to_tsvector('<lang>', data->'<field>')
        // The -> operator (not ->>) returns jsonb; PostgreSQL casts jsonb text to tsvector input.
        const indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} IF NOT EXISTS ${indexName} ON ${tableName} USING GIN (to_tsvector('${language}', data->'${field}'))`;

        logger.trace(`Creating full-text index with SQL: ${indexSQL}`);
        await ddlStatement("index.create", indexSQL);
        logger.info(`Created full-text GIN index ${indexName} on ${tableName}${useConcurrently ? ' (concurrently)' : ' (blocking)'}`);
        noteIndexCreated(boot, tableName, indexName);
        return true;

    } catch (error: any) {
        if (error.message && (
            error.message.includes('already exists') ||
            error.code === '42P07'
        )) {
            logger.trace(`Index ${indexName} already exists (confirmed by error), skipping creation`);
            if (boot) boot.existing.add(indexCatalogKey(tableName, indexName));
            return false;
        }
        if (error.code === '40P01' || (error.message && error.message.includes('deadlock'))) {
            logger.warn(`Deadlock detected while creating index ${indexName}, skipping`);
            return false;
        }
        logger.error(`Failed to create full-text index on ${tableName} for field ${field}: ${error}`);
        throw error;
    }
};

