import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { Entity } from "../core/Entity";
import hookManager from "../core/EntityHookManager";
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent, ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "../core/events/EntityLifecycleEvents";
import { BaseComponent, CompData, Component } from "../core/Components";
import App from "../core/App";
import { EntityHook, ComponentHook, LifecycleHook, registerDecoratedHooks } from "../core/decorators/EntityHooks";

let app: App;

beforeAll(async () => {
    app = new App();
    await app.waitForAppReady();
});

@Component
class TestComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

@Component
class AnotherTestComponent extends BaseComponent {
    @CompData()
    numberValue: number = 0;
}

describe('Entity Lifecycle Hooks - Phase 1', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should register and execute entity created hook', async () => {
        let hookExecuted = false;
        let capturedEvent: EntityCreatedEvent | null = null;

        const hookId = hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        expect(hookId).toBeDefined();
        expect(typeof hookId).toBe('string');

        // Create and save a new entity
        const entity = Entity.Create();
        await entity.save();

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(EntityCreatedEvent);
        expect((capturedEvent as unknown as EntityCreatedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as EntityCreatedEvent)?.isNew).toBe(true);
    });

    test('should register and execute entity updated hook', async () => {
        let hookExecuted = false;
        let capturedEvent: EntityUpdatedEvent | null = null;

        const hookId = hookManager.registerEntityHook("entity.updated", (event: EntityUpdatedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create and save a new entity first
        const entity = Entity.Create().add(TestComponent, { value: "initial" });
        await entity.save();

        // Reset for update test
        hookExecuted = false;
        capturedEvent = null;

        // Update the entity
        await entity.set(TestComponent, { value: "updated" });
        await entity.save();

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(EntityUpdatedEvent);
        expect((capturedEvent as unknown as EntityUpdatedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as EntityUpdatedEvent)?.isNew).toBe(false);
        expect((capturedEvent as unknown as EntityUpdatedEvent)?.getChangedComponents()).toHaveLength(1);
    });

    test('should register and execute entity deleted hook', async () => {
        let hookExecuted = false;
        let capturedEvent: EntityDeletedEvent | null = null;

        const hookId = hookManager.registerEntityHook("entity.deleted", (event: EntityDeletedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create and save a new entity first
        const entity = Entity.Create().add(TestComponent, { value: "test" });
        await entity.save();

        // Delete the entity
        await entity.delete();

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(EntityDeletedEvent);
        expect((capturedEvent as unknown as EntityDeletedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as EntityDeletedEvent)?.isSoftDelete).toBe(true);
    });

    test('should execute multiple hooks for the same event', async () => {
        let hook1Executed = false;
        let hook2Executed = false;

        hookManager.registerEntityHook("entity.created", () => {
            hook1Executed = true;
        });

        hookManager.registerEntityHook("entity.created", () => {
            hook2Executed = true;
        });

        // Create and save a new entity
        const entity = Entity.Create();
        await entity.save();

        // Verify both hooks were executed
        expect(hook1Executed).toBe(true);
        expect(hook2Executed).toBe(true);
    });

    test('should execute hooks with priority ordering', async () => {
        const executionOrder: number[] = [];

        hookManager.registerEntityHook("entity.created", () => {
            executionOrder.push(1);
        }, { priority: 1 });

        hookManager.registerEntityHook("entity.created", () => {
            executionOrder.push(2);
        }, { priority: 2 });

        hookManager.registerEntityHook("entity.created", () => {
            executionOrder.push(3);
        }, { priority: 0 });

        // Create and save a new entity
        const entity = Entity.Create();
        await entity.save();

        // Verify hooks executed in priority order (highest first)
        expect(executionOrder).toEqual([2, 1, 3]);
    });

    test('should handle hook execution errors gracefully', async () => {
        let goodHookExecuted = false;

        hookManager.registerEntityHook("entity.created", () => {
            throw new Error("Hook failed");
        });

        hookManager.registerEntityHook("entity.created", () => {
            goodHookExecuted = true;
        });

        // Create and save a new entity
        const entity = Entity.Create();
        await entity.save();

        // Verify the good hook still executed despite the error
        expect(goodHookExecuted).toBe(true);
    });

    test('should remove hooks by ID', () => {
        const hookId = hookManager.registerEntityHook("entity.created", () => {
            // This should not execute
            expect(true).toBe(false);
        });

        const removed = hookManager.removeHook(hookId);
        expect(removed).toBe(true);

        // Verify hook count decreased
        expect(hookManager.getHookCount("entity.created")).toBe(0);
    });

    test('should return false when removing non-existent hook', () => {
        const removed = hookManager.removeHook("non-existent-hook-id");
        expect(removed).toBe(false);
    });

    test('should get correct hook counts', () => {
        expect(hookManager.getHookCount()).toBe(0);

        hookManager.registerEntityHook("entity.created", () => {});
        hookManager.registerEntityHook("entity.updated", () => {});
        hookManager.registerEntityHook("entity.created", () => {});

        expect(hookManager.getHookCount()).toBe(3);
        expect(hookManager.getHookCount("entity.created")).toBe(2);
        expect(hookManager.getHookCount("entity.updated")).toBe(1);
        expect(hookManager.getHookCount("entity.deleted")).toBe(0);
    });

    test('should clear all hooks', () => {
        hookManager.registerEntityHook("entity.created", () => {});
        hookManager.registerEntityHook("entity.updated", () => {});

        expect(hookManager.getHookCount()).toBe(2);

        hookManager.clearAllHooks();

        expect(hookManager.getHookCount()).toBe(0);
    });
});

describe('Component Lifecycle Hooks - Phase 2', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should register and execute component added hook', async () => {
        let hookExecuted = false;
        let capturedEvent: ComponentAddedEvent | null = null;

        const hookId = hookManager.registerComponentHook("component.added", (event: ComponentAddedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        expect(hookId).toBeDefined();
        expect(typeof hookId).toBe('string');

        // Create entity and add component
        const entity = Entity.Create();
        const testComponent = new TestComponent();
        testComponent.value = "test component";
        entity.add(TestComponent, { value: "test component" });

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(ComponentAddedEvent);
        expect((capturedEvent as unknown as ComponentAddedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as ComponentAddedEvent)?.getComponentType()).toBe(testComponent.getTypeID());
        expect(((capturedEvent as unknown as ComponentAddedEvent)?.getComponent().data() as any).value).toBe("test component");
    });

    test('should register and execute component updated hook', async () => {
        let hookExecuted = false;
        let capturedEvent: ComponentUpdatedEvent | null = null;

        const hookId = hookManager.registerComponentHook("component.updated", (event: ComponentUpdatedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create entity and add component first
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "initial value" });

        // Reset for update test
        hookExecuted = false;
        capturedEvent = null;

        // Update the component
        await entity.set(TestComponent, { value: "updated value" });

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(ComponentUpdatedEvent);
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getComponentType()).toBe((new TestComponent()).getTypeID());
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getOldData()?.value).toBe("initial value");
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getNewData()?.value).toBe("updated value");
    });

    test('should register and execute component removed hook', async () => {
        let hookExecuted = false;
        let capturedEvent: ComponentRemovedEvent | null = null;

        const hookId = hookManager.registerComponentHook("component.removed", (event: ComponentRemovedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create entity and add component first
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test component" });

        // Remove the component
        const removed = entity.remove(TestComponent);

        // Verify removal was successful
        expect(removed).toBe(true);

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(ComponentRemovedEvent);
        expect((capturedEvent as unknown as ComponentRemovedEvent)?.getEntity()).toBe(entity);
        expect((capturedEvent as unknown as ComponentRemovedEvent)?.getComponentType()).toBe((new TestComponent()).getTypeID());
        expect(((capturedEvent as unknown as ComponentRemovedEvent)?.getComponent().data() as any).value).toBe("test component");
    });

    test('should execute multiple component hooks for the same event', async () => {
        let hook1Executed = false;
        let hook2Executed = false;

        hookManager.registerComponentHook("component.added", () => {
            hook1Executed = true;
        });

        hookManager.registerComponentHook("component.added", () => {
            hook2Executed = true;
        });

        // Create entity and add component
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test" });

        // Verify both hooks were executed
        expect(hook1Executed).toBe(true);
        expect(hook2Executed).toBe(true);
    });

    test('should execute component hooks with priority ordering', async () => {
        const executionOrder: number[] = [];

        hookManager.registerComponentHook("component.added", () => {
            executionOrder.push(1);
        }, { priority: 1 });

        hookManager.registerComponentHook("component.added", () => {
            executionOrder.push(2);
        }, { priority: 2 });

        hookManager.registerComponentHook("component.added", () => {
            executionOrder.push(3);
        }, { priority: 0 });

        // Create entity and add component
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test" });

        // Verify hooks executed in priority order (highest first)
        expect(executionOrder).toEqual([2, 1, 3]);
    });

    test('should handle component hook execution errors gracefully', async () => {
        let goodHookExecuted = false;

        hookManager.registerComponentHook("component.added", () => {
            throw new Error("Component hook failed");
        });

        hookManager.registerComponentHook("component.added", () => {
            goodHookExecuted = true;
        });

        // Create entity and add component
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test" });

        // Verify the good hook still executed despite the error
        expect(goodHookExecuted).toBe(true);
    });

    test('should return false when removing non-existent component', () => {
        const entity = Entity.Create();

        // Try to remove a component that doesn't exist
        const removed = entity.remove(TestComponent);

        expect(removed).toBe(false);
    });

    test('should fire component added event when set() adds new component', async () => {
        let hookExecuted = false;
        let capturedEvent: ComponentAddedEvent | null = null;

        const hookId = hookManager.registerComponentHook("component.added", (event: ComponentAddedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create entity and use set() to add new component
        const entity = Entity.Create();
        await entity.set(TestComponent, { value: "new component" });

        // Verify hook was executed (set() should fire added event for new components)
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(ComponentAddedEvent);
        expect(((capturedEvent as unknown as ComponentAddedEvent)?.getComponent().data() as any).value).toBe("new component");
    });

    test('should fire component updated event when set() updates existing component', async () => {
        let hookExecuted = false;
        let capturedEvent: ComponentUpdatedEvent | null = null;

        const hookId = hookManager.registerComponentHook("component.updated", (event: ComponentUpdatedEvent) => {
            hookExecuted = true;
            capturedEvent = event;
        });

        // Create entity and add component first
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "initial" });

        // Reset for update test
        hookExecuted = false;
        capturedEvent = null;

        // Use set() to update existing component
        await entity.set(TestComponent, { value: "updated" });

        // Verify hook was executed
        expect(hookExecuted).toBe(true);
        expect(capturedEvent).toBeInstanceOf(ComponentUpdatedEvent);
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getOldData()?.value).toBe("initial");
        expect((capturedEvent as unknown as ComponentUpdatedEvent)?.getNewData()?.value).toBe("updated");
    });

    test('should get correct hook counts for component events', () => {
        expect(hookManager.getHookCount()).toBe(0);

        hookManager.registerComponentHook("component.added", () => {});
        hookManager.registerComponentHook("component.updated", () => {});
        hookManager.registerComponentHook("component.added", () => {});

        expect(hookManager.getHookCount()).toBe(3);
        expect(hookManager.getHookCount("component.added")).toBe(2);
        expect(hookManager.getHookCount("component.updated")).toBe(1);
        expect(hookManager.getHookCount("component.removed")).toBe(0);
    });
});

