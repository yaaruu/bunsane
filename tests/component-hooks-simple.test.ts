import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Entity } from "../core/Entity";
import hookManager from "../core/EntityHookManager";
import { EntityCreatedEvent } from "../core/events/EntityLifecycleEvents";
import { BaseComponent, CompData, Component } from "../core/Components";
import { ComponentTargetHook, registerDecoratedHooks } from "../core/decorators/EntityHooks";

// Simple test components
@Component
class TestTag extends BaseComponent {
    @CompData()
    value: string = "test";
}

describe('Hook Manager - Simple Tests', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should register and count hooks', () => {
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                console.log("Hook executed");
            },
            {
                componentTarget: {
                    includeComponents: [TestTag]
                }
            }
        );

        expect(hookId).toBeDefined();
        expect(hookManager.getHookCount("entity.created")).toBe(1);
    });

    test('should execute hook synchronously without database', () => {
        let hookExecuted = false;

        hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
            },
            {
                componentTarget: {
                    includeComponents: [TestTag]
                }
            }
        );

        // Create entity and manually trigger the event (without saving to database)
        const entity = Entity.Create();
        entity.add(TestTag, { value: "test" });
        
        const event = new EntityCreatedEvent(entity);
        hookManager.executeHooks(event);

        expect(hookExecuted).toBe(true);
    });

    test('should not execute hook for non-matching component', () => {
        let hookExecuted = false;

        @Component
        class OtherTag extends BaseComponent {
            @CompData()
            value: string = "other";
        }

        hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
            },
            {
                componentTarget: {
                    includeComponents: [TestTag]
                }
            }
        );

        // Create entity with different component
        const entity = Entity.Create();
        entity.add(OtherTag, { value: "other" });
        
        const event = new EntityCreatedEvent(entity);
        hookManager.executeHooks(event);

        expect(hookExecuted).toBe(false);
    });

    test('should execute decorator-based hook', () => {
        let hookExecuted = false;

        class TestService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [TestTag]
            })
            async handleCreated(event: EntityCreatedEvent) {
                hookExecuted = true;
            }
        }

        const service = new TestService();
        registerDecoratedHooks(service);

        const entity = Entity.Create();
        entity.add(TestTag, { value: "test" });
        
        const event = new EntityCreatedEvent(entity);
        hookManager.executeHooks(event);

        expect(hookExecuted).toBe(true);
    });
});
