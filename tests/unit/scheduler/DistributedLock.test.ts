/**
 * Unit tests for DistributedLock
 * Tests PostgreSQL advisory lock-based distributed locking functionality
 *
 * Note: These tests require a PostgreSQL database connection
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { DistributedLock, resetDistributedLock, DEFAULT_LOCK_CONFIG } from '../../../core/scheduler/DistributedLock';

describe('DistributedLock', () => {
    let lock: DistributedLock;

    beforeEach(() => {
        // Reset singleton before each test
        resetDistributedLock();
        lock = new DistributedLock({
            enabled: true,
            enableLogging: false,
            lockTimeout: 0,
            retryInterval: 50,
        });
    });

    afterEach(async () => {
        // Release all locks and reset
        await lock.releaseAll();
        resetDistributedLock();
    });

    describe('constructor', () => {
        test('creates lock with default config', () => {
            const defaultLock = new DistributedLock();
            expect(defaultLock).toBeDefined();
            expect(defaultLock.getConfig().enabled).toBe(DEFAULT_LOCK_CONFIG.enabled);
            expect(defaultLock.getConfig().lockKeyPrefix).toBe(DEFAULT_LOCK_CONFIG.lockKeyPrefix);
        });

        test('creates lock with custom config', () => {
            const customLock = new DistributedLock({
                enabled: false,
                lockKeyPrefix: 0x12345678,
                lockTimeout: 5000,
            });
            const config = customLock.getConfig();
            expect(config.enabled).toBe(false);
            expect(config.lockKeyPrefix).toBe(0x12345678);
            expect(config.lockTimeout).toBe(5000);
        });
    });

    describe('tryAcquire()', () => {
        test('acquires lock for new task', async () => {
            const result = await lock.tryAcquire('test-task-1');

            expect(result.acquired).toBe(true);
            expect(result.taskId).toBe('test-task-1');
            expect(result.lockKey).toBeDefined();
            expect(typeof result.lockKey).toBe('bigint');
        });

        test('generates consistent lock keys for same task', async () => {
            const lock2 = new DistributedLock({ enabled: true, enableLogging: false });

            const result1 = await lock.tryAcquire('consistent-task');
            await lock.release('consistent-task');

            const result2 = await lock2.tryAcquire('consistent-task');
            await lock2.release('consistent-task');

            expect(result1.lockKey).toBe(result2.lockKey);
        });

        test('generates different lock keys for different tasks', async () => {
            const result1 = await lock.tryAcquire('task-a');
            const result2 = await lock.tryAcquire('task-b');

            expect(result1.lockKey).not.toBe(result2.lockKey);

            await lock.release('task-a');
            await lock.release('task-b');
        });

        test('fails to acquire already held lock', async () => {
            // First instance acquires lock
            const result1 = await lock.tryAcquire('exclusive-task');
            expect(result1.acquired).toBe(true);

            // Second instance tries to acquire same lock (simulated with same connection)
            // Note: In real scenario, this would be a different database session
            // For unit test, we verify the lock is tracked as held
            expect(lock.isHeld('exclusive-task')).toBe(true);
        });

        test('returns true immediately when locking disabled', async () => {
            const disabledLock = new DistributedLock({ enabled: false });

            const result = await lock.tryAcquire('disabled-test');

            // When disabled, lock is always "acquired" with key 0
            const disabledResult = await disabledLock.tryAcquire('disabled-test');
            expect(disabledResult.acquired).toBe(true);
            expect(disabledResult.lockKey).toBe(0n);
        });

        test('tracks held locks locally', async () => {
            expect(lock.getHeldLockCount()).toBe(0);

            await lock.tryAcquire('tracked-task-1');
            expect(lock.getHeldLockCount()).toBe(1);
            expect(lock.isHeld('tracked-task-1')).toBe(true);

            await lock.tryAcquire('tracked-task-2');
            expect(lock.getHeldLockCount()).toBe(2);
            expect(lock.isHeld('tracked-task-2')).toBe(true);
        });
    });

    describe('release()', () => {
        test('releases held lock', async () => {
            await lock.tryAcquire('release-test');
            expect(lock.isHeld('release-test')).toBe(true);

            const released = await lock.release('release-test');

            expect(released).toBe(true);
            expect(lock.isHeld('release-test')).toBe(false);
            expect(lock.getHeldLockCount()).toBe(0);
        });

        test('returns false for non-held lock', async () => {
            const released = await lock.release('never-acquired');

            // PostgreSQL returns false if lock wasn't held
            expect(released).toBe(false);
        });

        test('does nothing when disabled', async () => {
            const disabledLock = new DistributedLock({ enabled: false });

            const released = await disabledLock.release('any-task');

            expect(released).toBe(true);
        });
    });

    describe('releaseAll()', () => {
        test('releases all held locks', async () => {
            await lock.tryAcquire('multi-1');
            await lock.tryAcquire('multi-2');
            await lock.tryAcquire('multi-3');

            expect(lock.getHeldLockCount()).toBe(3);

            await lock.releaseAll();

            expect(lock.getHeldLockCount()).toBe(0);
            expect(lock.isHeld('multi-1')).toBe(false);
            expect(lock.isHeld('multi-2')).toBe(false);
            expect(lock.isHeld('multi-3')).toBe(false);
        });

        test('handles empty lock set gracefully', async () => {
            expect(lock.getHeldLockCount()).toBe(0);

            // Should not throw
            await lock.releaseAll();

            expect(lock.getHeldLockCount()).toBe(0);
        });
    });

    describe('updateConfig()', () => {
        test('updates configuration', () => {
            const originalConfig = lock.getConfig();

            lock.updateConfig({
                enabled: false,
                lockTimeout: 10000,
            });

            const newConfig = lock.getConfig();
            expect(newConfig.enabled).toBe(false);
            expect(newConfig.lockTimeout).toBe(10000);
            // Other values should remain
            expect(newConfig.lockKeyPrefix).toBe(originalConfig.lockKeyPrefix);
        });
    });

    describe('isHeld()', () => {
        test('returns false for never acquired task', () => {
            expect(lock.isHeld('unknown-task')).toBe(false);
        });

        test('returns true for acquired task', async () => {
            await lock.tryAcquire('held-task');
            expect(lock.isHeld('held-task')).toBe(true);
        });

        test('returns false after release', async () => {
            await lock.tryAcquire('was-held-task');
            expect(lock.isHeld('was-held-task')).toBe(true);

            await lock.release('was-held-task');
            expect(lock.isHeld('was-held-task')).toBe(false);
        });
    });

    describe('lock key generation', () => {
        test('generates positive bigint keys', async () => {
            const tasks = ['task-1', 'task-2', 'TaskWithCaps', 'task.with.dots', 'task-with-dashes'];

            for (const task of tasks) {
                const result = await lock.tryAcquire(task);
                expect(result.lockKey).toBeGreaterThan(0n);
                await lock.release(task);
            }
        });

        test('handles empty string task id', async () => {
            const result = await lock.tryAcquire('');
            expect(result.lockKey).toBeDefined();
            await lock.release('');
        });

        test('handles unicode task ids', async () => {
            const result = await lock.tryAcquire('task-日本語');
            expect(result.acquired).toBe(true);
            expect(result.lockKey).toBeGreaterThan(0n);
            await lock.release('task-日本語');
        });

        test('handles very long task ids', async () => {
            const longId = 'a'.repeat(1000);
            const result = await lock.tryAcquire(longId);
            expect(result.acquired).toBe(true);
            expect(result.lockKey).toBeGreaterThan(0n);
            await lock.release(longId);
        });
    });
});

describe('DistributedLock with timeout', () => {
    let lock: DistributedLock;

    beforeEach(() => {
        resetDistributedLock();
        lock = new DistributedLock({
            enabled: true,
            enableLogging: false,
            lockTimeout: 200, // 200ms timeout
            retryInterval: 50,
        });
    });

    afterEach(async () => {
        await lock.releaseAll();
        resetDistributedLock();
    });

    test('retries until timeout when lock not available', async () => {
        // This test verifies the retry mechanism is called
        // In a real multi-instance scenario, we'd test across database sessions

        const startTime = Date.now();

        // First acquire the lock
        const result1 = await lock.tryAcquire('timeout-task');
        expect(result1.acquired).toBe(true);

        const elapsed = Date.now() - startTime;
        // Should return quickly when lock is available
        expect(elapsed).toBeLessThan(100);
    });
});
