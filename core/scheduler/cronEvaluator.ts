import { logger } from "../Logger";
import { CronParser } from "../../utils/cronParser";
import { ScheduleInterval } from "../../types/scheduler.types";
import type { ScheduledTaskInfo } from "../../types/scheduler.types";
import type { SchedulerManager } from "../SchedulerManager";

const loggerInstance = logger.child({ scope: "SchedulerManager" });

export function getIntervalMilliseconds(interval: ScheduleInterval): number {
    switch (interval) {
        case ScheduleInterval.MINUTE:
            return 60 * 1000; // 1 minute
        case ScheduleInterval.HOUR:
            return 60 * 60 * 1000; // 1 hour
        case ScheduleInterval.DAILY:
            return 24 * 60 * 60 * 1000; // 24 hours
        case ScheduleInterval.WEEKLY:
            return 7 * 24 * 60 * 60 * 1000; // 7 days
        case ScheduleInterval.MONTHLY:
            return 30 * 24 * 60 * 60 * 1000; // 30 days (approximate)
        default:
            throw new Error(`Unsupported interval: ${interval}`);
    }
}

export function scheduleLongIntervalTask(manager: SchedulerManager, taskInfo: ScheduledTaskInfo, intervalMs: number): void {
    // For very long intervals, use a shorter check interval to avoid timeout overflow
    const checkInterval = Math.min(intervalMs, 24 * 60 * 60 * 1000); // Max 24 hours check interval
    const nextExecution = new Date(Date.now() + intervalMs);
    taskInfo.nextExecution = nextExecution;

    const intervalId = setInterval(async () => {
        const now = Date.now();
        if (now >= nextExecution.getTime()) {
            await (manager as any).executeTask(taskInfo.id);
            // Reschedule for next execution
            taskInfo.nextExecution = new Date(now + intervalMs);
        }
    }, checkInterval);

    manager.intervals.set(taskInfo.id, intervalId);
}

export function scheduleIntervalTask(manager: SchedulerManager, taskInfo: ScheduledTaskInfo): void {
    const intervalMs = getIntervalMilliseconds(taskInfo.interval);

    // Clear any existing interval for this task before creating a new one
    const existingInterval = manager.intervals.get(taskInfo.id);
    if (existingInterval) {
        clearInterval(existingInterval);
        manager.intervals.delete(taskInfo.id);
    }

    // For very long intervals (monthly), use a different approach
    if (intervalMs > 24 * 60 * 60 * 1000) { // More than 24 hours
        scheduleLongIntervalTask(manager, taskInfo, intervalMs);
    } else {
        const intervalId = setInterval(async () => {
            await (manager as any).executeTask(taskInfo.id);
        }, intervalMs);

        manager.intervals.set(taskInfo.id, intervalId);
        taskInfo.nextExecution = new Date(Date.now() + intervalMs);
    }

    if (manager.config.enableLogging) {
        loggerInstance.info(`Scheduled task ${taskInfo.name} to run every ${intervalMs}ms`);
    }
}

export function scheduleCronTask(manager: SchedulerManager, taskInfo: ScheduledTaskInfo): void {
    if (!taskInfo.cronExpression) {
        throw new Error(`Cron expression is required for CRON interval tasks`);
    }

    // Validate cron expression
    const validation = CronParser.validate(taskInfo.cronExpression);
    if (!validation.isValid) {
        throw new Error(`Invalid cron expression: ${validation.error}`);
    }

    // Calculate next execution time
    const nextExecution = CronParser.getNextExecution(validation.fields!, new Date());
    if (!nextExecution) {
        throw new Error(`Unable to calculate next execution time for cron expression: ${taskInfo.cronExpression}`);
    }

    taskInfo.nextExecution = nextExecution;

    // Clear any existing timeout for this task before creating a new one
    const existingTimeout = manager.intervals.get(taskInfo.id);
    if (existingTimeout) {
        clearTimeout(existingTimeout as any);
    }

    // Schedule the task to run at the calculated time
    const timeoutId = setTimeout(async () => {
        await (manager as any).executeTask(taskInfo.id);
        // Reschedule for next execution
        scheduleCronTask(manager, taskInfo);
    }, nextExecution.getTime() - Date.now());

    manager.intervals.set(taskInfo.id, timeoutId as any);

    if (manager.config.enableLogging) {
        loggerInstance.info(`Scheduled cron task ${taskInfo.name} to run at ${nextExecution.toISOString()}`);
    }
}

export function scheduleTask(manager: SchedulerManager, taskInfo: ScheduledTaskInfo): void {
    try {
        if (taskInfo.interval === ScheduleInterval.CRON) {
            scheduleCronTask(manager, taskInfo);
        } else {
            scheduleIntervalTask(manager, taskInfo);
        }
    } catch (error) {
        loggerInstance.error(`Failed to schedule task ${taskInfo.name}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

export function scheduleJob(
    manager: SchedulerManager,
    name: string,
    cronExpression: string,
    callback: () => Promise<void> | void
): { cancel: () => void } {
    const jobId = `job_${name}_${Date.now()}`;

    // Validate cron expression
    const validation = CronParser.validate(cronExpression);
    if (!validation.isValid) {
        throw new Error(`Invalid cron expression for job "${name}": ${validation.error}`);
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleNextExecution = () => {
        if (cancelled) return;

        const nextExecution = CronParser.getNextExecution(validation.fields!, new Date());
        if (!nextExecution) {
            loggerInstance.warn(`Unable to calculate next execution for job "${name}"`);
            return;
        }

        const delay = nextExecution.getTime() - Date.now();
        timeoutId = setTimeout(async () => {
            if (cancelled) return;
            try {
                await callback();
            } catch (error) {
                loggerInstance.error(`Job "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            scheduleNextExecution();
        }, delay);

        manager.intervals.set(jobId, timeoutId as any);
    };

    scheduleNextExecution();

    return {
        cancel: () => {
            cancelled = true;
            if (timeoutId) {
                clearTimeout(timeoutId);
                manager.intervals.delete(jobId);
            }
        }
    };
}
