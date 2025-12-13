import { ScheduleInterval } from "../types/scheduler.types";
import type { ScheduledTaskOptions } from "../types/scheduler.types";
import { SchedulerManager } from "core/SchedulerManager";
import { logger } from "core/Logger";
import type { ComponentTargetConfig } from "core/EntityHookManager";
const loggerInstance = logger.child({ scope: "ScheduledTaskDecorator" });

/**
 * Decorator for registering scheduled tasks
 * @param options Task configuration options including interval and query function
 * @example
 * ```typescript
 * @ScheduledTask({
 *     interval: ScheduleInterval.MINUTE,
 *     query: () => {
 *         return new Query()
 *             .with(SessionComponent)
 *             .with(PhoneComponent)
 *             .without(AuthenticatedTag);
 *     }
 * })
 * async myTask(entities: Entity[]) {
 *     // Process entities
 * }
 * ```
 */
export function ScheduledTask(
    options: ScheduledTaskOptions & { 
        interval: ScheduleInterval;
    }
) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        // Generate task ID if not provided
        const taskId = options.id || `${target.constructor.name}.${propertyKey}`;

        // Store task info for later registration
        if (!target.constructor.__scheduledTasks) {
            target.constructor.__scheduledTasks = [];
        }

        const taskInfo = {
            id: taskId,
            name: options.name || `${target.constructor.name}.${propertyKey}`,
            interval: options.interval,
            cronExpression: options.cronExpression,
            options: {
                runOnStart: options.runOnStart ?? false,
                timeout: options.timeout ?? 30000,
                enableLogging: options.enableLogging ?? true,
                ...options
            },
            service: null, // Will be set when service is instantiated
            methodName: propertyKey,
            nextExecution: new Date(),
            executionCount: 0,
            isRunning: false,
            enabled: true
        };

        // Check if task with this ID already exists in the array to prevent duplicates
        const existingTaskIndex = target.constructor.__scheduledTasks.findIndex(
            (t: any) => t.id === taskId
        );
        if (existingTaskIndex === -1) {
            target.constructor.__scheduledTasks.push(taskInfo);
        } else {
            loggerInstance.warn(`Task ${taskId} already exists in __scheduledTasks array. Skipping duplicate.`);
        }

        // Return the original descriptor to maintain method functionality
        return descriptor;
    };
}

/**
 * Function to manually register decorated tasks for a service instance
 * This is useful when services are instantiated outside the normal decorator flow
 */
export function registerScheduledTasks(service: any): void {
    const constructor = service.constructor;

    if (!constructor.__scheduledTasks) {
        return;
    }

    const scheduler = SchedulerManager.getInstance();

    // Deduplicate tasks by ID to prevent duplicate registrations
    const uniqueTasks = new Map<string, any>();
    for (const task of constructor.__scheduledTasks) {
        if (!uniqueTasks.has(task.id)) {
            uniqueTasks.set(task.id, task);
        } else {
            loggerInstance.warn(`Duplicate task found in __scheduledTasks array: ${task.id}. Using first occurrence only.`);
        }
    }

    for (const task of uniqueTasks.values()) {
        const taskWithService = {
            ...task,
            service: service
        };

        try {
            scheduler.registerTask(taskWithService);
            if (loggerInstance.isLevelEnabled('info')) {
                loggerInstance.info(`Manually registered scheduled task: ${task.name} (${task.id})`);
            }
        } catch (error) {
            loggerInstance.error(`Failed to manually register scheduled task ${task.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export {
    ScheduleInterval
}