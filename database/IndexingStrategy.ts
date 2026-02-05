import db from "./index";
import { logger } from "../core/Logger";

const validateIdentifier = (str: string, maxLength: number = 64): string => {
    if (!str || typeof str !== 'string' || str.length === 0 || str.length > maxLength) {
        throw new Error(`Invalid identifier: ${str}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
        throw new Error(`Invalid identifier format: ${str}`);
    }
    return str;
};

export type IndexType = 'gin' | 'btree' | 'hash' | 'numeric';

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
    isDateField: boolean = false
): Promise<void> => {
    tableName = validateIdentifier(tableName);
    field = validateIdentifier(field);

    const indexName = `idx_${tableName}_${field}_${indexType}${isDateField ? '_date' : ''}`;

    try {

        logger.trace(`Ensuring ${indexType.toUpperCase()} index ${indexName} on ${tableName} for field ${field}${isDateField ? ' (date field - indexed as text)' : ''}`);

        // Check if index already exists
        const existingIndexes = await db.unsafe(`
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = '${tableName}' AND indexname = '${indexName}'
        `);

        if (existingIndexes.length > 0) {
            logger.trace(`Index ${indexName} already exists`);
            return;
        }

        // Check if table is partitioned
        const partitionCheck = await db.unsafe(`
            SELECT relkind
            FROM pg_class
            WHERE relname = '${tableName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `);

        const isPartitioned = partitionCheck.length > 0 && partitionCheck[0].relkind === 'p';
        const useConcurrently = !isPartitioned; // Cannot use CONCURRENTLY on partitioned tables

        let indexSQL: string;

        switch (indexType) {
            case 'gin':
                // GIN indexes always use CONCURRENTLY for non-blocking operation (if not partitioned)
                indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} USING GIN ((data->'${field}') jsonb_path_ops)`;
                break;

            case 'btree':
                if (isDateField) {
                    // BTREE index on date field - store as text and let PostgreSQL handle conversions at query time
                    // Note: Direct casting in index expressions requires IMMUTABLE functions
                    // Storing as text allows the index to work while queries can still cast when filtering
                    indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} ((data->>'${field}'))`;
                } else {
                    // BTREE index on text field
                    indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} ((data->>'${field}'))`;
                }
                break;

            case 'hash':
                // HASH index (generally not recommended for JSONB fields)
                indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName} ON ${tableName} USING HASH ((data->>'${field}'))`;
                break;

            default:
                throw new Error(`Unsupported index type: ${indexType}`);
        }

        logger.trace(`Creating index with SQL: ${indexSQL}`);
        await db.unsafe(indexSQL);
        logger.info(`Created ${indexType.toUpperCase()} index ${indexName} on ${tableName}${useConcurrently ? ' (concurrently)' : ' (blocking)'}`);

    } catch (error: any) {
        // Check if the error is about duplicate key or relation already exists (race condition handling)
        if (error.message && (
            error.message.includes('duplicate key value violates unique constraint "pg_class_relname_nsp_index"') ||
            error.message.includes('already exists') ||
            error.code === '42P07' // PostgreSQL error code for duplicate_table/relation
        )) {
            logger.trace(`Index ${indexName} already exists (confirmed by error), skipping creation`);
            return;
        }
        // Handle deadlock by checking if index was created by another process
        if (error.code === '40P01' || (error.message && error.message.includes('deadlock'))) {
            logger.warn(`Deadlock detected while creating index ${indexName}, checking if it exists now...`);
            // Wait a bit and check if index exists now (created by another process)
            await new Promise(resolve => setTimeout(resolve, 500));
            const checkAgain = await db.unsafe(`
                SELECT indexname FROM pg_indexes
                WHERE tablename = '${tableName}' AND indexname = '${indexName}'
            `);
            if (checkAgain.length > 0) {
                logger.trace(`Index ${indexName} was created by another process during deadlock`);
                return;
            }
            // If still doesn't exist, log but don't throw - index creation is best-effort
            logger.warn(`Index ${indexName} still doesn't exist after deadlock, skipping`);
            return;
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
    indexDefinitions: IndexDefinition[]
): Promise<void> => {
    for (const def of indexDefinitions) {
        if (def.indexType === 'numeric') {
            // Use numeric index for range queries
            await ensureNumericIndex(def.tableName, def.field);
        } else {
            await ensureJSONBPathIndex(
                def.tableName,
                def.field,
                def.indexType,
                def.isDateField
            );
        }
    }
};

/**
 * Analyzes a table to update query planner statistics
 * @param tableName The table name to analyze
 */
export const analyzeTable = async (tableName: string): Promise<void> => {
    try {
        tableName = validateIdentifier(tableName);
        logger.trace(`Running ANALYZE on table ${tableName}`);
        await db.unsafe(`ANALYZE ${tableName}`);
        logger.info(`Completed ANALYZE on table ${tableName}`);
    } catch (error) {
        logger.error(`Failed to ANALYZE table ${tableName}: ${error}`);
        throw error;
    }
};

/**
 * Analyzes all component partition tables
 */
/**
 * Creates a functional index on a JSONB numeric field for efficient range queries.
 * This is critical for queries like `WHERE (data->>'age')::numeric BETWEEN 25 AND 35`
 *
 * @param tableName The table name to create index on
 * @param field The JSONB field path containing numeric values
 */
export const ensureNumericIndex = async (
    tableName: string,
    field: string
): Promise<void> => {
    tableName = validateIdentifier(tableName);
    field = validateIdentifier(field);

    const indexName = `idx_${tableName}_${field}_numeric`;

    try {
        logger.trace(`Ensuring numeric index ${indexName} on ${tableName} for field ${field}`);

        // Check if index already exists
        const existingIndexes = await db.unsafe(`
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = '${tableName}' AND indexname = '${indexName}'
        `);

        if (existingIndexes.length > 0) {
            logger.trace(`Index ${indexName} already exists`);
            return;
        }

        // Check if table is partitioned
        const partitionCheck = await db.unsafe(`
            SELECT relkind
            FROM pg_class
            WHERE relname = '${tableName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `);

        const isPartitioned = partitionCheck.length > 0 && partitionCheck[0].relkind === 'p';
        const useConcurrently = !isPartitioned;

        // Create a partial index that only includes rows where the field is a valid number
        // This prevents errors when some rows have non-numeric values
        const indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName}
            ON ${tableName} (((data->>'${field}')::numeric))
            WHERE data->>'${field}' IS NOT NULL
            AND data->>'${field}' ~ '^-?[0-9]+\\.?[0-9]*$'`;

        logger.trace(`Creating numeric index with SQL: ${indexSQL}`);
        await db.unsafe(indexSQL);
        logger.info(`Created numeric index ${indexName} on ${tableName}${useConcurrently ? ' (concurrently)' : ' (blocking)'}`);

    } catch (error: any) {
        if (error.message && (
            error.message.includes('already exists') ||
            error.code === '42P07'
        )) {
            logger.trace(`Index ${indexName} already exists (confirmed by error), skipping creation`);
            return;
        }
        if (error.code === '40P01' || (error.message && error.message.includes('deadlock'))) {
            logger.warn(`Deadlock detected while creating index ${indexName}, skipping`);
            return;
        }
        logger.error(`Failed to create numeric index on ${tableName} for field ${field}: ${error}`);
        throw error;
    }
};

/**
 * Creates a composite index on multiple JSONB fields for efficient combined filter queries.
 * Useful for queries like `WHERE status = 'active' AND age >= 21`
 *
 * @param tableName The table name to create index on
 * @param fields Array of field definitions with type information
 */
export const ensureCompositeIndex = async (
    tableName: string,
    fields: Array<{ name: string; type: 'text' | 'numeric' | 'boolean' }>
): Promise<void> => {
    tableName = validateIdentifier(tableName);
    fields.forEach(f => validateIdentifier(f.name));

    const fieldNames = fields.map(f => f.name).join('_');
    const indexName = `idx_${tableName}_${fieldNames}_composite`;

    try {
        logger.trace(`Ensuring composite index ${indexName} on ${tableName}`);

        // Check if index already exists
        const existingIndexes = await db.unsafe(`
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = '${tableName}' AND indexname = '${indexName}'
        `);

        if (existingIndexes.length > 0) {
            logger.trace(`Index ${indexName} already exists`);
            return;
        }

        // Check if table is partitioned
        const partitionCheck = await db.unsafe(`
            SELECT relkind
            FROM pg_class
            WHERE relname = '${tableName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `);

        const isPartitioned = partitionCheck.length > 0 && partitionCheck[0].relkind === 'p';
        const useConcurrently = !isPartitioned;

        // Build index expressions for each field
        const indexExpressions = fields.map(f => {
            switch (f.type) {
                case 'numeric':
                    return `((data->>'${f.name}')::numeric)`;
                case 'boolean':
                    return `((data->>'${f.name}')::boolean)`;
                default:
                    return `(data->>'${f.name}')`;
            }
        }).join(', ');

        const indexSQL = `CREATE INDEX${useConcurrently ? ' CONCURRENTLY' : ''} ${indexName}
            ON ${tableName} (${indexExpressions})`;

        logger.trace(`Creating composite index with SQL: ${indexSQL}`);
        await db.unsafe(indexSQL);
        logger.info(`Created composite index ${indexName} on ${tableName}${useConcurrently ? ' (concurrently)' : ' (blocking)'}`);

    } catch (error: any) {
        if (error.message && (
            error.message.includes('already exists') ||
            error.code === '42P07'
        )) {
            logger.trace(`Index ${indexName} already exists (confirmed by error), skipping creation`);
            return;
        }
        if (error.code === '40P01' || (error.message && error.message.includes('deadlock'))) {
            logger.warn(`Deadlock detected while creating index ${indexName}, skipping`);
            return;
        }
        logger.error(`Failed to create composite index on ${tableName}: ${error}`);
        throw error;
    }
};

export const analyzeAllComponentTables = async (): Promise<void> => {
    try {
        logger.trace(`Analyzing all component tables`);

        // Get all component partition tables
        const tables = await db.unsafe(`
            SELECT tablename
            FROM pg_tables
            WHERE tablename LIKE 'components_%' AND schemaname = 'public'
        `);

        for (const row of tables) {
            await analyzeTable(row.tablename);
        }

        logger.info(`Completed ANALYZE on ${tables.length} component tables`);
    } catch (error) {
        logger.error(`Failed to analyze component tables: ${error}`);
        throw error;
    }
};