import { logger } from "./Logger";
import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";
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
import { BaseComponent } from "./Components";

const loggerInstance = logger.child({ scope: "SchedulerManager" });

export class SchedulerManager {
    private static instance: SchedulerManager;
    private tasks: Map<string, ScheduledTaskInfo> = new Map();
    private intervals: Map<string, NodeJS.Timeout> = new Map();
    private isRunning: boolean = false;
    private eventListeners: SchedulerEventCallback[] = [];
    private config: SchedulerConfig;
    private metrics: SchedulerMetrics = {
        totalTasks: 0,
        runningTasks: 0,
        completedExecutions: 0,
        failedExecutions: 0,
        averageExecutionTime: 0,
        totalExecutionTime: 0,
        timedOutTasks: 0,
        retriedTasks: 0,
        taskMetrics: {}
    };

    private constructor() {
        this.config = {
            enabled: true,
            maxConcurrentTasks: 5,
            defaultTimeout: 30000, // 30 seconds
            enableLogging: true,
            runOnStart: true
        };

        this.initializeLifecycleIntegration();
    }

    public static getInstance(): SchedulerManager {
        if (!SchedulerManager.instance) {
            SchedulerManager.instance = new SchedulerManager();
        }
        return SchedulerManager.instance;
    }

    private initializeLifecycleIntegration(): void {
        ApplicationLifecycle.addPhaseListener((event) => {
            const phase = event.detail;
            if (phase === ApplicationPhase.APPLICATION_READY) {
                logger.info("Scheduler initialized and ready");
                if (this.config.runOnStart) {
                    this.start();
                }
            }
        });
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

        // Validate query configuration
        if (!taskInfo.options?.query && !taskInfo.options?.componentTarget && !taskInfo.componentTarget) {
            const error = new Error(`Invalid task info: must provide either query function, componentTarget config, or legacy componentTarget`);
            loggerInstance.error(`Failed to register task: ${error.message}`);
            throw error;
        }

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
            this.scheduleTask(taskInfo);
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

    private scheduleTask(taskInfo: ScheduledTaskInfo): void {
        try {
            if (taskInfo.interval === ScheduleInterval.CRON) {
                this.scheduleCronTask(taskInfo);
            } else {
                this.scheduleIntervalTask(taskInfo);
            }
        } catch (error) {
            loggerInstance.error(`Failed to schedule task ${taskInfo.name}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    private scheduleIntervalTask(taskInfo: ScheduledTaskInfo): void {
        const intervalMs = this.getIntervalMilliseconds(taskInfo.interval);

        // For very long intervals (monthly), use a different approach
        if (intervalMs > 24 * 60 * 60 * 1000) { // More than 24 hours
            this.scheduleLongIntervalTask(taskInfo, intervalMs);
        } else {
            const intervalId = setInterval(async () => {
                await this.executeTask(taskInfo.id);
            }, intervalMs);

            this.intervals.set(taskInfo.id, intervalId);
            taskInfo.nextExecution = new Date(Date.now() + intervalMs);
        }

        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduled task ${taskInfo.name} to run every ${intervalMs}ms`);
        }
    }

    private scheduleLongIntervalTask(taskInfo: ScheduledTaskInfo, intervalMs: number): void {
        // For very long intervals, use a shorter check interval to avoid timeout overflow
        const checkInterval = Math.min(intervalMs, 24 * 60 * 60 * 1000); // Max 24 hours check interval
        const nextExecution = new Date(Date.now() + intervalMs);
        taskInfo.nextExecution = nextExecution;

        const intervalId = setInterval(async () => {
            const now = Date.now();
            if (now >= nextExecution.getTime()) {
                await this.executeTask(taskInfo.id);
                // Reschedule for next execution
                taskInfo.nextExecution = new Date(now + intervalMs);
            }
        }, checkInterval);

        this.intervals.set(taskInfo.id, intervalId);
    }

    private scheduleCronTask(taskInfo: ScheduledTaskInfo): void {
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
        const existingTimeout = this.intervals.get(taskInfo.id);
        if (existingTimeout) {
            clearTimeout(existingTimeout as any);
        }

        // Schedule the task to run at the calculated time
        const timeoutId = setTimeout(async () => {
            await this.executeTask(taskInfo.id);
            // Reschedule for next execution
            this.scheduleCronTask(taskInfo);
        }, nextExecution.getTime() - Date.now());

        this.intervals.set(taskInfo.id, timeoutId as any);

        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduled cron task ${taskInfo.name} to run at ${nextExecution.toISOString()}`);
        }
    }

    private getIntervalMilliseconds(interval: ScheduleInterval): number {
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

    private async executeTask(taskId: string): Promise<void> {
        const taskInfo = this.tasks.get(taskId);
        if (!taskInfo || !taskInfo.enabled) {
            return;
        }

        if (this.metrics.runningTasks >= this.config.maxConcurrentTasks) {
            if (this.config.enableLogging) {
                loggerInstance.warn(`Maximum concurrent tasks reached. Skipping execution of ${taskInfo.name}`);
            }
            return;
        }

        taskInfo.isRunning = true;
        taskInfo.lastExecution = new Date();
        this.metrics.runningTasks++;

        const startTime = Date.now();
        const timeout = taskInfo.options?.timeout || this.config.defaultTimeout;

        try {
            // Create query based on targeting configuration
            let query: Query;

            if (taskInfo.options?.query) {
                // Use custom query function (preferred approach)
                query = taskInfo.options.query();
            } else if (taskInfo.options?.componentTarget) {
                // Use component targeting configuration (deprecated - use query instead)
                const componentTarget = taskInfo.options.componentTarget;
                query = this.buildQueryFromComponentTarget(componentTarget);
            } else if (taskInfo.componentTarget) {
                // Use legacy single component targeting (deprecated - use query instead)
                query = new Query().with(taskInfo.componentTarget);
            } else {
                throw new Error('No query function or component target specified');
            }

            // Apply entity limit if specified (can be used with query function)
            if (taskInfo.options?.maxEntitiesPerExecution) {
                query.take(taskInfo.options.maxEntitiesPerExecution);
            }

            const entities = await query.exec();

            // Execute the scheduled method with the entities array
            const method = taskInfo.service[taskInfo.methodName];
            if (typeof method !== 'function') {
                throw new Error(`Method ${taskInfo.methodName} not found on service`);
            }

            // Execute with timeout
            const result = await this.executeWithTimeout(
                method.call(taskInfo.service, entities),
                timeout,
                taskInfo
            );

            const duration = Date.now() - startTime;
            taskInfo.executionCount++;
            this.metrics.completedExecutions++;
            this.metrics.totalExecutionTime += duration;
            this.metrics.averageExecutionTime = this.metrics.totalExecutionTime / this.metrics.completedExecutions;

            // Update task-specific metrics
            this.updateTaskMetrics(taskInfo.id, {
                totalExecutions: taskInfo.executionCount,
                successfulExecutions: (this.metrics.taskMetrics[taskInfo.id]?.successfulExecutions || 0) + 1,
                averageExecutionTime: duration,
                lastExecutionTime: new Date(),
                totalEntitiesProcessed: entities.length
            });

            if (this.config.enableLogging) {
                loggerInstance.info(`Task ${taskInfo.name} completed successfully in ${duration}ms (processed ${entities.length} entities)`);
            }

            this.emitEvent({
                type: 'task.executed',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: { duration, entitiesProcessed: entities.length, success: true }
            });

        } catch (error) {
            const duration = Date.now() - startTime;
            this.metrics.failedExecutions++;

            // Handle retry logic
            await this.handleTaskFailure(taskInfo, error instanceof Error ? error : new Error(String(error)), duration);

            if (this.config.enableLogging) {
                loggerInstance.error(`Task ${taskInfo.name} failed after ${duration}ms: ${error instanceof Error ? error.message : String(error)}`);
            }

            this.emitEvent({
                type: 'task.failed',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: { duration, error: error instanceof Error ? error.message : String(error) }
            });

        } finally {
            taskInfo.isRunning = false;
            this.metrics.runningTasks--;
        }
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
            this.scheduleTask(taskInfo);
        }

        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduler started with ${this.tasks.size} tasks (sorted by priority)`);
        }

