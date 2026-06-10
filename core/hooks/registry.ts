import type { BaseComponent } from "../components";
import type ArcheType from "../ArcheType";
import type { EntityEvent, ComponentEvent, LifecycleEvent } from "../events/EntityLifecycleEvents";
import { getMetadataStorage } from "../metadata";

// Memoized constructor → typeId. Hook matching runs on every save event for
// every hook filter; instantiating components (`new compCtor()`) per check
// was O(hooks × filters) constructor calls per event.
const typeIdCache = new Map<Function, string>();
export function typeIdOfCtor(compCtor: new () => BaseComponent): string {
    let id = typeIdCache.get(compCtor);
    if (id === undefined) {
        id = getMetadataStorage().getComponentId(compCtor.name);
        typeIdCache.set(compCtor, id);
    }
    return id;
}

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
export interface RegisteredHook {
    callback: LifecycleHookCallback;
    options: HookOptions;
    id: string;
}

/**
 * Hook execution metrics
 */
export interface HookMetrics {
    totalExecutions: number;
    totalExecutionTime: number;
    averageExecutionTime: number;
    errorCount: number;
    lastExecutionTime: number;
}

/**
 * Registry state owned by the manager instance
 */
export interface RegistryState {
    hooks: Map<string, RegisteredHook[]>;
    hookCounter: number;
}

/**
 * Create initial registry state
 */
export function createRegistryState(): RegistryState {
    return {
        hooks: new Map(),
        hookCounter: 0
    };
}

/**
 * Generate a unique hook ID
 */
export function generateHookId(state: RegistryState): string {
    return `hook_${++state.hookCounter}_${Date.now()}`;
}

/**
 * Sort hooks by priority (higher priority first)
 */
export function sortHooksByPriority(state: RegistryState, eventType: string): void {
    const hooks = state.hooks.get(eventType);
    if (hooks) {
        hooks.sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));
    }
}

/**
 * Register a hook for entity lifecycle events
 */
export function registerEntityHook<T extends EntityEvent>(
    state: RegistryState,
    eventType: T['eventType'],
    callback: EntityHookCallback<T>,
    options: HookOptions
): string {
    const hookId = generateHookId(state);
    const hook: RegisteredHook = {
        callback: callback as LifecycleHookCallback,
        options: { priority: 0, ...options },
        id: hookId
    };

    if (!state.hooks.has(eventType)) {
        state.hooks.set(eventType, []);
    }

    state.hooks.get(eventType)!.push(hook);
    sortHooksByPriority(state, eventType);

    return hookId;
}

/**
 * Register a hook for component lifecycle events
 */
export function registerComponentHook<T extends ComponentEvent>(
    state: RegistryState,
    eventType: T['eventType'],
    callback: ComponentHookCallback<T>,
    options: HookOptions
): string {
    const hookId = generateHookId(state);
    const hook: RegisteredHook = {
        callback: callback as LifecycleHookCallback,
        options: { priority: 0, ...options },
        id: hookId
    };

    if (!state.hooks.has(eventType)) {
        state.hooks.set(eventType, []);
    }

    state.hooks.get(eventType)!.push(hook);
    sortHooksByPriority(state, eventType);

    return hookId;
}

/**
 * Register a hook for all lifecycle events
 */
export function registerLifecycleHook(
    state: RegistryState,
    callback: LifecycleHookCallback,
    options: HookOptions
): string {
    const hookId = generateHookId(state);
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
        if (!state.hooks.has(eventType)) {
            state.hooks.set(eventType, []);
        }
        state.hooks.get(eventType)!.push({ ...hook }); // Clone hook for each event type
    }

    return hookId;
}

/**
 * Remove a hook by its ID
 */
export function removeHook(state: RegistryState, hookId: string): boolean {
    let removed = false;

    for (const [eventType, hooks] of state.hooks.entries()) {
        const initialLength = hooks.length;
        state.hooks.set(eventType, hooks.filter(hook => hook.id !== hookId));

        if (state.hooks.get(eventType)!.length < initialLength) {
            removed = true;
        }
    }

    return removed;
}

/**
 * Get the number of registered hooks for an event type
 */
export function getHookCount(state: RegistryState, eventType?: string): number {
    if (eventType) {
        return state.hooks.get(eventType)?.length || 0;
    }

    let total = 0;
    for (const hooks of state.hooks.values()) {
        total += hooks.length;
    }
    return total;
}

/**
 * Clear all hooks
 */
export function clearAllHooks(state: RegistryState): void {
    state.hooks.clear();
    state.hookCounter = 0;
}
