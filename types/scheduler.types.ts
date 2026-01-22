/**
 * System Scheduler Type Definitions
 * Comprehensive TypeScript types for the BunSane scheduler system
 */

import type { QueryFilter } from "../query/Query";
import type { Query } from "../query/Query";
import type { ComponentTargetConfig } from "../core/EntityHookManager";

export enum ScheduleInterval {
    MINUTE = "minute",
    HOUR = "hour",
    DAILY = "daily",
    WEEKLY = "weekly",
    MONTHLY = "monthly",
    CRON = "cron"
}

export interface ScheduledTaskOptions {
    /** Unique identifier for the task */
    id?: string;
    /** Human-readable name for the task */
    name?: string;
    /** Whether the task should run immediately on startup */
    runOnStart?: boolean;
    /** Maximum execution time in milliseconds */
    timeout?: number;
    /** Whether to enable logging for this task */
    enableLogging?: boolean;
    /** Priority for execution ordering (higher numbers execute first) */
    priority?: number;
    /** Maximum retry attempts for failed tasks */
    maxRetries?: number;
    /** Delay between retry attempts in milliseconds */
    retryDelay?: number;
    /** Whether to continue retrying on failure */
    continueOnError?: boolean;
    /** 
     * Maximum number of entities to process per execution
     * Note: This is applied after the query executes. For better performance,
     * include .take() in your query function instead.
     */
    maxEntitiesPerExecution?: number;
    /** Whether to enable task metrics collection */
    enableMetrics?: boolean;
    /** 
     * Component targeting configuration for fine-grained entity selection
     * @deprecated Use query() function instead for better flexibility and readability
     */
    componentTarget?: ComponentTargetConfig;
    /** 
     * Custom query function for advanced entity selection (preferred approach)
     * @example
     * query: () => {
     *     return new Query()
     *         .with(SessionComponent)
     *         .with(PhoneComponent)
     *         .without(AuthenticatedTag);
     * }
     */
    query?: () => Query<any>;
    /** Cron expression (when interval is CRON) */
    cronExpression?: string;
}

export interface ScheduledTaskInfo {
    /** Unique task identifier */
    id: string;
    /** Task name */
    name: string;
    /** 
     * Target component class (legacy - use options.query instead) 
     * @deprecated Use options.query for better flexibility
     */
    componentTarget?: new (...args: any[]) => any;
    /** Schedule interval */
    interval: ScheduleInterval;
    /** Cron expression (when interval is CRON) */
    cronExpression?: string;
    /** Task options */
    options: ScheduledTaskOptions;
    /** Service instance */
    service: any;
    /** Method name to execute */
    methodName: string;
    /** Next execution timestamp */
    nextExecution: Date;
    /** Last execution timestamp */
    lastExecution?: Date;
    /** Execution count */
    executionCount: number;
    /** Whether task is currently running */
    isRunning: boolean;
    /** Whether task is enabled */
    enabled: boolean;
    /** Priority for execution ordering (higher numbers execute first) */
    priority?: number;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Current retry count */
    retryCount?: number;
    /** Last error message */
    lastError?: string;
}

export interface SchedulerMetrics {
    /** Total number of registered tasks */
    totalTasks: number;
    /** Number of currently running tasks */
    runningTasks: number;
    /** Number of completed executions */
    completedExecutions: number;
    /** Number of failed executions */
    failedExecutions: number;
    /** Average execution time in milliseconds */
    averageExecutionTime: number;
    /** Total execution time in milliseconds */
    totalExecutionTime: number;
    /** Number of timed out tasks */
    timedOutTasks: number;
    /** Number of retried tasks */
    retriedTasks: number;
    /** Task-specific metrics */
    taskMetrics: Record<string, TaskMetrics>;
    /** Number of task executions skipped due to distributed lock unavailability */
    skippedExecutions: number;
    /** Total lock acquisition attempts */
    lockAttempts: number;
    /** Successful lock acquisitions */
    locksAcquired: number;
}

export interface TaskMetrics {
    /** Task ID */
    taskId: string;
    /** Task name */
    taskName: string;
    /** Total executions */
    totalExecutions: number;
    /** Successful executions */
    successfulExecutions: number;
    /** Failed executions */
    failedExecutions: number;
    /** Average execution time */
    averageExecutionTime: number;
    /** Last execution time */
    lastExecutionTime?: Date;
    /** Total entities processed */
    totalEntitiesProcessed: number;
    /** Retry count */
    retryCount: number;
    /** Timeout count */
    timeoutCount: number;
}

export interface TaskExecutionResult {
    /** Whether execution was successful */
    success: boolean;
    /** Execution duration in milliseconds */
    duration: number;
    /** Number of entities processed */
    entitiesProcessed: number;
    /** Error message if execution failed */
    error?: string;
    /** Timestamp of execution */
    executedAt: Date;
}

export interface SchedulerEvent {
    /** Event type */
    type: 'task.registered' | 'task.executed' | 'task.failed' | 'task.timeout' | 'task.retry' | 'task.skipped' | 'task.lock.acquired' | 'task.lock.released' | 'task.lock.failed' | 'scheduler.started' | 'scheduler.stopped';
    /** Task ID if applicable */
    taskId?: string;
    /** Event timestamp */
    timestamp: Date;
    /** Additional event data */
    data?: any;
}

export type SchedulerEventCallback = (event: SchedulerEvent) => void;

export interface SchedulerConfig {
    /** Whether scheduler is enabled */
    enabled: boolean;
    /** Maximum concurrent tasks */
    maxConcurrentTasks: number;
    /** Default task timeout in milliseconds */
    defaultTimeout: number;
    /** Whether to enable detailed logging */
    enableLogging: boolean;
    /** Whether to run tasks on startup */
    runOnStart: boolean;
    /**
     * Enable distributed locking using PostgreSQL advisory locks.
     * When enabled, only one instance can execute a task at a time.
     * This is essential for multi-instance deployments.
     * @default true
     */
    distributedLocking?: boolean;
    /**
     * Lock acquisition timeout in milliseconds.
     * If > 0, will retry acquiring the lock until timeout.
     * If 0, immediately skips if lock is not available.
     * @default 0
     */
    lockTimeout?: number;
    /**
     * Retry interval when attempting to acquire locks (ms).
     * Only used when lockTimeout > 0.
     * @default 100
     */
    lockRetryInterval?: number;
}

export interface DistributedLockMetrics {
    /** Total lock acquisition attempts */
    lockAttempts: number;
    /** Successful lock acquisitions */
    locksAcquired: number;
    /** Failed lock acquisitions (another instance holds lock) */
    locksFailed: number;
    /** Lock acquisition timeouts */
    lockTimeouts: number;
    /** Tasks skipped due to lock unavailability */
    tasksSkipped: number;
}