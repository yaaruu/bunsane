import type { Entity } from "./Entity";
import type { BaseComponent } from "./Components";
import {
    EntityLifecycleEvent,
    EntityCreatedEvent,
    EntityUpdatedEvent,
    EntityDeletedEvent,
    ComponentLifecycleEvent,
    ComponentAddedEvent,
    ComponentUpdatedEvent,
    ComponentRemovedEvent,
    type EntityEvent,
    type ComponentEvent,
    type LifecycleEvent
} from "./events/EntityLifecycleEvents";
import { logger as MainLogger } from "./Logger";
import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";

const logger = MainLogger.child({ scope: "EntityHookManager" });

/**
 * Hook callback function signature for entity events
 */
export type EntityHookCallback<T extends EntityEvent = EntityEvent> = (event: T) => void;

/**
 * Hook callback function signature for component events
 */
export type ComponentHookCallback<T extends ComponentEvent = ComponentEvent> = (event: T) => void;

/**
 * Hook callback function signature for any lifecycle event
 */
export type LifecycleHookCallback = (event: LifecycleEvent) => void;

/**
 * Hook registration options
 */
export interface HookOptions {
    /** Priority for hook execution order (higher numbers execute first) */
    priority?: number;
    /** Optional name for the hook for debugging */
    name?: string;
    /** Whether the hook should be executed asynchronously */
    async?: boolean;
    /** Filter function to conditionally execute the hook */
    filter?: (event: LifecycleEvent) => boolean;
    /** Maximum execution time in milliseconds (for timeout handling) */
    timeout?: number;
}

/**
 * Registered hook information
 */
interface RegisteredHook {
    callback: LifecycleHookCallback;
    options: HookOptions;
    id: string;
}

/**
 * Hook execution metrics
 */
interface HookMetrics {
    totalExecutions: number;
    totalExecutionTime: number;
    averageExecutionTime: number;
    errorCount: number;
    lastExecutionTime: number;
}

/**
 * EntityHookManager - Singleton for managing entity lifecycle hooks
 * Provides registration and execution of hooks for entity and component lifecycle events
 */
class EntityHookManager {
    private static _instance: EntityHookManager;
    private hooks: Map<string, RegisteredHook[]> = new Map();
    private hookCounter: number = 0;
    private metrics: Map<string, HookMetrics> = new Map();
    private globalMetrics: HookMetrics = {
        totalExecutions: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        errorCount: 0,
        lastExecutionTime: 0
    };

    private constructor() {
        logger.trace("EntityHookManager initialized");
        this.initializeLifecycleIntegration();
    }

    /**
     * Initialize integration with ApplicationLifecycle
     */
    private initializeLifecycleIntegration(): void {
        // Wait for components to be ready before allowing hook registration
        ApplicationLifecycle.addPhaseListener((event) => {
            const phase = event.detail;
            switch (phase) {
                case ApplicationPhase.COMPONENTS_READY:
                    logger.info("EntityHookManager ready for hook registration");
                    break;
                case ApplicationPhase.APPLICATION_READY:
                    logger.info("EntityHookManager fully operational");
                    break;
            }
        });
    }

    /**
     * Wait for the hook system to be ready for registration
     */
    public async waitForReady(): Promise<void> {
        await ApplicationLifecycle.waitForPhase(ApplicationPhase.COMPONENTS_READY);
    }

    /**
     * Check if the hook system is ready for registration
     */
    public isReady(): boolean {
        return ApplicationLifecycle.getCurrentPhase() >= ApplicationPhase.COMPONENTS_READY;
    }

    /**
     * Register a hook for entity lifecycle events
     * @param eventType The event type to hook into
     * @param callback The callback function to execute
     * @param options Hook registration options
     * @returns Hook ID for later removal
     */
    public registerEntityHook<T extends EntityEvent>(
        eventType: T['eventType'],
        callback: EntityHookCallback<T>,
        options: HookOptions = {}
    ): string {
        const hookId = this.generateHookId();
        const hook: RegisteredHook = {
            callback: callback as LifecycleHookCallback,
            options: { priority: 0, ...options },
            id: hookId
        };

        if (!this.hooks.has(eventType)) {
            this.hooks.set(eventType, []);
        }

        this.hooks.get(eventType)!.push(hook);
        this.sortHooksByPriority(eventType);

        logger.trace(`Registered entity hook ${hookId} for event type: ${eventType}`);
        return hookId;
    }

