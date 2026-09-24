import type { LifecycleEvent } from "../events/EntityLifecycleEvents";
import { logger as MainLogger } from "../Logger";
import type { RegisteredHook, HookMetrics, RegistryState } from "./registry";
import { matchesCompiledTarget } from "./guards";
import { trackSideEffect } from "../entity/pendingOps";

const logger = MainLogger.child({ scope: "EntityHookManager" });

/**
 * Dispatcher state owned by the manager instance
 */
export interface DispatcherState {
    metrics: Map<string, HookMetrics>;
    globalMetrics: HookMetrics;
}

/**
 * Create initial dispatcher state
 */
export function createDispatcherState(): DispatcherState {
    return {
        metrics: new Map(),
        globalMetrics: {
            totalExecutions: 0,
            totalExecutionTime: 0,
            averageExecutionTime: 0,
            errorCount: 0,
            lastExecutionTime: 0
        }
    };
}

/**
 * Record hook execution metrics
 */
export function recordMetrics(state: DispatcherState, eventType: string, executionTime: number, hadErrors: boolean): void {
    // Update event-specific metrics
    let eventMetrics = state.metrics.get(eventType);
    if (!eventMetrics) {
        eventMetrics = {
            totalExecutions: 0,
            totalExecutionTime: 0,
            averageExecutionTime: 0,
            errorCount: 0,
            lastExecutionTime: 0
        };
        state.metrics.set(eventType, eventMetrics);
    }

    eventMetrics.totalExecutions++;
    eventMetrics.totalExecutionTime += executionTime;
    eventMetrics.averageExecutionTime = eventMetrics.totalExecutionTime / eventMetrics.totalExecutions;
    eventMetrics.lastExecutionTime = executionTime;
    if (hadErrors) {
        eventMetrics.errorCount++;
    }

    // Update global metrics
    state.globalMetrics.totalExecutions++;
    state.globalMetrics.totalExecutionTime += executionTime;
    state.globalMetrics.averageExecutionTime = state.globalMetrics.totalExecutionTime / state.globalMetrics.totalExecutions;
    state.globalMetrics.lastExecutionTime = executionTime;
    if (hadErrors) {
        state.globalMetrics.errorCount++;
    }
}

/**
 * Get performance metrics for hook execution
 */
export function getMetrics(state: DispatcherState, eventType?: string): HookMetrics {
    if (eventType) {
        return state.metrics.get(eventType) || {
            totalExecutions: 0,
            totalExecutionTime: 0,
            averageExecutionTime: 0,
            errorCount: 0,
            lastExecutionTime: 0
        };
    }
    return { ...state.globalMetrics };
}

/**
 * Reset performance metrics
 */
export function resetMetrics(state: DispatcherState, eventType?: string): void {
    if (eventType) {
        state.metrics.delete(eventType);
    } else {
        state.metrics.clear();
        state.globalMetrics = {
            totalExecutions: 0,
            totalExecutionTime: 0,
            averageExecutionTime: 0,
            errorCount: 0,
            lastExecutionTime: 0
        };
    }
    logger.trace(`Reset metrics${eventType ? ` for ${eventType}` : ''}`);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return value != null && typeof (value as PromiseLike<unknown>).then === "function";
}

function hookMatches(hook: RegisteredHook, event: LifecycleEvent): boolean {
    if (!matchesCompiledTarget(event, hook.compiledTarget)) return false;
    if (hook.options.filter && !hook.options.filter(event)) return false;
    return true;
}

/**
 * Run a hook. Sync callbacks are invoked inline (no Promise.resolve().then).
 * A thenable return is awaited so an `async` function registered with
 * `async: false` cannot escape as an unhandled rejection (C13).
 */
