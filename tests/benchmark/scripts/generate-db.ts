#!/usr/bin/env bun
/**
 * CLI script to generate persistent PGlite benchmark databases.
 *
 * This script is self-contained and does not depend on the framework's
 * database connection - it writes directly to PGlite.
 *
 * Usage:
 *   bun tests/benchmark/scripts/generate-db.ts [tier] [--force] [--all]
 *
 * Examples:
 *   bun tests/benchmark/scripts/generate-db.ts xs
 *   bun tests/benchmark/scripts/generate-db.ts md --force
 *   bun tests/benchmark/scripts/generate-db.ts --all
 */
import { PGlite } from '@electric-sql/pglite';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
    SeededRandom,
    generateUserData,
    generateProductData,
    generateOrderData,
    generateOrderItemData,
    generateReviewData
} from '../fixtures/EcommerceDataGenerators';
import { RelationTracker } from '../fixtures/RelationTracker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASES_DIR = join(__dirname, '..', 'databases');

// Database tier configurations
const TIERS = {
    xs: { users: 1000, products: 2000, orders: 3000, orderItems: 3000, reviews: 1000 },
    sm: { users: 5000, products: 10000, orders: 15000, orderItems: 15000, reviews: 5000 },
    md: { users: 10000, products: 20000, orders: 30000, orderItems: 30000, reviews: 10000 },
    lg: { users: 50000, products: 100000, orders: 150000, orderItems: 150000, reviews: 50000 },
    xl: { users: 100000, products: 200000, orders: 300000, orderItems: 300000, reviews: 100000 }
} as const;

type Tier = keyof typeof TIERS;

const DEFAULT_SEED = 42;
const BATCH_SIZE = 1000;

// Component names and their type IDs (generated deterministically)
const COMPONENT_TYPE_IDS = new Map<string, string>();

function generateTypeId(name: string): string {
    if (COMPONENT_TYPE_IDS.has(name)) {
        return COMPONENT_TYPE_IDS.get(name)!;
    }
    // Generate a SHA256 hash (64 hex chars, matches framework's metadata-storage.ts)
    const typeId = createHash('sha256').update(name).digest('hex');
    COMPONENT_TYPE_IDS.set(name, typeId);
    return typeId;
}

// Simple UUID v7 implementation (time-ordered)
function uuidv7(): string {
    const now = Date.now();
    const timeHex = now.toString(16).padStart(12, '0');
    const randomBytes = crypto.getRandomValues(new Uint8Array(10));
    const randomHex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${randomHex.slice(0, 3)}-${(0x80 | (randomBytes[4]! & 0x3f)).toString(16)}${randomHex.slice(5, 7)}-${randomHex.slice(7, 19)}`;
}

interface GenerationResult {
    tier: Tier;
    totalEntities: number;
    totalTime: number;
    recordsPerSecond: number;
    path: string;
}

async function initializeSchema(pg: PGlite): Promise<void> {
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS entities (
            id UUID PRIMARY KEY,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            deleted_at TIMESTAMPTZ DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS components (
            id UUID PRIMARY KEY,
            entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            type_id VARCHAR(64) NOT NULL,
            name VARCHAR(128),
            data JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            deleted_at TIMESTAMPTZ DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS entity_components (
            entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            type_id VARCHAR(64) NOT NULL,
            component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            deleted_at TIMESTAMPTZ DEFAULT NULL,
            PRIMARY KEY (entity_id, type_id)
        );

        CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components(entity_id);
        CREATE INDEX IF NOT EXISTS idx_components_type_id ON components(type_id);
        CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
        CREATE INDEX IF NOT EXISTS idx_entity_components_type_id ON entity_components(type_id);
        CREATE INDEX IF NOT EXISTS idx_entities_deleted_null ON entities(id) WHERE deleted_at IS NULL;
    `);
}