    /**
     * Register a hook for component lifecycle events
     * @param eventType The event type to hook into
     * @param callback The callback function to execute
     * @param options Hook registration options
     * @returns Hook ID for later removal
     */
    public registerComponentHook<T extends ComponentEvent>(
        eventType: T['eventType'],
        callback: ComponentHookCallback<T>,
        options: HookOptions = {}
    ): string {
        const hookId = this.generateHookId();
        const hook: RegisteredHook = {
            callback: callback as LifecycleHookCallback,
            options: { priority: 0, ...options },
            id: hookId
        };

        if (!this.hooks.has(eventType)) {
            this.hooks.set(eventType, []);
        }

        this.hooks.get(eventType)!.push(hook);
        this.sortHooksByPriority(eventType);

        logger.trace(`Registered component hook ${hookId} for event type: ${eventType}`);
        return hookId;
    }

    /**
     * Register a hook for all lifecycle events
     * @param callback The callback function to execute
     * @param options Hook registration options
     * @returns Hook ID for later removal
     */
    public registerLifecycleHook(
        callback: LifecycleHookCallback,
        options: HookOptions = {}
    ): string {
        const hookId = this.generateHookId();
        const hook: RegisteredHook = {
            callback,
            options: { priority: 0, ...options },
            id: hookId
        };

        // Register for all event types
        const allEventTypes = [
            "entity.created", "entity.updated", "entity.deleted",
            "component.added", "component.updated", "component.removed"
        ];

        for (const eventType of allEventTypes) {
            if (!this.hooks.has(eventType)) {
                this.hooks.set(eventType, []);
            }
            this.hooks.get(eventType)!.push({ ...hook }); // Clone hook for each event type
        }

        logger.trace(`Registered lifecycle hook ${hookId} for all event types`);
        return hookId;
    }

    /**
     * Remove a hook by its ID
     * @param hookId The hook ID to remove
     * @returns True if hook was removed, false if not found
     */
    public removeHook(hookId: string): boolean {
        let removed = false;

        for (const [eventType, hooks] of this.hooks.entries()) {
            const initialLength = hooks.length;
            this.hooks.set(eventType, hooks.filter(hook => hook.id !== hookId));

            if (this.hooks.get(eventType)!.length < initialLength) {
                removed = true;
                logger.trace(`Removed hook ${hookId} from event type: ${eventType}`);
            }
        }

        return removed;
    }

