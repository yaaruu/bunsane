import EntityHookManager from "../EntityHookManager";
import type { EntityEvent, ComponentEvent } from "../events/EntityLifecycleEvents";
import type { HookOptions, ComponentTargetConfig } from "../EntityHookManager";

/**
 * Decorator for registering entity lifecycle hooks
 * @param eventType The entity event type to hook into
 * @param options Hook registration options
 */
export function EntityHook(eventType: EntityEvent['eventType'], options: HookOptions = {}) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        // Store hook info for later registration
        if (!target.constructor.__entityHooks) {
            target.constructor.__entityHooks = [];
        }

        target.constructor.__entityHooks.push({
            eventType,
            methodName: propertyKey,
            options
        });

        // Replace method to ensure it can be called normally
        descriptor.value = function (...args: any[]) {
            return originalMethod.apply(this, args);
        };
    };
}

/**
 * Decorator for registering component lifecycle hooks
 * @param eventType The component event type to hook into
 * @param options Hook registration options
 */
export function ComponentHook(eventType: ComponentEvent['eventType'], options: HookOptions = {}) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        // Store hook info for later registration
        if (!target.constructor.__componentHooks) {
            target.constructor.__componentHooks = [];
        }

        target.constructor.__componentHooks.push({
            eventType,
            methodName: propertyKey,
            options
        });

        // Replace method to ensure it can be called normally
        descriptor.value = function (...args: any[]) {
            return originalMethod.apply(this, args);
        };
    };
}

/**
 * Decorator for registering hooks for all lifecycle events
 * @param options Hook registration options
 */
export function LifecycleHook(options: HookOptions = {}) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        // Store hook info for later registration
        if (!target.constructor.__lifecycleHooks) {
            target.constructor.__lifecycleHooks = [];
        }

        target.constructor.__lifecycleHooks.push({
            methodName: propertyKey,
            options
        });

        // Replace method to ensure it can be called normally
        descriptor.value = function (...args: any[]) {
            return originalMethod.apply(this, args);
        };
    };
}

/**
 * Decorator for registering component-targeted entity lifecycle hooks
 * @param eventType The entity event type to hook into
 * @param componentTarget Component targeting configuration
 * @param options Additional hook registration options
 */
export function ComponentTargetHook(
    eventType: EntityEvent['eventType'],
    componentTarget: ComponentTargetConfig,
    options: Omit<HookOptions, 'componentTarget'> = {}
) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        // Store hook info for later registration
        if (!target.constructor.__componentTargetHooks) {
            target.constructor.__componentTargetHooks = [];
        }

        target.constructor.__componentTargetHooks.push({
            eventType,
            methodName: propertyKey,
            componentTarget,
            options
        });

        // Replace method to ensure it can be called normally
        descriptor.value = function (...args: any[]) {
            return originalMethod.apply(this, args);
        };
    };
}

/** Per-instance registry of hook IDs created by registerDecoratedHooks.
 *  Used by unregisterDecoratedHooks to undo registration (H-HOOK-3). */
const REGISTERED_IDS = new WeakMap<object, string[]>();

/**
 * Register all decorated hooks for a service class
 * Call this method after instantiating a service to register its decorated hooks
 * @param serviceInstance The service instance to register hooks for
 */
export function registerDecoratedHooks(serviceInstance: any): void {
    const constructor = serviceInstance.constructor;
    const ids: string[] = REGISTERED_IDS.get(serviceInstance) ?? [];

    // Register entity hooks
    if (constructor.__entityHooks) {
        for (const hookInfo of constructor.__entityHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            ids.push(EntityHookManager.registerEntityHook(
                hookInfo.eventType,
                hookMethod,
                hookInfo.options
            ));
        }
    }

    // Register component hooks
    if (constructor.__componentHooks) {
        for (const hookInfo of constructor.__componentHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            ids.push(EntityHookManager.registerComponentHook(
                hookInfo.eventType,
                hookMethod,
                hookInfo.options
            ));
        }
    }

    // Register component target hooks
    if (constructor.__componentTargetHooks) {
        for (const hookInfo of constructor.__componentTargetHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            ids.push(EntityHookManager.registerEntityHook(
                hookInfo.eventType,
                hookMethod,
                {
                    ...hookInfo.options,
                    componentTarget: hookInfo.componentTarget
                }
            ));
        }
    }

    // Register lifecycle hooks
    if (constructor.__lifecycleHooks) {
        for (const hookInfo of constructor.__lifecycleHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            ids.push(EntityHookManager.registerLifecycleHook(
                hookMethod,
                hookInfo.options
            ));
        }
    }

    REGISTERED_IDS.set(serviceInstance, ids);
}

/**
 * Unregister all decorated hooks for a service instance.
 * Call during teardown (service destruction, test isolation) to prevent
 * hook leaks across repeated instantiations (H-HOOK-3).
 */
export function unregisterDecoratedHooks(serviceInstance: any): void {
    const ids = REGISTERED_IDS.get(serviceInstance);
    if (!ids) return;
    for (const id of ids) {
        EntityHookManager.removeHook(id);
    }
    REGISTERED_IDS.delete(serviceInstance);
}