import type { LifecycleEvent } from "../events/EntityLifecycleEvents";
import { logger as MainLogger } from "../Logger";
import type { RegisteredHook, HookMetrics, RegistryState } from "./registry";
import { matchesComponentTarget } from "./guards";

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

/**
 * Execute hooks for a specific event
 */
export async function executeHooks(registryState: RegistryState, dispatcherState: DispatcherState, event: LifecycleEvent): Promise<void> {
    const eventType = event.getEventType();
    const hooks = registryState.hooks.get(eventType) || [];
    const startTime = performance.now();
    let hadErrors = false;

    if (hooks.length === 0) {
        return;
    }

    logger.trace(`Executing ${hooks.length} hooks for event: ${eventType}`);

    // Separate sync and async hooks
    const syncHooks = hooks.filter(hook => !hook.options.async);
    const asyncHooks = hooks.filter(hook => hook.options.async);

    // Execute sync hooks immediately
    for (const hook of syncHooks) {
        // Check component targeting first
        if (!matchesComponentTarget(event, hook.options.componentTarget)) {
            continue;
        }

        // Check filter condition
        if (hook.options.filter && !hook.options.filter(event)) {
            continue;
        }

        try {
            if (hook.options.timeout && hook.options.timeout > 0) {
                // Execute with timeout. Timer handle is stored so the
                // normal-completion path clears it (no leaked pending
                // timers per successful hook). The underlying callback
                // promise is attached with a detached .catch so a late
                // rejection after timeout does not escape as unhandled
                // (H-HOOK-2 / H-MEM-2).
                let timerHandle: ReturnType<typeof setTimeout> | null = null;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timerHandle = setTimeout(
                        () => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)),
                        hook.options.timeout
                    );
                    (timerHandle as unknown as { unref?: () => void }).unref?.();
                });
                const hookPromise = Promise.resolve().then(() => hook.callback(event));
                hookPromise.catch((err) => {
                    logger.warn({ hookId: hook.id, err }, `Late rejection from hook after timeout`);
                });
                try {
                    await Promise.race([hookPromise, timeoutPromise]);
                } finally {
                    if (timerHandle) clearTimeout(timerHandle);
                }
            } else {
                // Always await — callback may be an async function declared
                // with async:false by mistake. Without await, a rejection
                // from such a callback escapes as an unhandled rejection
                // and crashes the process under strict mode (C13).
                await hook.callback(event);
            }
        } catch (error) {
            logger.error(`Error executing sync hook ${hook.id} for event ${eventType}: ${error}`);
            hadErrors = true;
            // Continue executing other hooks even if one fails
        }
    }

    // Execute async hooks in parallel
    if (asyncHooks.length > 0) {
        const asyncPromises = asyncHooks.map(async (hook) => {
            // Check component targeting first
            if (!matchesComponentTarget(event, hook.options.componentTarget)) {
                return;
            }

            // Check filter condition
            if (hook.options.filter && !hook.options.filter(event)) {
                return;
            }

            try {
                if (hook.options.timeout && hook.options.timeout > 0) {
                    // Execute with timeout. See sync path for rationale —
                    // clear the timer on normal completion and detach a
                    // .catch on the hook promise so late rejections do
                    // not escape (H-HOOK-2 / H-MEM-2).
                    let timerHandle: ReturnType<typeof setTimeout> | null = null;
                    const hookPromise = Promise.resolve().then(() => hook.callback(event));
                    hookPromise.catch((err) => {
                        logger.warn({ hookId: hook.id, err }, `Late rejection from hook after timeout`);
                    });
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timerHandle = setTimeout(
                            () => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)),
                            hook.options.timeout
                        );
                        (timerHandle as unknown as { unref?: () => void }).unref?.();
                    });
                    try {
                        await Promise.race([hookPromise, timeoutPromise]);
                    } finally {
                        if (timerHandle) clearTimeout(timerHandle);
                    }
                } else {
                    // Execute normally
                    await hook.callback(event);
                }
            } catch (error) {
                logger.error(`Error executing async hook ${hook.id} for event ${eventType}: ${error}`);
                hadErrors = true;
                // Continue executing other hooks even if one fails
            }
        });

        await Promise.allSettled(asyncPromises);
    }

    // Record performance metrics
    const executionTime = performance.now() - startTime;
    recordMetrics(dispatcherState, eventType, executionTime, hadErrors);
}