    /**
     * Execute hooks for a specific event
     * @param event The lifecycle event to process
     */
    public async executeHooks(event: LifecycleEvent): Promise<void> {
        const eventType = event.getEventType();
        const hooks = this.hooks.get(eventType) || [];
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
            // Check filter condition
            if (hook.options.filter && !hook.options.filter(event)) {
                continue;
            }

            try {
                if (hook.options.timeout && hook.options.timeout > 0) {
                    // Execute with timeout
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)), hook.options.timeout);
                    });
                    await Promise.race([hook.callback(event), timeoutPromise]);
                } else {
                    // Execute normally
                    hook.callback(event);
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
                // Check filter condition
                if (hook.options.filter && !hook.options.filter(event)) {
                    return;
                }

                try {
                    if (hook.options.timeout && hook.options.timeout > 0) {
                        // Execute with timeout
                        const hookPromise = hook.callback(event);
                        const timeoutPromise = new Promise<never>((_, reject) => {
                            setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)), hook.options.timeout);
                        });
                        await Promise.race([hookPromise, timeoutPromise]);
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
        this.recordMetrics(eventType, executionTime, hadErrors);
    }    /**
     * Execute hooks for multiple events in batch
     * @param events Array of lifecycle events to process
     */
    public async executeHooksBatch(events: LifecycleEvent[]): Promise<void> {
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
            promises.push(this.executeHooksForType(eventType, typeEvents));
        }

        await Promise.allSettled(promises);
    }

    /**
     * Execute hooks for a specific event type with multiple events
     * @param eventType The event type
     * @param events Array of events of the same type
     */
    private async executeHooksForType(eventType: string, events: LifecycleEvent[]): Promise<void> {
        const hooks = this.hooks.get(eventType) || [];

        if (hooks.length === 0 || events.length === 0) {
            return;
        }

        logger.trace(`Executing ${hooks.length} hooks for ${events.length} ${eventType} events`);

        // Separate sync and async hooks
        const syncHooks = hooks.filter(hook => !hook.options.async);
        const asyncHooks = hooks.filter(hook => hook.options.async);

        // Execute sync hooks for all events
        for (const event of events) {
            for (const hook of syncHooks) {
                // Check filter condition
                if (hook.options.filter && !hook.options.filter(event)) {
                    continue;
                }

                try {
                    if (hook.options.timeout && hook.options.timeout > 0) {
                        // Execute with timeout
                        const timeoutPromise = new Promise<never>((_, reject) => {
                            setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)), hook.options.timeout);
                        });
                        await Promise.race([hook.callback(event), timeoutPromise]);
                    } else {
                        // Execute normally
                        hook.callback(event);
                    }
                } catch (error) {
                    logger.error(`Error executing sync hook ${hook.id} for event ${eventType}: ${error}`);
                }
            }
        }

        // Execute async hooks in parallel for all events
        if (asyncHooks.length > 0) {
            const asyncPromises: Promise<void>[] = [];
            for (const event of events) {
                for (const hook of asyncHooks) {
                    // Check filter condition
                    if (hook.options.filter && !hook.options.filter(event)) {
                        continue;
                    }

                    asyncPromises.push(
                        (async () => {
                            try {
                                if (hook.options.timeout && hook.options.timeout > 0) {
                                    // Execute with timeout
                                    const hookPromise = hook.callback(event);
                                    const timeoutPromise = new Promise<never>((_, reject) => {
                                        setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${hook.options.timeout}ms`)), hook.options.timeout);
                                    });
                                    await Promise.race([hookPromise, timeoutPromise]);
                                } else {
                                    // Execute normally
                                    await hook.callback(event);
                                }
                            } catch (error) {
                                logger.error(`Error executing async hook ${hook.id} for event ${eventType}: ${error}`);
                            }
                        })()
                    );
                }
            }
            await Promise.allSettled(asyncPromises);
        }
    }

    /**
     * Get the number of registered hooks for an event type
     * @param eventType The event type to check
     * @returns Number of registered hooks
     */
    public getHookCount(eventType?: string): number {
        if (eventType) {
            return this.hooks.get(eventType)?.length || 0;
        }

        let total = 0;
        for (const hooks of this.hooks.values()) {
            total += hooks.length;
        }
        return total;
    }

    /**
     * Get performance metrics for hook execution
     * @param eventType Optional event type to get specific metrics
     * @returns Hook execution metrics
     */
    public getMetrics(eventType?: string): HookMetrics {
        if (eventType) {
            return this.metrics.get(eventType) || {
                totalExecutions: 0,
                totalExecutionTime: 0,
                averageExecutionTime: 0,
                errorCount: 0,
                lastExecutionTime: 0
            };
        }
        return { ...this.globalMetrics };
    }

    /**
     * Reset performance metrics
     * @param eventType Optional event type to reset specific metrics
     */
    public resetMetrics(eventType?: string): void {
        if (eventType) {
            this.metrics.delete(eventType);
        } else {
            this.metrics.clear();
            this.globalMetrics = {
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
     * Clear all hooks (useful for testing)
     */
    public clearAllHooks(): void {
        this.hooks.clear();
        this.hookCounter = 0;
        logger.trace("Cleared all hooks");
    }

    /**
     * Record hook execution metrics
     * @param eventType The event type
     * @param executionTime Time taken to execute hooks
     * @param hadErrors Whether any hooks had errors
     */
    private recordMetrics(eventType: string, executionTime: number, hadErrors: boolean): void {
        // Update event-specific metrics
        let eventMetrics = this.metrics.get(eventType);
        if (!eventMetrics) {
            eventMetrics = {
                totalExecutions: 0,
                totalExecutionTime: 0,
                averageExecutionTime: 0,
                errorCount: 0,
                lastExecutionTime: 0
            };
            this.metrics.set(eventType, eventMetrics);
        }

        eventMetrics.totalExecutions++;
        eventMetrics.totalExecutionTime += executionTime;
        eventMetrics.averageExecutionTime = eventMetrics.totalExecutionTime / eventMetrics.totalExecutions;
        eventMetrics.lastExecutionTime = executionTime;
        if (hadErrors) {
            eventMetrics.errorCount++;
        }

        // Update global metrics
        this.globalMetrics.totalExecutions++;
        this.globalMetrics.totalExecutionTime += executionTime;
        this.globalMetrics.averageExecutionTime = this.globalMetrics.totalExecutionTime / this.globalMetrics.totalExecutions;
        this.globalMetrics.lastExecutionTime = executionTime;
        if (hadErrors) {
            this.globalMetrics.errorCount++;
        }
    }

    /**
     * Generate a unique hook ID
     */
    private generateHookId(): string {
        return `hook_${++this.hookCounter}_${Date.now()}`;
    }

    /**
     * Sort hooks by priority (higher priority first)
     */
    private sortHooksByPriority(eventType: string): void {
        const hooks = this.hooks.get(eventType);
        if (hooks) {
            hooks.sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));
        }
    }

    /**
     * Get the singleton instance of EntityHookManager
     */
    public static get instance(): EntityHookManager {
        if (!EntityHookManager._instance) {
            EntityHookManager._instance = new EntityHookManager();
        }
        return EntityHookManager._instance;
    }
}

// Export singleton instance
export default EntityHookManager.instance;