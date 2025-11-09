import db from "database";
import { logger as MainLogger } from "core/Logger";
const logger = MainLogger.child({ scope: "DatabaseHelper" });

const BUNSANE_RELATION_TYPED_COLUMN = process.env.BUNSANE_RELATION_TYPED_COLUMN === 'true' || false;

const validateIdentifier = (str: string, maxLength: number = 64): string => {
    if (!str || typeof str !== 'string' || str.length === 0 || str.length > maxLength) {
        throw new Error(`Invalid identifier: ${str}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
        throw new Error(`Invalid identifier format: ${str}`);
    }
    return str;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryWithBackoff = async (fn: () => Promise<void>, maxRetries: number = 3, baseDelay: number = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await fn();
            return;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = baseDelay * Math.pow(2, i);
            logger.warn(`Operation failed, retrying in ${delay}ms: ${error}`);
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
    const neededTables = ["entities", "components", "entity_components"];
    return neededTables.every(t => tables.includes(t));
}

export const PrepareDatabase = async () => {
    logger.trace(`Initializing Database.`);
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
    try {
        await CreateEntityComponentTable();
        await PopulateComponentIds();
    } catch (error) {
        logger.error(`Failed to create entity component table: ${error}`);
        throw error;
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

export const CreateEntityTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS entities (
        id UUID PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP
    );`;
}

export const CreateComponentTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS components (
        id UUID,
        entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        type_id varchar(64) NOT NULL,
        name varchar(128),
        data jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP,
        PRIMARY KEY (id, type_id),
        UNIQUE(entity_id, type_id)
    ) PARTITION BY LIST (type_id);`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components (entity_id)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_id ON components (type_id)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_data_gin ON components USING GIN (data)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_type_deleted ON components (entity_id, type_id, deleted_at)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_deleted ON components (type_id, deleted_at) WHERE deleted_at IS NULL`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_deleted_entity ON components (deleted_at, entity_id) WHERE deleted_at IS NULL`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_entity_created_desc ON components (entity_id, created_at DESC)`;
    await db`CREATE INDEX IF NOT EXISTS idx_components_type_entity_created ON components (type_id, entity_id, created_at DESC)`;
}
export const UpdateComponentIndexes = async (table_name: string, indexedProperties: string[]) => {
    try {
        table_name = validateIdentifier(table_name);
        indexedProperties = indexedProperties.map(prop => validateIdentifier(prop));
        logger.trace(`Updating indexes for component table: ${table_name}`);
        const indexes_list = await db.unsafe(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = '${table_name}'
        `);
        const existingIndexes = indexes_list.map((row: any) => row.indexname);
        const addedIndexes = new Set<string>();

        // Check and create indexes for any new indexed properties
        if (indexedProperties && indexedProperties.length > 0) {
            for (const prop of indexedProperties) {
                const indexName = `idx_${table_name}_${prop}_gin`;
                if (!existingIndexes.includes(indexName)) {
                    logger.trace(`Creating missing index ${indexName} for property ${prop}`);
                    await retryWithBackoff(async () => {
                        await db.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${table_name} USING GIN ((data->'${prop}'))`);
                    });
                    addedIndexes.add(indexName);
                } else {
                    logger.trace(`Index ${indexName} for property ${prop} already exists`);
                }
            }
        }

        // Remove indexes for properties that are no longer indexed
        for (const index of existingIndexes) {
            const match = index.match(new RegExp(`^idx_${table_name}_(.*)_gin$`));
            if (match) {
                const prop = match[1];
                if (!indexedProperties.includes(prop) && !addedIndexes.has(index)) {
                    await retryWithBackoff(async () => {
                        await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
                    });
                    logger.info(`Dropped obsolete index ${index} for property ${prop}`);
                }
            }
        }
    } catch (error) {
        logger.error(`Failed to update component indexes for ${table_name}: ${error}`);
        throw error;
    }
}

