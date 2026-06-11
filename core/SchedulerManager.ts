import { logger } from "./Logger";
import ApplicationLifecycle, { ApplicationPhase, type PhaseChangeEvent } from "./ApplicationLifecycle";
import {
    ScheduleInterval
} from "../types/scheduler.types";
import type {
    ScheduledTaskInfo,
    SchedulerMetrics,
    TaskExecutionResult,
    SchedulerEvent,
    SchedulerEventCallback,
    SchedulerConfig,
    TaskMetrics
} from "../types/scheduler.types";
import { Query } from "../query/Query";
import { Entity } from "./Entity";
import { CronParser } from "../utils/cronParser";
import type { ComponentTargetConfig } from "./EntityHookManager";
import ArcheType from "./ArcheType";
import { BaseComponent } from "./components";
import { DistributedLock, type DistributedLockConfig } from "./scheduler/DistributedLock";
import { scheduleTask, scheduleJob } from "./scheduler/cronEvaluator";
import { executeTask, doExecuteTask, updateTaskMetrics } from "./scheduler/taskRunner";
import { getDistributedLockInfo, isDistributedLockingEnabled, syncLockConfig } from "./scheduler/lockCoordinator";
import { initializeLifecycleIntegration, disposeLifecycleIntegration as _disposeLifecycleIntegration } from "./scheduler/lifecycleHooks";
import { getMetrics, getTaskMetrics, getAllTaskMetrics } from "./scheduler/metrics";

const loggerInstance = logger.child({ scope: "SchedulerManager" });

export class SchedulerManager {
    private static instance: SchedulerManager;
    public tasks: Map<string, ScheduledTaskInfo> = new Map();
    public intervals: Map<string, NodeJS.Timeout> = new Map();
    public isRunning: boolean = false;
    private eventListeners: SchedulerEventCallback[] = [];
    public config: SchedulerConfig;
    public distributedLock: DistributedLock;
    public phaseListener: ((event: PhaseChangeEvent) => void) | null = null;
    public inflightTasks: Set<Promise<any>> = new Set();
    public metrics: SchedulerMetrics = {
        totalTasks: 0,
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
        locksAcquired: 0
    };

    private constructor() {
        this.config = {
            enabled: true,
            maxConcurrentTasks: 5,
            defaultTimeout: 30000, // 30 seconds
            enableLogging: false,
            runOnStart: true,
            distributedLocking: true, // Enable by default for multi-instance safety
            lockTimeout: 0, // No retry by default - skip if can't acquire
            lockRetryInterval: 100,
        };

        // Initialize distributed lock with config
        this.distributedLock = new DistributedLock({
            enabled: this.config.distributedLocking ?? true,
            enableLogging: this.config.enableLogging,
            lockTimeout: this.config.lockTimeout ?? 0,
            retryInterval: this.config.lockRetryInterval ?? 100,
        });

        initializeLifecycleIntegration(this);
    }

    public static getInstance(): SchedulerManager {
        if (!SchedulerManager.instance) {
            SchedulerManager.instance = new SchedulerManager();
        }
        return SchedulerManager.instance;
    }

    public disposeLifecycleIntegration(): void {
        _disposeLifecycleIntegration(this);
    }

    public registerTask(taskInfo: ScheduledTaskInfo): void {
        if (this.tasks.has(taskInfo.id)) {
            loggerInstance.warn(`Task ${taskInfo.id} is already registered. Skipping registration.`);
            return;
        }

        // Validate task info
        if (!taskInfo.id || !taskInfo.name || !taskInfo.interval) {
            const error = new Error(`Invalid task info: missing required fields (id, name, interval)`);
            loggerInstance.error(`Failed to register task: ${error.message}`);
            throw error;
        }

        // Time-based tasks (no query, no componentTarget) are allowed — they
        // invoke the handler with no entity arguments on each tick. Useful
        // for external polling, stats aggregation, or ad-hoc queries inside
        // the callback.

        if (!taskInfo.service) {
            const error = new Error(`Task ${taskInfo.id} has no service instance`);
            loggerInstance.error(`Failed to register task: ${error.message}`);
            throw error;
        }

        if (typeof taskInfo.service[taskInfo.methodName] !== 'function') {
            const error = new Error(`Method ${taskInfo.methodName} not found on service for task ${taskInfo.id}`);
            loggerInstance.error(`Failed to register task: ${error.message}`);
            throw error;
        }

        // Try to schedule the task - if scheduling fails, don't register it
        try {
            scheduleTask(this, taskInfo);
            this.tasks.set(taskInfo.id, taskInfo);
            this.metrics.totalTasks++;

            if (this.config.enableLogging) {
                loggerInstance.info(`Registered scheduled task: ${taskInfo.name} (${taskInfo.id})`);
            }

            this.emitEvent({
                type: 'task.registered',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: { taskName: taskInfo.name, interval: taskInfo.interval }
            });
        } catch (error) {
            loggerInstance.error(`Failed to schedule task ${taskInfo.name}, not registering: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Schedule a simple job with a cron expression and callback.
     * This is a simpler alternative to registerTask for jobs that don't need
     * entity-component system integration.
     */
    public scheduleJob(name: string, cronExpression: string, callback: () => Promise<void> | void): { cancel: () => void } {
        return scheduleJob(this, name, cronExpression, callback);
    }

    private async executeTask(taskId: string): Promise<void> {
        return executeTask(this, taskId);
    }

    private async doExecuteTask(taskId: string): Promise<void> {
        return doExecuteTask(this, taskId);
    }

    public start(): void {
        if (this.isRunning) {
            loggerInstance.warn("Scheduler is already running");
            return;
        }

        this.isRunning = true;

        // Sort tasks by priority before scheduling (higher priority first)
        const sortedTasks = Array.from(this.tasks.values())
            .filter(task => task.enabled)
            .sort((a, b) => {
                const priorityA = a.options?.priority ?? a.priority ?? 0;
                const priorityB = b.options?.priority ?? b.priority ?? 0;
                return priorityB - priorityA; // Higher priority first
            });

        // Schedule all registered tasks in priority order
        for (const taskInfo of sortedTasks) {
            scheduleTask(this, taskInfo);
        }

        const lockStatus = this.config.distributedLocking !== false ? 'enabled' : 'disabled';
        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduler started with ${this.tasks.size} tasks (sorted by priority, distributed locking: ${lockStatus})`);
        }

        this.emitEvent({
            type: 'scheduler.started',
            timestamp: new Date(),
            data: { taskCount: this.tasks.size, distributedLocking: this.config.distributedLocking !== false }
        });
    }

