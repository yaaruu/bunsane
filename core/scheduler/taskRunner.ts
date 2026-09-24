import { logger } from "../Logger";
import { Query } from "../../query/Query";
import ArcheType from "../ArcheType";
import { BaseComponent } from "../components";
import type { ScheduledTaskInfo, SchedulerMetrics, TaskMetrics } from "../../types/scheduler.types";
import { DEFAULT_MAX_ENTITIES_PER_EXECUTION } from "../../types/scheduler.types";
import type { ComponentTargetConfig } from "../EntityHookManager";
import type { SchedulerManager } from "../SchedulerManager";
import { startLeaseHeartbeat } from "./withLock";

const loggerInstance = logger.child({ scope: "SchedulerManager" });

/** Lease must strictly outlive the wrapper timeout so a peer cannot acquire during overrun. */
export const SCHEDULER_LEASE_MARGIN_MS = 5_000;

const entityCapWarned = new Set<string>();

export function leaseTtlForTask(timeoutMs: number, configuredTtlMs: number): number {
    return Math.max(configuredTtlMs, timeoutMs + SCHEDULER_LEASE_MARGIN_MS);
}

export function updateTaskMetrics(manager: SchedulerManager, taskId: string, updates: Partial<TaskMetrics>): void {
    if (!manager.metrics.taskMetrics[taskId]) {
        const taskInfo = manager.tasks.get(taskId);
        manager.metrics.taskMetrics[taskId] = {
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

    const metrics = manager.metrics.taskMetrics[taskId];
    Object.assign(metrics, updates);

    // Update rolling averages
    if (updates.averageExecutionTime !== undefined) {
        const currentAvg = metrics.averageExecutionTime;
        const newCount = metrics.totalExecutions;
        metrics.averageExecutionTime = ((currentAvg * (newCount - 1)) + updates.averageExecutionTime) / newCount;
    }
}

/**
 * Execute a task with timeout enforcement.
 *
 * Note: JS has no way to cancel an arbitrary Promise — on timeout the
 * wrapper rejects but the underlying task continues. The second .catch
 * below captures a late rejection after the wrapper already rejected,
 * preventing an unhandled-rejection process crash (H-SCHED-5). The
 * `settled` flag guards against double-settle.
 */
export async function executeWithTimeout<T>(
    manager: SchedulerManager,
    task: Promise<T>,
    timeoutMs: number,
    taskInfo: ScheduledTaskInfo
): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            manager.metrics.timedOutTasks++;
            updateTaskMetrics(manager, taskInfo.id, {
                timeoutCount: (manager.metrics.taskMetrics[taskInfo.id]?.timeoutCount || 0) + 1
            });
            const error = new Error(`Task ${taskInfo.name} timed out after ${timeoutMs}ms`);
            manager.emitEvent({
                type: 'task.timeout',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: { timeoutMs, taskName: taskInfo.name }
            });
            reject(error);
        }, timeoutMs);

        task
            .then((result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch((error) => {
                if (settled) {
                    // Late rejection after timeout. Log only — the wrapper
                    // promise is already settled, so re-rejecting would be
                    // a no-op but the rejection would escape as unhandled.
                    loggerInstance.warn({ taskId: taskInfo.id, err: error }, 'Late rejection from scheduled task after timeout');
                    return;
                }
                settled = true;
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

/**
 * Handle task failure with retry logic
 */
export async function handleTaskFailure(
    manager: SchedulerManager,
    taskInfo: ScheduledTaskInfo,
    error: Error,
    duration: number
): Promise<void> {
    taskInfo.lastError = error.message;

    const maxRetries = taskInfo.options?.maxRetries || taskInfo.maxRetries || 0;
    const retryDelay = taskInfo.options?.retryDelay || 1000; // Default 1 second

    if (taskInfo.retryCount === undefined) {
        taskInfo.retryCount = 0;
    }

    if (taskInfo.retryCount < maxRetries) {
        taskInfo.retryCount++;
        manager.metrics.retriedTasks++;

        updateTaskMetrics(manager, taskInfo.id, {
            retryCount: taskInfo.retryCount
        });

        if (manager.config.enableLogging) {
            loggerInstance.warn(`Task ${taskInfo.name} failed (attempt ${taskInfo.retryCount}/${maxRetries}), retrying in ${retryDelay}ms: ${error.message}`);
        }

        // Schedule retry. Track the timer handle in `intervals` under a
        // unique key so `stop()` can clear it (H-SCHED-3); without this
        // the retry fires post-shutdown against a closed DB pool. Also
        // skip the retry if the scheduler is no longer running by the
        // time the timer fires, and rely on the new isRunning guard in
        // doExecuteTask (H-SCHED-1) to prevent retry/tick overlap.
        const retryKey = `${taskInfo.id}:retry:${taskInfo.retryCount}`;
        const retryHandle = setTimeout(async () => {
            manager.intervals.delete(retryKey);
            if (!manager.isRunning) return;
            await (manager as any).executeTask(taskInfo.id);
        }, retryDelay);
        manager.intervals.set(retryKey, retryHandle as any);

        manager.emitEvent({
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
        updateTaskMetrics(manager, taskInfo.id, {
            failedExecutions: (manager.metrics.taskMetrics[taskInfo.id]?.failedExecutions || 0) + 1
        });

        if (manager.config.enableLogging) {
            loggerInstance.error(`Task ${taskInfo.name} failed permanently after ${taskInfo.retryCount} attempts: ${error.message}`);
        }

        manager.emitEvent({
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
 * Build a Query object from ComponentTargetConfig
 * @param componentTarget The component targeting configuration
 * @returns A Query object configured with the component targeting
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildQueryFromComponentTarget(componentTarget: ComponentTargetConfig): Query<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: Query<any> = new Query();

    // Handle archetype matching first (most specific)
    if (componentTarget.archetype) {
        // For archetype matching, we need to include all components from the archetype
        const archetypeComponents = getArchetypeComponents(componentTarget.archetype);
        for (const component of archetypeComponents) {
            query = query.with(component);
        }
    } else if (componentTarget.archetypes && componentTarget.archetypes.length > 0) {
        // Handle multiple archetypes - for simplicity, we'll use the first valid one
        // In a more advanced implementation, you might want to handle OR logic
        const firstArchetype = componentTarget.archetypes.find(archetype => archetype !== undefined);
        if (firstArchetype) {
            const archetypeComponents = getArchetypeComponents(firstArchetype);
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
export function getArchetypeComponents(archetype: ArcheType): (new () => BaseComponent)[] {
    // Access the private componentMap from ArcheType
    const componentMap = (archetype as any).componentMap as Record<string, new () => BaseComponent>;
    if (!componentMap) {
        return [];
    }
    return Object.values(componentMap);
}

export async function doExecuteTask(manager: SchedulerManager, taskId: string): Promise<void> {
    const taskInfo = manager.tasks.get(taskId);
    if (!taskInfo || !taskInfo.enabled) {
        return;
    }

    // Skip if the previous tick is still executing. Without this guard
    // a slow task with interval < execution-time burns a lock-acquire
    // round-trip every tick and floods the skipped-executions metric
    // (H-SCHED-1). Cheap in-process check before reaching out to PG.
    if (taskInfo.isRunning) {
        manager.metrics.skippedExecutions++;
        if (manager.config.enableLogging) {
            loggerInstance.debug(`Task ${taskInfo.name} skipped - previous execution still running`);
        }
        return;
    }

    if (manager.metrics.runningTasks >= manager.config.maxConcurrentTasks) {
        if (manager.config.enableLogging) {
            loggerInstance.warn(`Maximum concurrent tasks reached. Skipping execution of ${taskInfo.name}`);
        }
        return;
    }

    const timeout = taskInfo.options?.timeout || manager.config.defaultTimeout;
    // Lease must outlive the wrapper timeout. Heartbeat extends it if the
    // task overruns the wrapper (the promise cannot be cancelled).
    const leaseTtlMs = leaseTtlForTask(timeout, manager.distributedLock.getLeaseTtlMs());

    // Try to acquire distributed lock before executing
    manager.metrics.lockAttempts++;
    const lockResult = await manager.distributedLock.tryAcquire(taskId, leaseTtlMs);

    if (!lockResult.acquired) {
        // Another instance is executing this task
        manager.metrics.skippedExecutions++;

        if (manager.config.enableLogging) {
            loggerInstance.debug(`Task ${taskInfo.name} skipped - another instance is executing (lock key: ${lockResult.lockKey})`);
        }

        manager.emitEvent({
            type: 'task.skipped',
            taskId: taskInfo.id,
            timestamp: new Date(),
            data: { reason: 'lock_unavailable', lockKey: lockResult.lockKey.toString() }
        });

        return;
    }

    // Lock acquired successfully
    manager.metrics.locksAcquired++;

    manager.emitEvent({
        type: 'task.lock.acquired',
        taskId: taskInfo.id,
        timestamp: new Date(),
        data: { lockKey: lockResult.lockKey.toString() }
    });

    const stopHeartbeat = manager.distributedLock.getConfig().enabled
        ? startLeaseHeartbeat(manager.distributedLock, taskId, leaseTtlMs)
        : () => undefined;

    let releasePromise: Promise<void> | null = null;
    const releaseLock = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        stopHeartbeat();
        releasePromise = manager.distributedLock.release(taskId).then(() => {
            manager.emitEvent({
                type: 'task.lock.released',
                taskId: taskInfo.id,
                timestamp: new Date(),
                data: { lockKey: lockResult.lockKey.toString() }
            });
        });
        return releasePromise;
    };

    const clearRunning = () => {
        taskInfo.isRunning = false;
        manager.metrics.runningTasks--;
    };

    taskInfo.isRunning = true;
    taskInfo.lastExecution = new Date();
    manager.metrics.runningTasks++;

    const startTime = Date.now();
    // True until a live task promise is created. Setup failures release immediately.
    let workDone = true;
    let settleRelease: Promise<unknown> | null = null;
    // Wrapper timeout must not arm the retry while isRunning is still true,
    // or the retry hits the overlap guard and the budget is consumed.
    let deferredRetry: { error: Error; duration: number } | null = null;
    const armDeferredRetry = (): void => {
        const pending = deferredRetry;
        if (!pending) return;
        deferredRetry = null;
        void handleTaskFailure(manager, taskInfo, pending.error, pending.duration).catch((err) => {
            loggerInstance.error(
                { taskId: taskInfo.id, err },
                'Failed to schedule retry after scheduled-task timeout'
            );
        });
    };

    try {
        // Create query based on targeting configuration
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: Query<any> | null = null;

        if (taskInfo.options?.query) {
            // Use custom query function (preferred approach)
            query = taskInfo.options.query();
        } else if (taskInfo.options?.componentTarget) {
            // Use component targeting configuration (deprecated - use query instead)
            const componentTarget = taskInfo.options.componentTarget;
            query = buildQueryFromComponentTarget(componentTarget);
        } else if (taskInfo.componentTarget) {
            // Use legacy single component targeting (deprecated - use query instead)
            query = new Query().with(taskInfo.componentTarget);
        }
        // else: time-based task — no entity selection. Handler invoked
        // with no arguments on each tick.

        let usedDefaultCap = false;
        let appliedCap = 0;
        if (query) {
            const explicitCap = taskInfo.options?.maxEntitiesPerExecution;
            if (explicitCap != null && explicitCap > 0) {
                query.take(explicitCap);
                appliedCap = explicitCap;
            } else {
                // Query.context is not on the public type. Do not raise a
                // .take() the author already set; only cap missing/larger limits.
                const carrier = query as unknown as { context?: { limit?: number | null } };
                const existing = carrier.context?.limit;
                appliedCap = DEFAULT_MAX_ENTITIES_PER_EXECUTION;
                if (typeof existing !== "number" || existing > appliedCap) {
                    query.take(appliedCap);
                    usedDefaultCap = true;
                } else {
                    appliedCap = existing;
                }
            }
        }

        const entities = query ? await query.exec() : [];
        if (usedDefaultCap && entities.length >= appliedCap && !entityCapWarned.has(taskInfo.id)) {
            entityCapWarned.add(taskInfo.id);
            loggerInstance.warn(
                `Task ${taskInfo.name} hit the default entity cap of ${appliedCap}. Set maxEntitiesPerExecution (or a smaller query.take()) to confirm the limit.`
            );
        }

        // Execute the scheduled method with the entities array
        const method = taskInfo.service[taskInfo.methodName];
        if (typeof method !== 'function') {
            throw new Error(`Method ${taskInfo.methodName} not found on service`);
        }

        let invocation: unknown;
        try {
            invocation = query
                ? method.call(taskInfo.service, entities)
                : method.call(taskInfo.service);
        } catch (err) {
            invocation = Promise.reject(err);
        }
        const taskPromise = Promise.resolve(invocation);
        workDone = false;
        settleRelease = taskPromise.finally(() => {
            workDone = true;
            return releaseLock();
        });

        // Execute with timeout. Time-based tasks receive no entity arg.
        // On timeout the wrapper rejects but taskPromise keeps running;
        // the lock is released only from taskPromise.finally above.
        await executeWithTimeout(manager, taskPromise, timeout, taskInfo);

        const duration = Date.now() - startTime;
        taskInfo.executionCount++;
        manager.metrics.completedExecutions++;
        manager.metrics.totalExecutionTime += duration;
        manager.metrics.averageExecutionTime = manager.metrics.totalExecutionTime / manager.metrics.completedExecutions;

        updateTaskMetrics(manager, taskInfo.id, {
            totalExecutions: taskInfo.executionCount,
            successfulExecutions: (manager.metrics.taskMetrics[taskInfo.id]?.successfulExecutions || 0) + 1,
            averageExecutionTime: duration,
            lastExecutionTime: new Date(),
            totalEntitiesProcessed: entities.length
        });

        if (manager.config.enableLogging) {
            loggerInstance.info(`Task ${taskInfo.name} completed successfully in ${duration}ms (processed ${entities.length} entities)`);
        }

        manager.emitEvent({
            type: 'task.executed',
            taskId: taskInfo.id,
            timestamp: new Date(),
            data: { duration, entitiesProcessed: entities.length, success: true }
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));
        manager.metrics.failedExecutions++;

        if (!workDone) {
            deferredRetry = { error: err, duration };
        } else {
            await handleTaskFailure(manager, taskInfo, err, duration);
        }

        if (manager.config.enableLogging) {
            loggerInstance.error(`Task ${taskInfo.name} failed after ${duration}ms: ${err.message}`);
        }

        manager.emitEvent({
            type: 'task.failed',
            taskId: taskInfo.id,
            timestamp: new Date(),
            data: { duration, error: err.message }
        });

    } finally {
        const afterSettled = (): void => {
            clearRunning();
            armDeferredRetry();
        };
        if (workDone) {
            if (settleRelease) await Promise.allSettled([settleRelease]);
            else await releaseLock();
            afterSettled();
        } else if (settleRelease) {
            // Wrapper timed out; the task promise is still running. Do not
            // release the lock or clear isRunning until it actually settles.
            // .then(onOk, onErr) swallows the late rejection — .finally()
            // would rethrow it as an unhandled rejection.
            void settleRelease.then(afterSettled, (err) => {
                loggerInstance.warn(
                    { taskId: taskInfo.id, err },
                    'Scheduled task rejected after wrapper timeout'
                );
                afterSettled();
            });
        } else {
            afterSettled();
        }
    }
}

export async function executeTask(manager: SchedulerManager, taskId: string): Promise<void> {
    // Track this execution so stop() can await in-flight work before
    // resources (DB pool, cache) are torn down. Without this, a task mid-
    // write during SIGTERM hits a closed DB pool and silently corrupts
    // or loses data.
    const p = doExecuteTask(manager, taskId);
    manager.inflightTasks.add(p);
    p.finally(() => manager.inflightTasks.delete(p));
    return p;
}
