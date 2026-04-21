/**
 * Unit tests for SchedulerManager time-based (entity-less) tasks.
 * Covers BUNSANE-002: @ScheduledTask without query/componentTarget.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SchedulerManager } from '../../../core/SchedulerManager';
import { ScheduleInterval } from '../../../types/scheduler.types';

describe('SchedulerManager time-based tasks', () => {
    let scheduler: SchedulerManager;

    beforeEach(() => {
        scheduler = SchedulerManager.getInstance();
        scheduler.updateConfig({
            enabled: true,
            enableLogging: false,
            runOnStart: false,
            distributedLocking: false,
            maxConcurrentTasks: 5,
            defaultTimeout: 5000,
        });
    });

    afterEach(async () => {
        await scheduler.stop().catch(() => {});
    });

    test('registers task with no query / no componentTarget', () => {
        let called = 0;
        const service = {
            tick: async () => {
                called++;
            },
        };

        expect(() =>
            scheduler.registerTask({
                id: 'test.timebased.register',
                name: 'timebased-register',
                interval: ScheduleInterval.MINUTE,
                options: {},
                service,
                methodName: 'tick',
                nextExecution: new Date(),
                executionCount: 0,
                isRunning: false,
                enabled: true,
            })
        ).not.toThrow();
    });

    test('executes handler with no entity argument', async () => {
        const receivedArgsBox: { args: unknown[] | null } = { args: null };
        const service = {
            tick: async (...args: unknown[]) => {
                receivedArgsBox.args = args;
            },
        };

        scheduler.registerTask({
            id: 'test.timebased.exec',
            name: 'timebased-exec',
            interval: ScheduleInterval.MINUTE,
            options: {},
            service,
            methodName: 'tick',
            nextExecution: new Date(),
            executionCount: 0,
            isRunning: false,
            enabled: true,
        });

        const ok = await scheduler.executeTaskNow('test.timebased.exec');
        expect(ok).toBe(true);
        expect(receivedArgsBox.args).toEqual([]);
    });

    test('rejects task still missing required fields', () => {
        const service = { tick: async () => {} };
        expect(() =>
            scheduler.registerTask({
                // missing id
                name: 'bad',
                interval: ScheduleInterval.MINUTE,
                options: {},
                service,
                methodName: 'tick',
                nextExecution: new Date(),
                executionCount: 0,
                isRunning: false,
                enabled: true,
            } as any)
        ).toThrow(/missing required fields/);
    });
});
