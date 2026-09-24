import { describe, test, expect } from "bun:test";
import type { SchedulerManager } from "../../../core/SchedulerManager";
import type { ScheduledTaskInfo } from "../../../types/scheduler.types";
import { DEFAULT_MAX_ENTITIES_PER_EXECUTION } from "../../../types/scheduler.types";
import {
    doExecuteTask,
    leaseTtlForTask,
    SCHEDULER_LEASE_MARGIN_MS,
} from "../../../core/scheduler/taskRunner";

interface LockProbe {
    acquiredTtl: number;
    releaseCount: number;
    renewCount: number;
    held: boolean;
    tryAcquire(taskId: string, ttlMs?: number): Promise<{ acquired: boolean; lockKey: bigint; taskId: string }>;
    release(taskId: string): Promise<boolean>;
    renew(taskId: string): Promise<boolean>;
    getLeaseTtlMs(): number;
    getConfig(): { enabled: boolean };
}

function harness(opts: {
    timeout?: number;
    method: () => unknown;
    query?: () => { take: (n: number) => unknown; exec: () => Promise<unknown[]>; context?: { limit?: number | null } };
    maxEntities?: number;
}) {
    const lock: LockProbe = {
        acquiredTtl: 0,
        releaseCount: 0,
        renewCount: 0,
        held: false,
        async tryAcquire(taskId, ttlMs) {
            lock.acquiredTtl = ttlMs ?? 0;
            lock.held = true;
            return { acquired: true, lockKey: 1n, taskId };
        },
        async release() {
            lock.releaseCount++;
            lock.held = false;
            return true;
        },
        async renew() {
            lock.renewCount++;
            return true;
        },
        getLeaseTtlMs: () => 30_000,
        getConfig: () => ({ enabled: true }),
    };

    const task = {
        id: "task-1",
        name: "probe",
        interval: "minute",
        options: {
            timeout: opts.timeout ?? 1000,
            maxEntitiesPerExecution: opts.maxEntities,
            query: opts.query,
        },
        service: { run: opts.method },
        methodName: "run",
        nextExecution: new Date(),
        executionCount: 0,
        isRunning: false,
        enabled: true,
    } as ScheduledTaskInfo;

    const manager = {
        tasks: new Map([[task.id, task]]),
        config: { enableLogging: false, maxConcurrentTasks: 5, defaultTimeout: 30_000 },
        metrics: {
            totalTasks: 1,
            runningTasks: 0,
            completedExecutions: 0,
            failedExecutions: 0,
            averageExecutionTime: 0,
            totalExecutionTime: 0,
            timedOutTasks: 0,
            retriedTasks: 0,
            taskMetrics: {},
            skippedExecutions: 0,
            lockAttempts: 0,
            locksAcquired: 0,
        },
        distributedLock: lock,
        emitEvent: () => {},
        intervals: new Map(),
        isRunning: true,
    };

    return { manager: manager as unknown as SchedulerManager, lock, task };
}