//TODO: Cleanup and optimize
export const CreateComponentPartitionTable = async (comp_name: string, type_id: string) => {
    try {
        comp_name = validateIdentifier(comp_name);
        logger.trace(`Attempt adding partition table for component: ${comp_name}`);
        // const table_name = `components_${comp_name.toLowerCase().replace(/\s+/g, '_')}`;
        const table_name = GenerateTableName(comp_name);
        logger.trace(`Checking for existing partition table: ${table_name}`);
        const existingPartition = await db.unsafe(`SELECT 1 FROM information_schema.tables 
            WHERE table_name = '${table_name}' 
            AND table_schema = 'public'`);
        logger.trace(`Existing partition check result: ${existingPartition.length > 0 ? 'found' : 'not found'}`);

        if (existingPartition.length > 0) {
            logger.info(`Partition table ${table_name} already exists`);
            return;
        }
        logger.trace(`Creating partition table: ${table_name}`);

        await retryWithBackoff(async () => {
            await db.unsafe(`CREATE TABLE IF NOT EXISTS ${table_name}
                PARTITION OF components
                FOR VALUES IN ('${type_id}')`);
        });
        logger.trace(`Successfully created partition table: ${table_name}`);

        // TODO: Not sure if this is needed here or should be handled separately
        // if (BUNSANE_RELATION_TYPED_COLUMN && indexedProperties?.includes('value')) {
        //     logger.trace(`Adding typed FK column for ${table_name}`);
        //     await retryWithBackoff(async () => {
        //         await db.unsafe(`ALTER TABLE ${table_name} ADD COLUMN IF NOT EXISTS fk_id UUID GENERATED ALWAYS AS ((data->>'value')::UUID) STORED`);
        //     });
        //     await retryWithBackoff(async () => {
        //         await db.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table_name}_fk_id ON ${table_name} (fk_id)`);
        //     });
        //     logger.trace(`Added fk_id column and index for ${table_name}`);
        // }
        
    } catch (error) {
        logger.error(`Failed to create component partition table for ${comp_name}: ${error}`);
        // Graceful degradation: log error without crashing
    }
}

export const DeleteComponentPartitionTable = async (comp_name: string) => {
    try {
        comp_name = validateIdentifier(comp_name);
        const table_name = `components_${comp_name.toLowerCase().replace(/\s+/g, '_')}`;

        const existingPartition = await db.unsafe(`
            SELECT 1 FROM information_schema.tables
            WHERE table_name = '${table_name}'
            AND table_schema = 'public'
        `);

        if (existingPartition.length === 0) {
            logger.info(`Partition table ${table_name} does not exist`);
            return;
        }

        await retryWithBackoff(async () => {
            await db.unsafe(`DROP TABLE IF EXISTS ${table_name}`);
        });
        logger.info(`Successfully deleted partition table: ${table_name}`);

    } catch (error) {
        logger.error(`Failed to delete component partition table for ${comp_name}: ${error}`);
        // Graceful degradation: log error without crashing
    }
}

export const CreateEntityComponentTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS entity_components (
        entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        type_id VARCHAR(64) NOT NULL,
        component_id UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP,
        UNIQUE(entity_id, type_id)
    );`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_entity_id ON entity_components (entity_id)`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_type_id ON entity_components (type_id)`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_type_entity ON entity_components (type_id, entity_id)`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_type_entity_deleted ON entity_components (type_id, entity_id, deleted_at)`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_deleted_type ON entity_components (deleted_at, type_id) WHERE deleted_at IS NULL`;
    await db`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_components_component_id ON entity_components (component_id)`;
    
    // Add component_id column if it doesn't exist (for backward compatibility)
    try {
        await db`ALTER TABLE entity_components ADD COLUMN IF NOT EXISTS component_id UUID`;
        logger.info(`Added component_id column to entity_components table`);
    } catch (error) {
        logger.warn(`Could not add component_id column to entity_components table: ${error}`);
    }
}

export const PopulateComponentIds = async () => {
    try {
        // Populate component_id for existing rows that don't have it set
        await db`UPDATE entity_components 
                 SET component_id = c.id 
                 FROM components c 
                 WHERE entity_components.entity_id = c.entity_id 
                 AND entity_components.type_id = c.type_id 
                 AND entity_components.component_id IS NULL`;
        
        logger.info(`Populated component_id for existing entity_components rows`);
    } catch (error) {
        logger.warn(`Could not populate component_id for existing rows: ${error}`);
    }
}

export const EnsureDatabaseMigrations = async () => {
    logger.trace(`Checking for database migrations...`);
    
    try {
        // First, ensure the table exists and has the basic structure
        await CreateEntityComponentTable();
        
        // Check if entity_components table has component_id column
        const columnCheck = await db`SELECT column_name FROM information_schema.columns 
                                     WHERE table_name = 'entity_components' 
                                     AND column_name = 'component_id' 
                                     AND table_schema = 'public'`;
        
        if (columnCheck.length === 0) {
            logger.info(`entity_components table missing component_id column, adding it...`);
            // Add the column
            await db`ALTER TABLE entity_components ADD COLUMN component_id UUID`;
            logger.info(`Added component_id column to entity_components table`);
            
            // Wait a bit for the column to be available
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Populate existing data
            await PopulateComponentIds();
        } else {
            logger.trace(`entity_components table already has component_id column`);
        }
    } catch (error) {
        logger.error(`Failed during database migration: ${error}`);
        // Try to add the column anyway in case the check failed
        try {
            await db`ALTER TABLE entity_components ADD COLUMN IF NOT EXISTS component_id UUID`;
            logger.info(`Attempted to add component_id column as fallback`);
        } catch (fallbackError) {
            logger.error(`Fallback column addition also failed: ${fallbackError}`);
        }
    }
}

export const GenerateTableName = (name: string) => `components_${name.toLowerCase().replace(/\s+/g, '_')}`;