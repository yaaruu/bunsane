/**
 * Test context factory for setting up and tearing down test environments
 */
import { beforeEach, afterEach } from 'bun:test';
import { EntityTracker } from './entity-tracker';
import { CacheManager } from '../../core/cache';
import EntityManager from '../../core/EntityManager';
import { ComponentRegistry } from '../../core/components';
import db from '../../database';
import { preparedStatementCache } from '../../database/PreparedStatementCache';

export interface TestContext {
    tracker: EntityTracker;
    cacheManager: CacheManager;
    db: typeof db;
}

/**
 * Creates a test context with automatic setup and cleanup
 *
 * Usage:
 * ```typescript
 * describe('My Test', () => {
 *     const ctx = createTestContext();
 *
 *     test('should work', async () => {
 *         const entity = ctx.tracker.create();
 *         entity.add(MyComponent, { value: 'test' });
 *         await entity.save();
 *         // Entity will be automatically cleaned up after test
 *     });
 * });
 * ```
 */
export function createTestContext(): TestContext {
    const tracker = new EntityTracker();
    let cacheManager: CacheManager;

    beforeEach(async () => {
        // Ensure EntityManager is ready
        (EntityManager as any).dbReady = true;

        // Initialize cache with memory provider
        cacheManager = CacheManager.getInstance();
        cacheManager.initialize({
            enabled: true,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 3600000,
            entity: { enabled: true, ttl: 3600000 },
            component: { enabled: true, ttl: 1800000 },
            query: { enabled: false, ttl: 300000 }
        });

        // Clear cache before each test
        await cacheManager.getProvider().clear();

        // Clear prepared statement cache to prevent cache pollution between tests
        preparedStatementCache.clear();
    });

    afterEach(async () => {
        // Clean up tracked entities
        await tracker.cleanup();

        // Clear cache after test
        try {
            await cacheManager?.getProvider().clear();
        } catch {
            // Ignore
        }
    });

    return {
        tracker,
        get cacheManager() {
            return CacheManager.getInstance();
        },
        db
    };
}

/**
 * Creates a test context with cache disabled
 */
export function createTestContextWithoutCache(): TestContext {
    const tracker = new EntityTracker();

    beforeEach(async () => {
        (EntityManager as any).dbReady = true;
        const cacheManager = CacheManager.getInstance();
        cacheManager.initialize({
            enabled: false,
            provider: 'memory',
            strategy: 'write-through',
            defaultTTL: 0,
            entity: { enabled: false, ttl: 0 },
            component: { enabled: false, ttl: 0 },
            query: { enabled: false, ttl: 0 }
        });
    });

    afterEach(async () => {
        await tracker.cleanup();
    });

    return {
        tracker,
        get cacheManager() {
            return CacheManager.getInstance();
        },
        db
    };
}

/**
 * Ensures a component is registered before running tests
 */
export async function ensureComponentRegistered(
    componentClass: new (...args: any[]) => any
): Promise<void> {
    const componentName = componentClass.name;
    await ComponentRegistry.getReadyPromise(componentName);
}

/**
 * Ensures multiple components are registered before running tests
 */
export async function ensureComponentsRegistered(
    ...componentClasses: Array<new (...args: any[]) => any>
): Promise<void> {
    await Promise.all(componentClasses.map(c => ensureComponentRegistered(c)));
}

/**
 * Generates a unique test ID
 */
export function generateTestId(prefix: string = 'test'): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}`;
}

/**
 * Creates a delay (useful for testing async operations)
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
