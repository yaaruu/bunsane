import db from "database";
import { logger as MainLogger } from "core/Logger";
const logger = MainLogger.child({ scope: "DatabaseHelper" });

const BUNSANE_RELATION_TYPED_COLUMN = process.env.BUNSANE_RELATION_TYPED_COLUMN === 'true' || false;

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
    await SetupDatabaseExtensions();
    await CreateEntityTable();
    await CreateComponentTable();
    await CreateEntityComponentTable();
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
    return new Promise(async resolve => {
        // await db`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`;
        return resolve(true);
    })
}

export const CreateEntityTable = async () => {
    return new Promise(async resolve => {
        await db`CREATE TABLE IF NOT EXISTS entities (
            id UUID PRIMARY KEY,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            deleted_at TIMESTAMP
        );`;
        return resolve(true);
    });
}

export const CreateComponentTable = () => {
    return new Promise(async resolve => {
        await db`CREATE TABLE IF NOT EXISTS components (
            id UUID,
            entity_id UUID REFERENCES entities(id),
            type_id varchar(64) NOT NULL,
            name varchar(128),
            data jsonb,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            deleted_at TIMESTAMP,
            PRIMARY KEY (id, type_id, entity_id)
        ) PARTITION BY LIST (type_id);`;
        await db`CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components (entity_id);`
        await db`CREATE INDEX IF NOT EXISTS idx_components_type_id ON components (type_id);`
        await db`CREATE INDEX IF NOT EXISTS idx_components_data_gin ON components USING GIN (data);`
        return resolve(true);
    });
}

export const UpdateComponentIndexes = async (table_name: string, indexedProperties: string[]) => {
    try {
        logger.trace(`Updating indexes for component table: ${table_name}`);
        const indexes_list = await db`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = ${table_name}
        `;
        const existingIndexes = indexes_list.map((row: any) => row.indexname);
        const addedIndexes = new Set<string>();

        // Check and create indexes for any new indexed properties
        if (indexedProperties && indexedProperties.length > 0) {
            for (const prop of indexedProperties) {
                const indexName = `idx_${table_name}_${prop}_gin`;
                if (!existingIndexes.includes(indexName)) {
                    logger.trace(`Creating missing index ${indexName} for property ${prop}`);
                    await db.unsafe(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table_name} USING GIN ((data->'${prop}'))`);
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
                    await db.unsafe(`DROP INDEX IF EXISTS ${index}`);
                    logger.info(`Dropped obsolete index ${index} for property ${prop}`);
                }
            }
        }
    } catch (error) {
        logger.error(`Failed to update component indexes for ${table_name}: ${error}`);
        throw error;
    }
}


export const CreateComponentPartitionTable = async (comp_name: string, type_id: string, indexedProperties?: string[]) => {
    try {
        logger.trace(`Attempt adding partition table for component: ${comp_name}`);
        const table_name = `components_${comp_name.toLowerCase().replace(/\s+/g, '_')}`;
        logger.trace(`Checking for existing partition table: ${table_name}`);
        const existingPartition = await db`
            SELECT 1 FROM information_schema.tables 
            WHERE table_name = ${table_name} 
            AND table_schema = 'public'
        `;
        logger.trace(`Existing partition check result: ${existingPartition.length > 0 ? 'found' : 'not found'}`);

        if (existingPartition.length > 0) {
            logger.info(`Partition table ${table_name} already exists`);
            return;
        }
        logger.trace(`Creating partition table: ${table_name}`);

        await db.unsafe(`CREATE TABLE IF NOT EXISTS ${table_name}
                PARTITION OF components
                FOR VALUES IN ('${type_id}');`);
        logger.trace(`Successfully created partition table: ${table_name}`);

        if (BUNSANE_RELATION_TYPED_COLUMN && indexedProperties?.includes('value')) {
            logger.trace(`Adding typed FK column for ${table_name}`);
            await db.unsafe(`ALTER TABLE ${table_name} ADD COLUMN IF NOT EXISTS fk_id UUID GENERATED ALWAYS AS ((data->>'value')::UUID) STORED;`);
            await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_${table_name}_fk_id ON ${table_name} (fk_id);`);
            logger.trace(`Added fk_id column and index for ${table_name}`);
        }
        
    } catch (error) {
        logger.error(`Failed to create component partition table for ${comp_name}: ${error}`);
        throw error;
    }
}

export const DeleteComponentPartitionTable = async (comp_name: string) => {
    try {
        const table_name = `components_${comp_name.toLowerCase().replace(/\s+/g, '_')}`;

        const existingPartition = await db`
            SELECT 1 FROM information_schema.tables
            WHERE table_name = ${table_name}
            AND table_schema = 'public'
        `;

        if (existingPartition.length === 0) {
            logger.info(`Partition table ${table_name} does not exist`);
            return;
        }

        await db.unsafe(`DROP TABLE IF EXISTS ${table_name}`);
        logger.info(`Successfully deleted partition table: ${table_name}`);

    } catch (error) {
        logger.error(`Failed to delete component partition table for ${comp_name}: ${error}`);
        throw error;
    }
}

export const CreateEntityComponentTable = async () => {
    await db`CREATE TABLE IF NOT EXISTS entity_components (
        entity_id UUID REFERENCES entities(id),
        type_id VARCHAR(64) NOT NULL,
        deleted_at TIMESTAMP,
        UNIQUE(entity_id, type_id)
    );`;
    await db`CREATE INDEX IF NOT EXISTS idx_entity_components_entity_id ON entity_components (entity_id);`
    await db`CREATE INDEX IF NOT EXISTS idx_entity_components_type_id ON entity_components (type_id);`
    await db`CREATE INDEX IF NOT EXISTS idx_entity_components_type_entity ON entity_components (type_id, entity_id);`
}