        this.emitEvent({
            type: 'scheduler.started',
            timestamp: new Date(),
            data: { taskCount: this.tasks.size }
        });
    }

    public stop(): void {
        if (!this.isRunning) {
            loggerInstance.warn("Scheduler is not running");
            return;
        }

        this.isRunning = false;

        // Clear all intervals and timeouts
        for (const intervalId of this.intervals.values()) {
            clearInterval(intervalId);
            clearTimeout(intervalId as any);
        }
        this.intervals.clear();

        if (this.config.enableLogging) {
            loggerInstance.info("Scheduler stopped");
        }

        this.emitEvent({
            type: 'scheduler.stopped',
            timestamp: new Date()
        });
    }

    public getMetrics(): SchedulerMetrics {
        return { ...this.metrics };
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
            this.scheduleTask(task);
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

    private emitEvent(event: SchedulerEvent): void {
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
        if (this.config.enableLogging) {
            loggerInstance.info(`Scheduler configuration updated: ${JSON.stringify(config)}`);
        }
    }

    public getConfig(): SchedulerConfig {
        return { ...this.config };
    }

    /**
     * Execute a task with timeout enforcement
     */
    private async executeWithTimeout<T>(task: Promise<T>, timeoutMs: number, taskInfo: ScheduledTaskInfo): Promise<T> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                clearTimeout(timeoutId);
                this.metrics.timedOutTasks++;
                this.updateTaskMetrics(taskInfo.id, {
                    timeoutCount: (this.metrics.taskMetrics[taskInfo.id]?.timeoutCount || 0) + 1
                });
                const error = new Error(`Task ${taskInfo.name} timed out after ${timeoutMs}ms`);
                this.emitEvent({
                    type: 'task.timeout',
                    taskId: taskInfo.id,
                    timestamp: new Date(),
                    data: { timeoutMs, taskName: taskInfo.name }
                });
                reject(error);
            }, timeoutMs);

            task
                .then((result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    /**
     * Handle task failure with retry logic
     */
    private async handleTaskFailure(taskInfo: ScheduledTaskInfo, error: Error, duration: number): Promise<void> {
        taskInfo.lastError = error.message;

        const maxRetries = taskInfo.options?.maxRetries || taskInfo.maxRetries || 0;
        const retryDelay = taskInfo.options?.retryDelay || 1000; // Default 1 second

        if (taskInfo.retryCount === undefined) {
            taskInfo.retryCount = 0;
        }

        if (taskInfo.retryCount < maxRetries) {
            taskInfo.retryCount++;
            this.metrics.retriedTasks++;

            this.updateTaskMetrics(taskInfo.id, {
                retryCount: taskInfo.retryCount
            });

            if (this.config.enableLogging) {
                loggerInstance.warn(`Task ${taskInfo.name} failed (attempt ${taskInfo.retryCount}/${maxRetries}), retrying in ${retryDelay}ms: ${error.message}`);
            }

            // Schedule retry
            setTimeout(async () => {
                await this.executeTask(taskInfo.id);
            }, retryDelay);

            this.emitEvent({
                type: 'task.retry',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: {
                    attempt: taskInfo.retryCount,
                    maxRetries,
                    retryDelay,
                    error: error.message
                }
            });
        } else {
            // Max retries reached or no retries configured
            this.updateTaskMetrics(taskInfo.id, {
                failedExecutions: (this.metrics.taskMetrics[taskInfo.id]?.failedExecutions || 0) + 1
            });

            if (this.config.enableLogging) {
                loggerInstance.error(`Task ${taskInfo.name} failed permanently after ${taskInfo.retryCount} attempts: ${error.message}`);
            }

            this.emitEvent({
                type: 'task.failed',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: {
                    duration,
                    error: error.message,
                    attempts: taskInfo.retryCount,
                    maxRetries
                }
            });
        }
    }

    /**
     * Update task-specific metrics
     */
    private updateTaskMetrics(taskId: string, updates: Partial<TaskMetrics>): void {
        if (!this.metrics.taskMetrics[taskId]) {
            const taskInfo = this.tasks.get(taskId);
            this.metrics.taskMetrics[taskId] = {
                taskId,
                taskName: taskInfo?.name || 'Unknown',
                totalExecutions: 0,
                successfulExecutions: 0,
                failedExecutions: 0,
                averageExecutionTime: 0,
                totalEntitiesProcessed: 0,
                retryCount: 0,
                timeoutCount: 0
            };
        }

        const metrics = this.metrics.taskMetrics[taskId];
        Object.assign(metrics, updates);

        // Update rolling averages
        if (updates.averageExecutionTime !== undefined) {
            const currentAvg = metrics.averageExecutionTime;
            const newCount = metrics.totalExecutions;
            metrics.averageExecutionTime = ((currentAvg * (newCount - 1)) + updates.averageExecutionTime) / newCount;
        }
    }

    /**
     * Get detailed metrics for a specific task
     */
    public getTaskMetrics(taskId: string): TaskMetrics | null {
        return this.metrics.taskMetrics[taskId] || null;
    }

    /**
     * Get all task metrics
     */
    public getAllTaskMetrics(): Record<string, TaskMetrics> {
        return { ...this.metrics.taskMetrics };
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

    /**
     * Build a Query object from ComponentTargetConfig
     * @param componentTarget The component targeting configuration
     * @returns A Query object configured with the component targeting
     */
    private buildQueryFromComponentTarget(componentTarget: ComponentTargetConfig): Query {
        let query = new Query();

        // Handle archetype matching first (most specific)
        if (componentTarget.archetype) {
            // For archetype matching, we need to include all components from the archetype
            const archetypeComponents = this.getArchetypeComponents(componentTarget.archetype);
            for (const component of archetypeComponents) {
                query = query.with(component);
            }
        } else if (componentTarget.archetypes && componentTarget.archetypes.length > 0) {
            // Handle multiple archetypes - for simplicity, we'll use the first valid one
            // In a more advanced implementation, you might want to handle OR logic
            const firstArchetype = componentTarget.archetypes.find(archetype => archetype !== undefined);
            if (firstArchetype) {
                const archetypeComponents = this.getArchetypeComponents(firstArchetype);
                for (const component of archetypeComponents) {
                    query = query.with(component);
                }
            }
        }

        // Handle included components
        if (componentTarget.includeComponents && componentTarget.includeComponents.length > 0) {
            const requireAll = componentTarget.requireAllIncluded ?? true;
            if (requireAll) {
                // ALL included components must be present (AND logic)
                for (const component of componentTarget.includeComponents) {
                    query = query.with(component);
                }
            } else {
                // ANY included component must be present (OR logic)
                // For OR logic with Query API, we need to use a different approach
                // This is a simplified implementation - in practice, you might need custom query logic
                for (const component of componentTarget.includeComponents) {
                    query = query.with(component);
                    break; // Just use the first one for simplicity
                }
            }
        }

        // Handle excluded components
        if (componentTarget.excludeComponents && componentTarget.excludeComponents.length > 0) {
            for(const component of componentTarget.excludeComponents){
                query = query.without(component);
            }
        }

        return query;
    }

    /**
     * Extract component classes from an ArcheType
     * @param archetype The archetype to extract components from
     * @returns Array of component classes
     */
    private getArchetypeComponents(archetype: ArcheType): (new () => BaseComponent)[] {
        // Access the private componentMap from ArcheType
        const componentMap = (archetype as any).componentMap as Record<string, new () => BaseComponent>;
        if (!componentMap) {
            return [];
        }
        return Object.values(componentMap);
    }
}