/**
 * Execute hooks for multiple events in batch
 */
export async function executeHooksBatch(registryState: RegistryState, dispatcherState: DispatcherState, events: LifecycleEvent[]): Promise<void> {
    if (events.length === 0) {
        return;
    }

    logger.trace(`Executing hooks for ${events.length} events in batch`);

    // Group events by type for efficient processing
    const eventsByType = new Map<string, LifecycleEvent[]>();
    for (const event of events) {
        const eventType = event.getEventType();
        if (!eventsByType.has(eventType)) {
            eventsByType.set(eventType, []);
        }
        eventsByType.get(eventType)!.push(event);
    }

    // Process each event type
    const promises: Promise<void>[] = [];
    for (const [eventType, typeEvents] of eventsByType.entries()) {
        promises.push(executeHooksForType(registryState, dispatcherState, eventType, typeEvents));
    }

    await Promise.allSettled(promises);
}

/**
 * Execute hooks for a specific event type with multiple events
 */
async function executeHooksForType(registryState: RegistryState, dispatcherState: DispatcherState, eventType: string, events: LifecycleEvent[]): Promise<void> {
    const hooks = registryState.hooks.get(eventType) || [];

    if (hooks.length === 0 || events.length === 0) {
        return;
    }

    logger.trace(`Executing ${hooks.length} hooks for ${events.length} ${eventType} events`);

    // Pre-filter hooks by component targeting to avoid repeated checks
    const preFilteredHooks = preFilterHooksByComponentTargeting(hooks, events);

    if (preFilteredHooks.length === 0) {
        return;
    }

    // Separate sync and async hooks
    const syncHooks = preFilteredHooks.filter(hook => !hook.options.async);
    const asyncHooks = preFilteredHooks.filter(hook => hook.options.async);

    // Execute sync hooks for all events with batch optimization
    if (syncHooks.length > 0) {
        await executeSyncHooksBatch(dispatcherState, syncHooks, events, eventType);
    }

    // Execute async hooks in parallel for all events with batch optimization
    if (asyncHooks.length > 0) {
        await executeAsyncHooksBatch(dispatcherState, asyncHooks, events, eventType);
    }
}

/**
 * Pre-filter hooks based on component targeting to optimize batch processing
 */
function preFilterHooksByComponentTargeting(hooks: RegisteredHook[], events: LifecycleEvent[]): RegisteredHook[] {
    // If no hooks have component targeting, return all hooks (preserving order)
    const hasComponentTargeting = hooks.some(hook => hook.options.componentTarget);
    if (!hasComponentTargeting) {
        return [...hooks]; // Return a copy to avoid modifying the original
    }

    // For hooks with component targeting, check if they could match any event
    // This is a broad pre-filter to avoid checking every hook against every event
    const filteredHooks = hooks.filter(hook => {
        if (!hook.options.componentTarget) {
            return true; // No targeting means it matches all
        }

        // Check if this hook could potentially match any of the events
        return events.some(event => matchesComponentTarget(event, hook.options.componentTarget));
    });

    // Return filtered hooks in their original order (priority should already be sorted)
    return filteredHooks;
}

/**
 * Execute sync hooks for multiple events with batch optimizations
 */