    public async stop(drainTimeoutMs: number = 15_000): Promise<void> {
        if (!this.isRunning) {
            loggerInstance.warn("Scheduler is not running");
            return;
        }

        this.isRunning = false;

        // Clear all intervals and timeouts so no new executions start.
        for (const intervalId of this.intervals.values()) {
            clearInterval(intervalId);
            clearTimeout(intervalId as any);
        }
        this.intervals.clear();

        // Drain in-flight tasks before releasing locks + returning control to
        // App.shutdown (which will close the DB pool). Bounded by drainTimeoutMs
        // so shutdown cannot hang forever on a stuck task.
        if (this.inflightTasks.size > 0) {
            const inflightSnapshot = [...this.inflightTasks];
            if (this.config.enableLogging) {
                loggerInstance.info(`Draining ${inflightSnapshot.length} in-flight scheduled task(s), timeout=${drainTimeoutMs}ms`);
            }
            const drainTimer = new Promise<'timeout'>((resolve) => {
                const t = setTimeout(() => resolve('timeout'), drainTimeoutMs);
                t.unref?.();
            });
            const result = await Promise.race([
                Promise.allSettled(inflightSnapshot).then(() => 'drained' as const),
                drainTimer,
            ]);
            if (result === 'timeout') {
                loggerInstance.warn(`Scheduler drain timed out after ${drainTimeoutMs}ms with ${this.inflightTasks.size} task(s) still running`);
            }
        }

        // Release all distributed locks held by this instance
        await this.distributedLock.releaseAll();

        this.disposeLifecycleIntegration();

        if (this.config.enableLogging) {
            loggerInstance.info("Scheduler stopped");
        }

        this.emitEvent({
            type: 'scheduler.stopped',
            timestamp: new Date()
        });
    }

    public getMetrics(): SchedulerMetrics {
        return getMetrics(this);
    }

    public getTasks(): ScheduledTaskInfo[] {
        return Array.from(this.tasks.values()).map(task => ({ ...task }));
    }

    public enableTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        task.enabled = true;
        if (this.isRunning) {
            scheduleTask(this, task);
        }
        return true;
    }

    public disableTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        task.enabled = false;
        const intervalId = this.intervals.get(taskId);
        if (intervalId) {
            clearInterval(intervalId);
            clearTimeout(intervalId as any);
            this.intervals.delete(taskId);
        }
        return true;
    }

    public addEventListener(callback: SchedulerEventCallback): void {
        this.eventListeners.push(callback);
    }

    public removeEventListener(callback: SchedulerEventCallback): void {
        const index = this.eventListeners.indexOf(callback);
        if (index > -1) {
            this.eventListeners.splice(index, 1);
        }
    }

    public emitEvent(event: SchedulerEvent): void {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (error) {
                loggerInstance.error(`Error in scheduler event listener: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    public updateConfig(config: Partial<SchedulerConfig>): void {
        this.config = { ...this.config, ...config };

        // Sync distributed lock configuration
        syncLockConfig(this);

        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduler configuration updated: ${JSON.stringify(config)}`);
        }
    }

    public getConfig(): SchedulerConfig {
        return { ...this.config };
    }

    /**
     * Get distributed lock configuration and status
     */
    public getDistributedLockInfo(): {
        enabled: boolean;
        heldLocks: number;
        config: DistributedLockConfig;
    } {
        return getDistributedLockInfo(this);
    }

    /**
     * Check if distributed locking is enabled
     */
    public isDistributedLockingEnabled(): boolean {
        return isDistributedLockingEnabled(this);
    }

    /**
     * Get detailed metrics for a specific task
     */
    public getTaskMetrics(taskId: string): TaskMetrics | null {
        return getTaskMetrics(this, taskId);
    }

    /**
     * Get all task metrics
     */
    public getAllTaskMetrics(): Record<string, TaskMetrics> {
        return getAllTaskMetrics(this);
    }

    /**
     * Manually execute a task for testing purposes
     * @param taskId The ID of the task to execute
     */
    public async executeTaskNow(taskId: string): Promise<boolean> {
        const taskInfo = this.tasks.get(taskId);
        if (!taskInfo || !taskInfo.enabled) {
            return false;
        }

        await this.executeTask(taskId);
        return true;
    }
}
