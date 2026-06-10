import type { EntityEvent, ComponentEvent, LifecycleEvent } from "./events/EntityLifecycleEvents";
import { logger as MainLogger } from "./Logger";
import ApplicationLifecycle, { ApplicationPhase, type PhaseChangeEvent } from "./ApplicationLifecycle";
import {
    type EntityHookCallback,
    type ComponentHookCallback,
    type LifecycleHookCallback,
    type ComponentTargetConfig,
    type HookOptions,
    type HookMetrics,
    type RegistryState,
    createRegistryState,
    registerEntityHook,
    registerComponentHook,
    registerLifecycleHook,
    removeHook,
    getHookCount,
    clearAllHooks
} from "./hooks/registry";
import {
    type DispatcherState,
    createDispatcherState,
    executeHooks,
    executeHooksBatch,
    getMetrics,
    resetMetrics
} from "./hooks/dispatcher";

// Re-export types consumed by external modules
export type {
    EntityHookCallback,
    ComponentHookCallback,
    LifecycleHookCallback,
    ComponentTargetConfig,
    HookOptions,
    HookMetrics
};

const logger = MainLogger.child({ scope: "EntityHookManager" });

/**
 * EntityHookManager - Singleton for managing entity lifecycle hooks
 * Provides registration and execution of hooks for entity and component lifecycle events
 */
class EntityHookManager {
    private static _instance: EntityHookManager;
    private registryState: RegistryState = createRegistryState();
    private dispatcherState: DispatcherState = createDispatcherState();
    private phaseListener: ((event: PhaseChangeEvent) => void) | null = null;

    private constructor() {
        logger.trace("EntityHookManager initialized");
        this.initializeLifecycleIntegration();
    }

    /**
     * Initialize integration with ApplicationLifecycle
     */
    private initializeLifecycleIntegration(): void {
        // Wait for components to be ready before allowing hook registration
        this.phaseListener = (event: PhaseChangeEvent) => {
            const phase = event.detail;
            switch (phase) {
                case ApplicationPhase.COMPONENTS_READY:
                    logger.info("EntityHookManager ready for hook registration");
                    break;
                case ApplicationPhase.APPLICATION_READY:
                    logger.info("EntityHookManager fully operational");
                    break;
            }
        };
        ApplicationLifecycle.addPhaseListener(this.phaseListener);
    }

    public dispose(): void {
        if (this.phaseListener) {
            ApplicationLifecycle.removePhaseListener(this.phaseListener);
            this.phaseListener = null;
        }
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
        const hookId = registerEntityHook(this.registryState, eventType, callback, options);
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
        const hookId = registerComponentHook(this.registryState, eventType, callback, options);
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
        const hookId = registerLifecycleHook(this.registryState, callback, options);
        logger.trace(`Registered lifecycle hook ${hookId} for all event types`);
        return hookId;
    }

    /**
     * Remove a hook by its ID
     * @param hookId The hook ID to remove
     * @returns True if hook was removed, false if not found
     */
    public removeHook(hookId: string): boolean {
        const removed = removeHook(this.registryState, hookId);
        if (removed) {
            logger.trace(`Removed hook ${hookId}`);
        }
        return removed;
    }

    /**
     * Execute hooks for a specific event
     * @param event The lifecycle event to process
     */
    public async executeHooks(event: LifecycleEvent): Promise<void> {
        return executeHooks(this.registryState, this.dispatcherState, event);
    }

    /**
     * Execute hooks for multiple events in batch
     * @param events Array of lifecycle events to process
     */
    public async executeHooksBatch(events: LifecycleEvent[]): Promise<void> {
        return executeHooksBatch(this.registryState, this.dispatcherState, events);
    }

    /**
     * Get the number of registered hooks for an event type
     * @param eventType The event type to check
     * @returns Number of registered hooks
     */
    public getHookCount(eventType?: string): number {
        return getHookCount(this.registryState, eventType);
    }

    /**
     * Get performance metrics for hook execution
     * @param eventType Optional event type to get specific metrics
     * @returns Hook execution metrics
     */
    public getMetrics(eventType?: string): HookMetrics {
        return getMetrics(this.dispatcherState, eventType);
    }

    /**
     * Reset performance metrics
     * @param eventType Optional event type to reset specific metrics
     */
    public resetMetrics(eventType?: string): void {
        resetMetrics(this.dispatcherState, eventType);
    }

    /**
     * Clear all hooks (useful for testing)
     */
    public clearAllHooks(): void {
        clearAllHooks(this.registryState);
        logger.trace("Cleared all hooks");
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