async function executeSyncHooksBatch(dispatcherState: DispatcherState, syncHooks: RegisteredHook[], events: LifecycleEvent[], eventType: string): Promise<void> {
    const startTime = performance.now();
    let hadErrors = false;

    // Execute hooks in priority order across all events to maintain deterministic execution
    for (const hook of syncHooks) {
        // Process all events for this hook
        for (const event of events) {
            // Double-check component targeting (pre-filter may have false positives)
            if (!matchesComponentTarget(event, hook.options.componentTarget)) {
                continue;
            }

            // Check filter condition
            if (hook.options.filter && !hook.options.filter(event)) {
                continue;
            }

            try {
                if (hook.options.timeout && hook.options.timeout > 0) {
                    // Same cleanup pattern as single-event path (H-HOOK-2 / H-MEM-2).
                    let timerHandle: ReturnType<typeof setTimeout> | null = null;
                    const hookPromise = Promise.resolve().then(() => hook.callback(event));
                    hookPromise.catch((err) => {
                        logger.warn({ hookId: hook.id, err }, `Late rejection from hook after timeout`);
                    });
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timerHandle = setTimeout(
                            () => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)),
                            hook.options.timeout
                        );
                        (timerHandle as unknown as { unref?: () => void }).unref?.();
                    });
                    try {
                        await Promise.race([hookPromise, timeoutPromise]);
                    } finally {
                        if (timerHandle) clearTimeout(timerHandle);
                    }
                } else {
                    // Await so async callbacks do not escape as unhandled
                    // rejections (C13 parity).
                    await hook.callback(event);
                }
            } catch (error) {
                logger.error(`Error executing sync hook ${hook.id} for event ${eventType}: ${error}`);
                hadErrors = true;
            }
        }
    }

    // Record performance metrics
    const executionTime = performance.now() - startTime;
    recordMetrics(dispatcherState, eventType, executionTime, hadErrors);
}

/**
 * Execute async hooks for multiple events with batch optimizations
 */
async function executeAsyncHooksBatch(dispatcherState: DispatcherState, asyncHooks: RegisteredHook[], events: LifecycleEvent[], eventType: string): Promise<void> {
    const startTime = performance.now();
    let hadErrors = false;

    // Collect all async hook executions
    const asyncPromises: Promise<void>[] = [];

    // Use a more efficient batching strategy for async hooks
    for (const event of events) {
        for (const hook of asyncHooks) {
            // Double-check component targeting
            if (!matchesComponentTarget(event, hook.options.componentTarget)) {
                continue;
            }

            // Check filter condition
            if (hook.options.filter && !hook.options.filter(event)) {
                continue;
            }

            asyncPromises.push(
                (async () => {
                    try {
                        if (hook.options.timeout && hook.options.timeout > 0) {
                            // Same cleanup pattern (H-HOOK-2 / H-MEM-2).
                            let timerHandle: ReturnType<typeof setTimeout> | null = null;
                            const hookPromise = Promise.resolve().then(() => hook.callback(event));
                            hookPromise.catch((err) => {
                                logger.warn({ hookId: hook.id, err }, `Late rejection from hook after timeout`);
                            });
                            const timeoutPromise = new Promise<never>((_, reject) => {
                                timerHandle = setTimeout(
                                    () => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)),
                                    hook.options.timeout
                                );
                                (timerHandle as unknown as { unref?: () => void }).unref?.();
                            });
                            try {
                                await Promise.race([hookPromise, timeoutPromise]);
                            } finally {
                                if (timerHandle) clearTimeout(timerHandle);
                            }
                        } else {
                            // Execute normally
                            await hook.callback(event);
                        }
                    } catch (error) {
                        logger.error(`Error executing async hook ${hook.id} for event ${eventType}: ${error}`);
                        hadErrors = true;
                    }
                })()
            );
        }
    }

    // Execute all async hooks in parallel with controlled concurrency
    if (asyncPromises.length > 0) {
        await Promise.allSettled(asyncPromises);
    }

    // Record performance metrics
    const executionTime = performance.now() - startTime;
    recordMetrics(dispatcherState, eventType, executionTime, hadErrors);
}
