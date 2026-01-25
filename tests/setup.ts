/**
 * Global test setup file for BunSane
 *
 * This file is preloaded before all tests run (configured in bunfig.toml).
 * It ensures:
 * 1. Environment variables are loaded from .env.test
 * 2. Database connection is established and ready
 * 3. Base tables exist
 * 4. ApplicationLifecycle is set to DATABASE_READY
 * 5. EntityManager is ready for operations
 * 6. Proper cleanup on exit
 */

import { beforeAll, afterAll } from 'bun:test';
import { file } from 'bun';

// Load .env.test before anything else
const envTestPath = new URL('../.env.test', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const envFile = file(envTestPath);
if (await envFile.exists()) {
    const envContent = await envFile.text();
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key) {
                const value = valueParts.join('=');
                process.env[key.trim()] = value.trim();
            }
        }
    }
}

// Suppress verbose logging during tests unless LOG_LEVEL is explicitly set
if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = 'warn';
}

// Now import the rest after env is loaded
import db from '../database';
import { PrepareDatabase, HasValidBaseTable } from '../database/DatabaseHelper';
import ApplicationLifecycle, { ApplicationPhase } from '../core/ApplicationLifecycle';
import EntityManager from '../core/EntityManager';
import { ComponentRegistry } from '../core/components';
import { CacheManager } from '../core/cache';
import { logger } from '../core/Logger';
import { preparedStatementCache } from '../database/PreparedStatementCache';

let isSetupComplete = false;
let setupError: Error | null = null;

/**
 * Initialize the test environment
 */
async function initializeTestEnvironment(): Promise<void> {
    if (isSetupComplete) return;
    if (setupError) throw setupError;

    try {
        logger.info({ scope: 'test-setup' }, 'Initializing test environment...');

        // 1. Verify database connection by running a simple query
        const connectionTest = await db`SELECT 1 as connected`;
        if (!connectionTest || connectionTest.length === 0) {
            throw new Error('Database connection failed');
        }
        logger.info({ scope: 'test-setup' }, 'Database connection verified');

        // 2. Ensure base tables exist
        const hasValidTables = await HasValidBaseTable();
        if (!hasValidTables) {
            logger.info({ scope: 'test-setup' }, 'Creating base database tables...');
            await PrepareDatabase();
            logger.info({ scope: 'test-setup' }, 'Base database tables created');
        } else {
            logger.info({ scope: 'test-setup' }, 'Base database tables already exist');
        }

        // 3. Set ApplicationLifecycle to DATABASE_READY
        ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
        logger.info({ scope: 'test-setup' }, 'ApplicationLifecycle set to DATABASE_READY');

        // 4. Set EntityManager as ready
        (EntityManager as any).dbReady = true;
        logger.info({ scope: 'test-setup' }, 'EntityManager marked as ready');

        // 5. Initialize CacheManager with memory provider for tests
        const cacheManager = CacheManager.getInstance();
        cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            query: { enabled: false, ttl: 300000, maxSize: 10000 }
        });
        logger.info({ scope: 'test-setup' }, 'CacheManager initialized with memory provider');

        // 6. Clear prepared statement cache to ensure clean slate
        preparedStatementCache.clear();

        isSetupComplete = true;
        logger.info({ scope: 'test-setup' }, 'Test environment initialization complete');

    } catch (error) {
        setupError = error instanceof Error ? error : new Error(String(error));
        logger.error({ scope: 'test-setup', error: setupError }, 'Failed to initialize test environment');
        throw setupError;
    }
}

/**
 * Clean up the test environment
 */
async function cleanupTestEnvironment(): Promise<void> {
    try {
        logger.info({ scope: 'test-setup' }, 'Cleaning up test environment...');

        // Clear caches
        try {
            const cacheManager = CacheManager.getInstance();
            await cacheManager.clear();
        } catch {
            // Ignore cache cleanup errors
        }

        // Clear prepared statement cache
        try {
            preparedStatementCache.clear();
        } catch {
            // Ignore errors
        }

        // Note: We don't close the database connection pool here because
        // Bun's test runner may still need it for parallel test files.
        // The connection pool will be cleaned up when the process exits.

        logger.info({ scope: 'test-setup' }, 'Test environment cleanup complete');
    } catch (error) {
        logger.warn({ scope: 'test-setup', error }, 'Error during test environment cleanup');
    }
}

// Register global hooks
beforeAll(async () => {
    await initializeTestEnvironment();
});

afterAll(async () => {
    await cleanupTestEnvironment();
});

// Export utilities for tests that need them
export { initializeTestEnvironment, cleanupTestEnvironment };

// Export a helper to ensure setup is complete (for tests that run before beforeAll)
export async function ensureTestSetup(): Promise<void> {
    await initializeTestEnvironment();
}