describe('Advanced Features - Phase 3', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
        hookManager.resetMetrics();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
        hookManager.resetMetrics();
    });

    test('should execute async hooks properly', async () => {
        let hookExecuted = false;
        let executionOrder: string[] = [];

        const hookId = hookManager.registerEntityHook("entity.created", async (event: EntityCreatedEvent) => {
            executionOrder.push('start');
            await new Promise(resolve => setTimeout(resolve, 10));
            hookExecuted = true;
            executionOrder.push('end');
        }, { async: true });

        // Create entity and save
        const entity = Entity.Create();
        await entity.save();

        // Verify hook was executed asynchronously
        expect(hookExecuted).toBe(true);
        expect(executionOrder).toEqual(['start', 'end']);
    });

    test('should handle hook timeouts', async () => {
        let hookExecuted = false;
        let timeoutErrorThrown = false;

        const hookId = hookManager.registerEntityHook("entity.created", async (event: EntityCreatedEvent) => {
            await new Promise(resolve => setTimeout(resolve, 100)); // Longer than timeout
            hookExecuted = true;
        }, { async: true, timeout: 50 });

        // Create entity and save
        const entity = Entity.Create();
        await entity.save();

        // Wait a bit for timeout to occur and be logged
        await new Promise(resolve => setTimeout(resolve, 60));

        // Hook should have executed (timeout doesn't prevent execution, just logs error)
        expect(hookExecuted).toBe(true);
        // The timeout error should have been logged (we can't easily test the exact log output in this test)
    });

    test('should filter hooks based on conditions', async () => {
        let executedHooks: string[] = [];

        // Hook that only executes for new entities
        hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            executedHooks.push('new-only');
        }, {
            filter: (event) => event instanceof EntityCreatedEvent && event.isNew
        });

        // Hook that executes for all created events
        hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            executedHooks.push('all');
        });

        // Create and save entity (should be new)
        const entity = Entity.Create();
        await entity.save();

        // Verify both hooks executed (filter should pass for new entity)
        expect(executedHooks).toContain('new-only');
        expect(executedHooks).toContain('all');
    });

    test('should collect performance metrics', async () => {
        const hookId = hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            // Small delay to simulate work
        });

        // Create entity and save
        const entity = Entity.Create();
        await entity.save();

        // Check metrics
        const metrics = hookManager.getMetrics("entity.created");
        expect(metrics.totalExecutions).toBe(1);
        expect(metrics.averageExecutionTime).toBeGreaterThan(0);
        expect(metrics.errorCount).toBe(0);
    });

    test('should reset metrics correctly', async () => {
        const hookId = hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            // Do nothing
        });

        // Execute hook
        const entity = Entity.Create();
        await entity.save();

        // Verify metrics exist
        expect(hookManager.getMetrics("entity.created").totalExecutions).toBe(1);

        // Reset metrics
        hookManager.resetMetrics("entity.created");

        // Verify metrics are reset
        expect(hookManager.getMetrics("entity.created").totalExecutions).toBe(0);
    });

    test('should execute hooks in batch', async () => {
        let executionCount = 0;

        const hookId = hookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
            executionCount++;
        });

        // Create multiple events
        const events = [
            new EntityCreatedEvent(Entity.Create()),
            new EntityCreatedEvent(Entity.Create()),
            new EntityCreatedEvent(Entity.Create())
        ];

        // Execute in batch
        await hookManager.executeHooksBatch(events);

        // Verify all hooks were executed
        expect(executionCount).toBe(3);
    });

    test('should work with decorator-based hooks', async () => {
        let hookExecuted = false;

        class TestService {
            @EntityHook("entity.created")
            async handleEntityCreated(event: EntityCreatedEvent) {
                hookExecuted = true;
            }
        }

        const service = new TestService();
        registerDecoratedHooks(service);

        // Create entity and save
        const entity = Entity.Create();
        await entity.save();

        // Verify decorated hook was executed
        expect(hookExecuted).toBe(true);
    });

    test('should work with component decorator hooks', async () => {
        let hookExecuted = false;

        class TestService {
            @ComponentHook("component.added")
            async handleComponentAdded(event: ComponentAddedEvent) {
                hookExecuted = true;
            }
        }

        const service = new TestService();
        registerDecoratedHooks(service);

        // Create entity and add component
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test" });

        // Verify decorated hook was executed
        expect(hookExecuted).toBe(true);
    });

    test('should work with lifecycle decorator hooks', async () => {
        let hookExecuted = false;

        class TestService {
            @LifecycleHook()
            async handleAnyLifecycleEvent(event: any) {
                if (event.getEventType() === "entity.created") {
                    hookExecuted = true;
                }
            }
        }

        const service = new TestService();
        registerDecoratedHooks(service);

        // Create entity and save
        const entity = Entity.Create();
        await entity.save();

        // Verify decorated hook was executed
        expect(hookExecuted).toBe(true);
    });

    test('should work with multiple decorator hooks on same service', async () => {
        let entityHookExecuted = false;
        let componentHookExecuted = false;

        class TestService {
            @EntityHook("entity.created")
            async handleEntityCreated(event: EntityCreatedEvent) {
                entityHookExecuted = true;
            }

            @ComponentHook("component.added")
            async handleComponentAdded(event: ComponentAddedEvent) {
                componentHookExecuted = true;
            }
        }

        const service = new TestService();
        registerDecoratedHooks(service);

        // Create entity and add component
        const entity = Entity.Create();
        entity.add(TestComponent, { value: "test" });
        await entity.save();

        // Verify both decorated hooks were executed
        expect(entityHookExecuted).toBe(true);
        expect(componentHookExecuted).toBe(true);
    });
});