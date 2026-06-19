/**
 * Unit tests for withLock — the public advisory-lock convenience wrapper.
 *
 * Note: These tests require a PostgreSQL (or PGlite) database connection.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resetDistributedLock, getDistributedLock } from '../../../core/scheduler/DistributedLock';
import { withLock } from '../../../core/scheduler/withLock';

describe('withLock', () => {
    beforeEach(() => {
        resetDistributedLock();
    });

    afterEach(async () => {
        await getDistributedLock().releaseAll();
        resetDistributedLock();
    });

    test('runs fn and returns its result when the lock is free', async () => {
        const res = await withLock('wl-basic', () => 42);

        expect(res.acquired).toBe(true);
        expect(res.result).toBe(42);
    });

    test('releases the lock after fn resolves', async () => {
        await withLock('wl-release', async () => 'ok');

        expect(getDistributedLock().isHeld('wl-release')).toBe(false);
        expect(getDistributedLock().getHeldLockCount()).toBe(0);
    });

    test('holds the lock for the duration of fn', async () => {
        await withLock('wl-held-during', async () => {
            expect(getDistributedLock().isHeld('wl-held-during')).toBe(true);
        });
    });

    test('releases the lock even when fn throws', async () => {
        const boom = new Error('boom');

        await expect(withLock('wl-throw', async () => {
            throw boom;
        })).rejects.toBe(boom);

        expect(getDistributedLock().isHeld('wl-throw')).toBe(false);
        expect(getDistributedLock().getHeldLockCount()).toBe(0);
    });

    test('a concurrent same-key call returns acquired:false (in-process gate)', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const first = withLock('wl-concurrent', async () => {
            await gate;       // hold the lock until the second call has tried
            return 'first';
        });

        // Give `first` a tick to enter the critical section.
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 10));

        const second = await withLock('wl-concurrent', () => 'second');
        expect(second.acquired).toBe(false);
        expect(second.result).toBeUndefined();

        release();
        const firstResult = await first;
        expect(firstResult.acquired).toBe(true);
        expect(firstResult.result).toBe('first');
    });

    test('wait gives up and returns acquired:false past the deadline', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const holder = withLock('wl-wait', async () => {
            await gate;
            return 'holder';
        });
        await new Promise((r) => setTimeout(r, 10));

        const start = Date.now();
        const waited = await withLock('wl-wait', () => 'late', { wait: 120, retryInterval: 20 });
        const elapsed = Date.now() - start;

        expect(waited.acquired).toBe(false);
        expect(elapsed).toBeGreaterThanOrEqual(100);

        release();
        await holder;
    });

    test('lock is reusable after the previous holder releases', async () => {
        const a = await withLock('wl-reuse', () => 'a');
        const b = await withLock('wl-reuse', () => 'b');

        expect(a.acquired).toBe(true);
        expect(b.acquired).toBe(true);
        expect(a.result).toBe('a');
        expect(b.result).toBe('b');
    });
});
