import type { Entity } from "./Entity";
import type { BaseComponent } from "@/core/components/Decorators";
import ArcheType from "./ArcheType";
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
 * Component targeting configuration for hooks
 */
export interface ComponentTargetConfig {
    /** Component types that must be present on the entity for the hook to execute */
    includeComponents?: (new () => BaseComponent)[];
    /** Component types that must NOT be present on the entity for the hook to execute */
    excludeComponents?: (new () => BaseComponent)[];
    /** Whether to require ALL included components (AND) or ANY included component (OR) */
    requireAllIncluded?: boolean;
    /** Whether to require ALL excluded components to be absent (AND) or ANY excluded component to be absent (OR) */
    requireAllExcluded?: boolean;
    /** Archetype to match - entity must have exactly these component types */
    archetype?: ArcheType;
    /** Archetypes to match - entity must match ANY of these archetypes */
    archetypes?: ArcheType[];
}

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
    /** Component targeting configuration for fine-grained hook execution */
    componentTarget?: ComponentTargetConfig;
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
            // Check component targeting first
            if (!this.matchesComponentTarget(event, hook.options.componentTarget)) {
                continue;
            }

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
                // Check component targeting first
                if (!this.matchesComponentTarget(event, hook.options.componentTarget)) {
                    return;
                }

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

        // Pre-filter hooks by component targeting to avoid repeated checks
        const preFilteredHooks = this.preFilterHooksByComponentTargeting(hooks, events);

        if (preFilteredHooks.length === 0) {
            return;
        }

        // Separate sync and async hooks
        const syncHooks = preFilteredHooks.filter(hook => !hook.options.async);
        const asyncHooks = preFilteredHooks.filter(hook => hook.options.async);

        // Execute sync hooks for all events with batch optimization
        if (syncHooks.length > 0) {
            await this.executeSyncHooksBatch(syncHooks, events, eventType);
        }

        // Execute async hooks in parallel for all events with batch optimization
        if (asyncHooks.length > 0) {
            await this.executeAsyncHooksBatch(asyncHooks, events, eventType);
        }
    }

    /**
     * Pre-filter hooks based on component targeting to optimize batch processing
     * @param hooks Array of hooks to filter
     * @param events Array of events to check against
     * @returns Array of hooks that could potentially match any of the events
     */
    private preFilterHooksByComponentTargeting(hooks: RegisteredHook[], events: LifecycleEvent[]): RegisteredHook[] {
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
            return events.some(event => this.matchesComponentTarget(event, hook.options.componentTarget));
        });

        // Return filtered hooks in their original order (priority should already be sorted)
        return filteredHooks;
    }

    /**
     * Execute sync hooks for multiple events with batch optimizations
     * @param syncHooks Array of synchronous hooks
     * @param events Array of events
     * @param eventType The event type
     */
    private async executeSyncHooksBatch(syncHooks: RegisteredHook[], events: LifecycleEvent[], eventType: string): Promise<void> {
        const startTime = performance.now();
        let hadErrors = false;

        // Execute hooks in priority order across all events to maintain deterministic execution
        for (const hook of syncHooks) {
            // Process all events for this hook
            for (const event of events) {
                // Double-check component targeting (pre-filter may have false positives)
                if (!this.matchesComponentTarget(event, hook.options.componentTarget)) {
                    continue;
                }

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
                }
            }
        }

        // Record performance metrics
        const executionTime = performance.now() - startTime;
        this.recordMetrics(eventType, executionTime, hadErrors);
    }

    /**
     * Execute async hooks for multiple events with batch optimizations
     * @param asyncHooks Array of asynchronous hooks
     * @param events Array of events
     * @param eventType The event type
     */
    private async executeAsyncHooksBatch(asyncHooks: RegisteredHook[], events: LifecycleEvent[], eventType: string): Promise<void> {
        const startTime = performance.now();
        let hadErrors = false;

        // Collect all async hook executions
        const asyncPromises: Promise<void>[] = [];

        // Use a more efficient batching strategy for async hooks
        for (const event of events) {
            for (const hook of asyncHooks) {
                // Double-check component targeting
                if (!this.matchesComponentTarget(event, hook.options.componentTarget)) {
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
        this.recordMetrics(eventType, executionTime, hadErrors);
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
     * Check if an event matches the component targeting configuration
     * @param event The lifecycle event
     * @param componentTarget The component targeting configuration
     * @returns True if the event matches the targeting criteria
     */
    private matchesComponentTarget(event: LifecycleEvent, componentTarget?: ComponentTargetConfig): boolean {
        // If no component targeting is specified, always match
        if (!componentTarget) {
            return true;
        }

        const entity = event.getEntity();
        const entityComponents = entity.componentList();

        // Check archetype matching first (most specific)
        if (componentTarget.archetype) {
            if (!this.matchesArchetype(entityComponents, componentTarget.archetype, !!(componentTarget.includeComponents?.length || componentTarget.excludeComponents?.length))) {
                return false;
            }
        }

        // Check multiple archetypes (OR logic)
        if (componentTarget.archetypes && componentTarget.archetypes.length > 0) {
            const allowExtra = !!(componentTarget.includeComponents?.length || componentTarget.excludeComponents?.length);
            const matchesAnyArchetype = componentTarget.archetypes.some(archetype =>
                this.matchesArchetype(entityComponents, archetype, allowExtra)
            );
            if (!matchesAnyArchetype) {
                return false;
            }
        }

        // Check included components
        if (componentTarget.includeComponents && componentTarget.includeComponents.length > 0) {
            const includeMatch = this.checkComponentPresence(
                entityComponents,
                componentTarget.includeComponents,
                componentTarget.requireAllIncluded ?? true
            );

            if (!includeMatch) {
                return false;
            }
        }

        // Check excluded components
        if (componentTarget.excludeComponents && componentTarget.excludeComponents.length > 0) {
            const excludeMatch = this.checkComponentAbsence(
                entityComponents,
                componentTarget.excludeComponents,
                componentTarget.requireAllExcluded ?? true
            );

            if (!excludeMatch) {
                return false;
            }
        }

        return true;
    }

    /**
     * Check if required components are present on the entity
     * @param entityComponents Array of component instances on the entity
     * @param requiredComponents Array of component constructors to check for
     * @param requireAll Whether to require ALL components (AND) or ANY component (OR)
     * @returns True if the presence check passes
     */
    private checkComponentPresence(
        entityComponents: BaseComponent[],
        requiredComponents: (new () => BaseComponent)[],
        requireAll: boolean
    ): boolean {
        const entityComponentTypes = new Set(
            entityComponents.map(comp => comp.getTypeID())
        );

        const requiredTypeIds = requiredComponents.map(compCtor => {
            const instance = new compCtor();
            return instance.getTypeID();
        });

        if (requireAll) {
            // ALL required components must be present (AND logic)
            return requiredTypeIds.every(typeId => entityComponentTypes.has(typeId));
        } else {
            // ANY required component must be present (OR logic)
            return requiredTypeIds.some(typeId => entityComponentTypes.has(typeId));
        }
    }

    /**
     * Check if excluded components are absent from the entity
     * @param entityComponents Array of component instances on the entity
     * @param excludedComponents Array of component constructors to check for absence
     * @param requireAll Whether to require ALL components to be absent (AND) or ANY component to be absent (OR)
     * @returns True if the absence check passes
     */
    private checkComponentAbsence(
        entityComponents: BaseComponent[],
        excludedComponents: (new () => BaseComponent)[],
        requireAll: boolean
    ): boolean {
        const entityComponentTypes = new Set(
            entityComponents.map(comp => comp.getTypeID())
        );

        const excludedTypeIds = excludedComponents.map(compCtor => {
            const instance = new compCtor();
            return instance.getTypeID();
        });

        if (requireAll) {
            // ALL excluded components must be absent (AND logic)
            return excludedTypeIds.every(typeId => !entityComponentTypes.has(typeId));
        } else {
            // ANY excluded component must be absent (OR logic) - this is less common but supported
            return excludedTypeIds.some(typeId => !entityComponentTypes.has(typeId));
        }
    }

    /**
     * Check if entity components match a specific archetype
     * @param entityComponents Array of component instances on the entity
     * @param archetype The archetype to match against
     * @param allowExtraComponents Whether to allow additional components beyond the archetype
     * @returns True if the entity matches the archetype
     */
    private matchesArchetype(entityComponents: BaseComponent[], archetype: ArcheType, allowExtraComponents: boolean = false): boolean {
        // Get the expected component types from the archetype
        // We need to access the private componentMap from ArcheType
        const archetypeComponentMap = (archetype as any).componentMap as Record<string, typeof BaseComponent>;

        if (!archetypeComponentMap) {
            return false;
        }

        const expectedComponentTypes = new Set(
            Object.values(archetypeComponentMap).map(compCtor => {
                const instance = new compCtor();
                return instance.getTypeID();
            })
        );

        const entityComponentTypes = new Set(
            entityComponents.map(comp => comp.getTypeID())
        );

        if (allowExtraComponents) {
            // Entity must have at least all the component types from the archetype
            // (allows additional components beyond the archetype)
            for (const expectedType of expectedComponentTypes) {
                if (!entityComponentTypes.has(expectedType)) {
                    return false;
                }
            }
            return true;
        } else {
            // Entity must have exactly the same component types as the archetype
            if (expectedComponentTypes.size !== entityComponentTypes.size) {
                return false;
            }

            // All expected component types must be present in the entity
            for (const expectedType of expectedComponentTypes) {
                if (!entityComponentTypes.has(expectedType)) {
                    return false;
                }
            }
            return true;
        }
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