async function seedComponent(
    pg: PGlite,
    componentName: string,
    count: number,
    dataGenerator: (index: number) => Record<string, any>,
    tracker: RelationTracker,
    trackFn?: (entityId: string, data: Record<string, any>) => void,
    onProgress?: (current: number) => void
): Promise<string[]> {
    const typeId = generateTypeId(componentName);
    const entityIds: string[] = [];

    for (let i = 0; i < count; i += BATCH_SIZE) {
        const batchSize = Math.min(BATCH_SIZE, count - i);
        const now = new Date().toISOString();

        let entitiesValues = '';
        let componentsValues = '';
        let entityComponentsValues = '';

        for (let j = 0; j < batchSize; j++) {
            const entityId = uuidv7();
            const componentId = uuidv7();
            const data = dataGenerator(i + j);

            entityIds.push(entityId);

            if (trackFn) {
                trackFn(entityId, data);
            }

            const sep = j > 0 ? ',' : '';
            entitiesValues += `${sep}('${entityId}', '${now}', '${now}')`;
            componentsValues += `${sep}('${componentId}', '${entityId}', '${typeId}', '${componentName}', '${JSON.stringify(data).replace(/'/g, "''")}', '${now}', '${now}')`;
            entityComponentsValues += `${sep}('${entityId}', '${typeId}', '${componentId}', '${now}', '${now}')`;
        }

        await pg.exec(`INSERT INTO entities (id, created_at, updated_at) VALUES ${entitiesValues}`);
        await pg.exec(`INSERT INTO components (id, entity_id, type_id, name, data, created_at, updated_at) VALUES ${componentsValues}`);
        await pg.exec(`INSERT INTO entity_components (entity_id, type_id, component_id, created_at, updated_at) VALUES ${entityComponentsValues} ON CONFLICT (entity_id, type_id) DO NOTHING`);

        if (onProgress) {
            onProgress(i + batchSize);
        }
    }

    return entityIds;
}

async function generateDatabase(tier: Tier, force: boolean): Promise<GenerationResult> {
    const config = TIERS[tier];
    const dbPath = join(DATABASES_DIR, tier);

    if (existsSync(dbPath)) {
        if (!force) {
            console.log(`Database for tier '${tier}' already exists at ${dbPath}`);
            console.log('Use --force to regenerate');
            process.exit(0);
        }
        console.log(`Removing existing database at ${dbPath}...`);
        rmSync(dbPath, { recursive: true, force: true });
    }

    mkdirSync(dbPath, { recursive: true });

    console.log(`\n=== Generating ${tier.toUpperCase()} tier database ===`);
    console.log(`Path: ${dbPath}`);
    console.log(`Configuration:`);
    console.log(`  Users:       ${config.users.toLocaleString()}`);
    console.log(`  Products:    ${config.products.toLocaleString()}`);
    console.log(`  Orders:      ${config.orders.toLocaleString()}`);
    console.log(`  Order Items: ${config.orderItems.toLocaleString()}`);
    console.log(`  Reviews:     ${config.reviews.toLocaleString()}`);

    const totalEntities = config.users + config.products + config.orders + config.orderItems + config.reviews;
    console.log(`  Total:       ${totalEntities.toLocaleString()}`);
    console.log('');

    const startTime = performance.now();

    console.log('Initializing PGlite...');
    const pg = new PGlite(dbPath, { relaxedDurability: true });
    await pg.waitReady;

    console.log('Creating schema...');
    await initializeSchema(pg);

    const tracker = new RelationTracker();
    const rng = new SeededRandom(DEFAULT_SEED);

    // Seed Users
    console.log('\nSeeding Users...');
    const userStart = performance.now();
    await seedComponent(
        pg,
        'BenchUser',
        config.users,
        (idx) => generateUserData(idx, rng),
        tracker,
        (entityId) => tracker.addUser(entityId),
        (current) => process.stdout.write(`\r  Progress: ${current.toLocaleString()}/${config.users.toLocaleString()}`)
    );
    console.log(`\n  Done in ${((performance.now() - userStart) / 1000).toFixed(1)}s`);

    // Seed Products
    console.log('\nSeeding Products...');
    const productStart = performance.now();
    await seedComponent(
        pg,
        'BenchProduct',
        config.products,
        (idx) => generateProductData(idx, rng),
        tracker,
        (entityId) => tracker.addProduct(entityId),
        (current) => process.stdout.write(`\r  Progress: ${current.toLocaleString()}/${config.products.toLocaleString()}`)
    );
    console.log(`\n  Done in ${((performance.now() - productStart) / 1000).toFixed(1)}s`);

    // Seed Orders
    console.log('\nSeeding Orders...');
    const orderStart = performance.now();
    await seedComponent(
        pg,
        'BenchOrder',
        config.orders,
        (idx) => generateOrderData(idx, rng, tracker),
        tracker,
        (entityId, data) => tracker.addOrder(entityId, data.userId),
        (current) => process.stdout.write(`\r  Progress: ${current.toLocaleString()}/${config.orders.toLocaleString()}`)
    );
    console.log(`\n  Done in ${((performance.now() - orderStart) / 1000).toFixed(1)}s`);

    // Seed Order Items
    console.log('\nSeeding Order Items...');
    const itemStart = performance.now();
    await seedComponent(
        pg,
        'BenchOrderItem',
        config.orderItems,
        (idx) => generateOrderItemData(idx, rng, tracker),
        tracker,
        undefined,
        (current) => process.stdout.write(`\r  Progress: ${current.toLocaleString()}/${config.orderItems.toLocaleString()}`)
    );
    console.log(`\n  Done in ${((performance.now() - itemStart) / 1000).toFixed(1)}s`);

    // Seed Reviews
    console.log('\nSeeding Reviews...');
    const reviewStart = performance.now();
    await seedComponent(
        pg,
        'BenchReview',
        config.reviews,
        (idx) => generateReviewData(idx, rng, tracker),
        tracker,
        undefined,
        (current) => process.stdout.write(`\r  Progress: ${current.toLocaleString()}/${config.reviews.toLocaleString()}`)
    );
    console.log(`\n  Done in ${((performance.now() - reviewStart) / 1000).toFixed(1)}s`);

    // Run VACUUM ANALYZE
    console.log('\nRunning VACUUM ANALYZE...');
    await pg.exec('VACUUM ANALYZE entities');
    await pg.exec('VACUUM ANALYZE components');
    await pg.exec('VACUUM ANALYZE entity_components');

    console.log('Syncing to disk...');
    await pg.close();

    const totalTime = (performance.now() - startTime) / 1000;
    const recordsPerSecond = Math.round(totalEntities / totalTime);

    console.log('\n=== Generation Complete ===');
    console.log(`Total time:       ${totalTime.toFixed(1)}s`);
    console.log(`Records/second:   ${recordsPerSecond.toLocaleString()}`);
    console.log(`Database path:    ${dbPath}`);

    return {
        tier,
        totalEntities,
        totalTime,
        recordsPerSecond,
        path: dbPath
    };
}