async function invokeHook(hook: RegisteredHook, event: LifecycleEvent): Promise<void> {
    const timeout = hook.options.timeout;
    if (timeout && timeout > 0) {
        const result = hook.callback(event);
        const hookPromise = Promise.resolve(result);
        // Detach a catch so a rejection that loses the race is not unhandled (H-HOOK-2).
        hookPromise.catch((err) => {
            logger.warn({ hookId: hook.id, err }, `Late rejection from hook after timeout`);
        });
        let timerHandle: NodeJS.Timeout | number | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timerHandle = setTimeout(
                () => reject(new Error(`Hook ${hook.id} timed out after ${timeout}ms`)),
                timeout
            );
            // Bun/Node Timeout has unref; DOM lib types the handle as a number.
            const nodeHandle = timerHandle as unknown as { unref?: () => void };
            nodeHandle.unref?.();
        });
        try {
            await Promise.race([hookPromise, timeoutPromise]);
        } finally {
            clearTimeout(timerHandle);
        }
        return;
    }

    const result = hook.callback(event);
    if (isThenable(result)) {
        await result;
    }
}

/**
 * `async: true` hooks must not sit on the save critical path. Schedule them
 * like component.added: a microtask, errors logged, tracked for shutdown drain.
 */
function enqueueAsyncHook(hook: RegisteredHook, event: LifecycleEvent, eventType: string): void {
    const tracked = Promise.resolve().then(async () => {
        if (!hookMatches(hook, event)) return;
        try {
            await invokeHook(hook, event);
        } catch (error) {
            logger.error(`Error executing async hook ${hook.id} for event ${eventType}: ${error}`);
        }
    }).catch((err) => {
        logger.error({ hookId: hook.id, err }, `Detached async hook failed for event ${eventType}`);
    });
    trackSideEffect(tracked);
}

async function runSyncHooks(hooks: RegisteredHook[], event: LifecycleEvent, eventType: string): Promise<boolean> {
    let hadErrors = false;
    for (const hook of hooks) {
        if (!hookMatches(hook, event)) continue;
        try {
            await invokeHook(hook, event);
        } catch (error) {
            logger.error(`Error executing sync hook ${hook.id} for event ${eventType}: ${error}`);
            hadErrors = true;
        }
    }
    return hadErrors;
}

/**
 * Execute hooks for a specific event.
 *
 * No-hook events return before `performance.now()` and before any array
 * allocation. Sync hooks run inline. `async: true` hooks are enqueued and
 * are not awaited — callers on the save path must not wait on them.
 */
export async function executeHooks(registryState: RegistryState, dispatcherState: DispatcherState, event: LifecycleEvent): Promise<void> {
    const eventType = event.getEventType();
    const partition = registryState.partitions.get(eventType);
    if (!partition) return;

    const startTime = performance.now();
    logger.trace(`Executing ${partition.sync.length + partition.async.length} hooks for event: ${eventType}`);

    const hadErrors = await runSyncHooks(partition.sync, event, eventType);

    for (const hook of partition.async) {
        enqueueAsyncHook(hook, event, eventType);
    }

    recordMetrics(dispatcherState, eventType, performance.now() - startTime, hadErrors);
}

/**
 * Execute hooks for multiple events in batch.
 * Async hooks are detached, same as {@link executeHooks}.
 */
export async function executeHooksBatch(registryState: RegistryState, dispatcherState: DispatcherState, events: LifecycleEvent[]): Promise<void> {
    if (events.length === 0) return;

    const eventsByType = new Map<string, LifecycleEvent[]>();
    for (const event of events) {
        const eventType = event.getEventType();
        const partition = registryState.partitions.get(eventType);
        if (!partition) continue;
        let bucket = eventsByType.get(eventType);
        if (!bucket) {
            bucket = [];
            eventsByType.set(eventType, bucket);
        }
        bucket.push(event);
    }
    if (eventsByType.size === 0) return;

    logger.trace(`Executing hooks for ${events.length} events in batch`);

    for (const [eventType, typeEvents] of eventsByType) {
        const partition = registryState.partitions.get(eventType);
        if (!partition) continue;
        const startTime = performance.now();
        let hadErrors = false;
        for (const event of typeEvents) {
            if (await runSyncHooks(partition.sync, event, eventType)) hadErrors = true;
            for (const hook of partition.async) {
                enqueueAsyncHook(hook, event, eventType);
            }
        }
        recordMetrics(dispatcherState, eventType, performance.now() - startTime, hadErrors);
    }
}
