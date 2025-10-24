import { ScheduleInterval } from "../../types/scheduler.types";
import type { ScheduledTaskOptions } from "../../types/scheduler.types";
import { SchedulerManager } from "../SchedulerManager";
import { logger } from "../Logger";

const loggerInstance = logger.child({ scope: "ScheduledTaskDecorator" });

// /**
//  * Decorator for registering scheduled tasks
//  * @param options Task configuration options including interval and component target
//  */
// export function ScheduledTask(
//     options: ScheduledTaskOptions & { 
//         interval: ScheduleInterval; 
//         componentTarget?: new (...args: any[]) => any 
//     }
// ) {
//     return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
//         const originalMethod = descriptor.value;

//         // Generate task ID if not provided
//         const taskId = options.id || `${target.constructor.name}.${propertyKey}`;

//         // Store task info for later registration
//         if (!target.constructor.__scheduledTasks) {
//             target.constructor.__scheduledTasks = [];
//         }

//         const taskInfo = {
//             id: taskId,
//             name: options.name || `${target.constructor.name}.${propertyKey}`,
//             componentTarget: options.componentTarget, // Legacy support
//             interval: options.interval,
//             options: {
//                 runOnStart: options.runOnStart ?? false,
//                 timeout: options.timeout ?? 30000,
//                 enableLogging: options.enableLogging ?? true,
//                 ...options
//             },
//             service: null, // Will be set when service is instantiated
//             methodName: propertyKey,
//             nextExecution: new Date(),
//             executionCount: 0,
//             isRunning: false,
//             enabled: true
//         };

//         target.constructor.__scheduledTasks.push(taskInfo);

//         // Return the original descriptor to maintain method functionality
//         return descriptor;
//     };
// }

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