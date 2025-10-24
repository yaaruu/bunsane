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

/**
 * Register all decorated hooks for a service class
 * Call this method after instantiating a service to register its decorated hooks
 * @param serviceInstance The service instance to register hooks for
 */
export function registerDecoratedHooks(serviceInstance: any): void {
    const constructor = serviceInstance.constructor;

    // Register entity hooks
    if (constructor.__entityHooks) {
        for (const hookInfo of constructor.__entityHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            EntityHookManager.registerEntityHook(
                hookInfo.eventType,
                hookMethod,
                hookInfo.options
            );
        }
    }

    // Register component hooks
    if (constructor.__componentHooks) {
        for (const hookInfo of constructor.__componentHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            EntityHookManager.registerComponentHook(
                hookInfo.eventType,
                hookMethod,
                hookInfo.options
            );
        }
    }

    // Register component target hooks
    if (constructor.__componentTargetHooks) {
        for (const hookInfo of constructor.__componentTargetHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            EntityHookManager.registerEntityHook(
                hookInfo.eventType,
                hookMethod,
                {
                    ...hookInfo.options,
                    componentTarget: hookInfo.componentTarget
                }
            );
        }
    }

    // Register lifecycle hooks
    if (constructor.__lifecycleHooks) {
        for (const hookInfo of constructor.__lifecycleHooks) {
            const hookMethod = serviceInstance[hookInfo.methodName].bind(serviceInstance);

            EntityHookManager.registerLifecycleHook(
                hookMethod,
                hookInfo.options
            );
        }
    }
}

/**
 * Unregister all decorated hooks for a service class
 * Call this method before destroying a service to clean up its hooks
 * @param serviceInstance The service instance to unregister hooks for
 */
export function unregisterDecoratedHooks(serviceInstance: any): void {
    console.warn('unregisterDecoratedHooks is not fully implemented. Use EntityHookManager.removeHook() for individual hook removal.');
}