// Parse CLI arguments
const args = process.argv.slice(2);
const force = args.includes('--force');
const all = args.includes('--all');
const tierArg = args.find(a => !a.startsWith('--'));

if (!all && !tierArg) {
    console.log('Usage: bun tests/benchmark/scripts/generate-db.ts [tier] [--force] [--all]');
    console.log('\nTiers: xs, sm, md, lg, xl');
    console.log('\nOptions:');
    console.log('  --force   Regenerate even if database exists');
    console.log('  --all     Generate all tiers');
    console.log('\nExamples:');
    console.log('  bun tests/benchmark/scripts/generate-db.ts xs');
    console.log('  bun tests/benchmark/scripts/generate-db.ts md --force');
    console.log('  bun tests/benchmark/scripts/generate-db.ts --all');
    process.exit(1);
}

if (all) {
    console.log('Generating all database tiers...\n');
    const results: GenerationResult[] = [];

    for (const tier of Object.keys(TIERS) as Tier[]) {
        results.push(await generateDatabase(tier, force));
        console.log('');
    }

    console.log('\n=== Summary ===');
    for (const r of results) {
        console.log(`${r.tier.toUpperCase().padEnd(3)} | ${r.totalEntities.toLocaleString().padStart(10)} entities | ${r.totalTime.toFixed(1).padStart(6)}s | ${r.recordsPerSecond.toLocaleString().padStart(8)} rec/s`);
    }
} else {
    const tier = tierArg as Tier;
    if (!TIERS[tier]) {
        console.error(`Unknown tier: ${tier}`);
        console.error('Valid tiers: xs, sm, md, lg, xl');
        process.exit(1);
    }

    await generateDatabase(tier, force);
}