describe("scheduler lock path", () => {
    test("lease TTL is strictly greater than the task timeout", () => {
        expect(leaseTtlForTask(100, 30_000)).toBe(30_000);
        expect(leaseTtlForTask(40_000, 30_000)).toBe(40_000 + SCHEDULER_LEASE_MARGIN_MS);
        expect(leaseTtlForTask(40_000, 30_000)).toBeGreaterThan(40_000);
    });

    test("wrapper timeout does not release the lock while the task is still running", async () => {
        // Real setTimeout: executeWithTimeout's wall clock is the behavior under test.
        let releaseTask: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseTask = resolve;
        });
        const { manager, lock, task } = harness({ timeout: 40, method: () => gate });

        const done = doExecuteTask(manager, task.id);
        await new Promise((resolve) => setTimeout(resolve, 90));

        expect(lock.releaseCount).toBe(0);
        expect(lock.held).toBe(true);
        expect(task.isRunning).toBe(true);
        expect(lock.acquiredTtl).toBeGreaterThan(40);

        releaseTask();
        await done;
        for (let i = 0; i < 8 && task.isRunning; i++) await Promise.resolve();

        expect(lock.releaseCount).toBe(1);
        expect(lock.held).toBe(false);
        expect(task.isRunning).toBe(false);
    });

    test("heartbeat renews the lease while the task runs", async () => {
        let releaseTask: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseTask = resolve;
        });
        const { manager, lock } = harness({ timeout: 5_000, method: () => gate });

        const original = globalThis.setInterval;
        let captured: (() => void) | null = null;
        globalThis.setInterval = ((fn: () => void) => {
            captured = fn;
            return 1 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;

        try {
            const done = doExecuteTask(manager, "task-1");
            for (let i = 0; i < 8 && !captured; i++) await Promise.resolve();
            expect(captured).not.toBeNull();
            globalThis.setInterval = original;
            captured!();
            await Promise.resolve();
            expect(lock.renewCount).toBe(1);
            expect(lock.releaseCount).toBe(0);
            releaseTask();
            await done;
            expect(lock.releaseCount).toBe(1);
        } finally {
            globalThis.setInterval = original;
        }
    });

    test("unset maxEntitiesPerExecution applies the default cap without raising a smaller take", async () => {
        const query = {
            context: { limit: null as number | null },
            taken: 0,
            take(n: number) {
                this.taken = n;
                this.context.limit = n;
                return this;
            },
            async exec() {
                return new Array(this.taken).fill({ id: "e" });
            },
        };
        const first = harness({
            method: () => {},
            query: () => query,
        });
        await doExecuteTask(first.manager, "task-1");
        expect(query.taken).toBe(DEFAULT_MAX_ENTITIES_PER_EXECUTION);

        query.context.limit = 4;
        query.taken = 0;
        const second = harness({
            method: () => {},
            query: () => query,
        });
        await doExecuteTask(second.manager, "task-1");
        expect(query.taken).toBe(0);

        query.context.limit = null;
        query.taken = 0;
        const third = harness({
            method: () => {},
            query: () => query,
            maxEntities: 7,
        });
        await doExecuteTask(third.manager, "task-1");
        expect(query.taken).toBe(7);
    });

    test("timeout then rejection retries after the task settles and does not leak", async () => {
        // Real timers: the wrapper timeout and the deferred retry are the behavior under test.
        let calls = 0;
        let rejectTask: (err: Error) => void = () => {};
        const gate = new Promise<void>((_resolve, reject) => {
            rejectTask = reject;
        });
        const { manager, task } = harness({
            timeout: 40,
            method: () => {
                calls++;
                return calls === 1 ? gate : undefined;
            },
        });
        task.options = { ...task.options, maxRetries: 1, retryDelay: 25 };
        let retryDone: Promise<void> | null = null;
        (manager as unknown as { executeTask: (id: string) => Promise<void> }).executeTask = (id) => {
            retryDone = doExecuteTask(manager, id);
            return retryDone;
        };

        const leaks: unknown[] = [];
        const onLeak = (reason: unknown) => {
            leaks.push(reason);
        };
        process.on("unhandledRejection", onLeak);
        try {
            const done = doExecuteTask(manager, task.id);
            await new Promise((resolve) => setTimeout(resolve, 120));
            expect(calls).toBe(1);
            expect(task.isRunning).toBe(true);
            rejectTask(new Error("late"));
            await done;
            for (let i = 0; i < 40 && !retryDone; i++) {
                await new Promise((resolve) => setTimeout(resolve, 15));
            }
            expect(retryDone).not.toBeNull();
            await retryDone;
            expect(calls).toBe(2);
            expect(task.isRunning).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(leaks).toEqual([]);
        } finally {
            process.off("unhandledRejection", onLeak);
        }
    });
});
