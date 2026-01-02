import { ScheduleInterval } from "../../types/scheduler.types";
import type { ScheduledTaskOptions } from "../../types/scheduler.types";
import { SchedulerManager } from "../SchedulerManager";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "ScheduledTaskDecorator" });

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

    for (const task of constructor.__scheduledTasks) {
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