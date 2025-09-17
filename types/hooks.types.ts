/**
 * Type definitions for the Entity Lifecycle Hooks system
 */

import type { Entity } from "../core/Entity";
import type { BaseComponent } from "../core/Components";
import type {
    EntityEvent,
    ComponentEvent,
    LifecycleEvent,
    EntityCreatedEvent,
    EntityUpdatedEvent,
    EntityDeletedEvent,
    ComponentAddedEvent,
    ComponentUpdatedEvent,
    ComponentRemovedEvent
} from "../core/events/EntityLifecycleEvents";

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
}

/**
 * Hook execution context
 */
export interface HookContext {
    /** The entity associated with the event */
    entity: Entity;
    /** The event that triggered the hook */
    event: LifecycleEvent;
    /** Timestamp when the hook execution started */
    executionStart: Date;
}

/**
 * Hook execution result
 */
export interface HookResult {
    /** Whether the hook executed successfully */
    success: boolean;
    /** Execution time in milliseconds */
    executionTime: number;
    /** Error if execution failed */
    error?: Error;
}

/**
 * Batch hook execution result
 */
export interface BatchHookResult {
    /** Total number of hooks executed */
    totalHooks: number;
    /** Number of successful executions */
    successful: number;
    /** Number of failed executions */
    failed: number;
    /** Total execution time */
    totalExecutionTime: number;
    /** Individual hook results */
    results: HookResult[];
}

/**
 * Hook filter function for conditional execution
 */
export type HookFilter<T extends LifecycleEvent = LifecycleEvent> = (event: T) => boolean;

/**
 * Filtered hook registration options
 */
export interface FilteredHookOptions extends HookOptions {
    /** Filter function to determine if hook should execute */
    filter?: HookFilter;
}

/**
 * Hook metadata for introspection
 */
export interface HookMetadata {
    /** Unique hook identifier */
    id: string;
    /** Event type the hook is registered for */
    eventType: string;
    /** Hook name for debugging */
    name?: string;
    /** Hook priority */
    priority: number;
    /** Whether hook executes asynchronously */
    async: boolean;
    /** Registration timestamp */
    registeredAt: Date;
}

/**
 * Hook manager statistics
 */
export interface HookStats {
    /** Total number of registered hooks */
    totalHooks: number;
    /** Number of hooks by event type */
    hooksByEventType: Record<string, number>;
    /** Average execution time per event type */
    averageExecutionTime: Record<string, number>;
    /** Error rate per event type */
    errorRate: Record<string, number>;
}

/**
 * Hook execution options for advanced scenarios
 */
export interface HookExecutionOptions {
    /** Timeout for hook execution in milliseconds */
    timeout?: number;
    /** Whether to continue executing other hooks if one fails */
    continueOnError?: boolean;
    /** Maximum number of hooks to execute in parallel */
    maxConcurrency?: number;
}