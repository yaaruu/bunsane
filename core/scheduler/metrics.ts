import type { SchedulerMetrics, TaskMetrics } from "../../types/scheduler.types";
import type { SchedulerManager } from "../SchedulerManager";

export function getMetrics(manager: SchedulerManager): SchedulerMetrics {
    return { ...manager.metrics };
}

export function getTaskMetrics(manager: SchedulerManager, taskId: string): TaskMetrics | null {
    return manager.metrics.taskMetrics[taskId] || null;
}

export function getAllTaskMetrics(manager: SchedulerManager): Record<string, TaskMetrics> {
    return { ...manager.metrics.taskMetrics };
}
