import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { Entity } from "../core/Entity";
import hookManager from "../core/EntityHookManager";
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent } from "../core/events/EntityLifecycleEvents";
import { BaseComponent, CompData, Component } from "../core/Components";
import App from "../core/App";
import { ComponentTargetHook, registerDecoratedHooks } from "../core/decorators/EntityHooks";
import ArcheType from "../core/ArcheType";

let app: App;

// Test components
@Component
class UserTag extends BaseComponent {
    @CompData()
    userType: string = "regular";
}

@Component
class AdminTag extends BaseComponent {
    @CompData()
    adminLevel: number = 1;
}

@Component
class TemporaryTag extends BaseComponent {
    @CompData()
    expiresAt: string = "";
}

@Component
class PostTag extends BaseComponent {
    @CompData()
    category: string = "general";
}

// Archetype test components
@Component
class NameComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

@Component
class EmailComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

@Component
class AddressComponent extends BaseComponent {
    @CompData()
    street: string = "";
    city: string = "";
}

// Define archetypes for testing
const UserArchetype = new ArcheType([UserTag, NameComponent, EmailComponent]);
const AdminArchetype = new ArcheType([AdminTag, NameComponent, EmailComponent]);
const PostArchetype = new ArcheType([PostTag]);

beforeAll(async () => {
    app = new App();
    await app.waitForAppReady();
});

describe('Component-Specific Hook Targeting - Phase 1', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should execute hook only for entities with specific included component', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook that only executes for entities with UserTag
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "premium" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with different component - hook should NOT execute
        const postEntity = Entity.Create();
        postEntity.add(PostTag, { category: "news" });
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });

    test('should execute hook only for entities without specific excluded component', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook that executes for entities WITHOUT TemporaryTag
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    excludeComponents: [TemporaryTag]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity without TemporaryTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with TemporaryTag - hook should NOT execute
        const tempEntity = Entity.Create();
        tempEntity.add(UserTag, { userType: "temp" });
        tempEntity.add(TemporaryTag, { expiresAt: "2025-12-31" });
        await tempEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });

    test('should execute hook with both include and exclude component targeting', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook for entities with UserTag but WITHOUT TemporaryTag
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag],
                    excludeComponents: [TemporaryTag]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity with UserTag but no TemporaryTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with UserTag AND TemporaryTag - hook should NOT execute
        const tempUserEntity = Entity.Create();
        tempUserEntity.add(UserTag, { userType: "temp" });
        tempUserEntity.add(TemporaryTag, { expiresAt: "2025-12-31" });
        await tempUserEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with only TemporaryTag - hook should NOT execute
        const tempEntity = Entity.Create();
        tempEntity.add(TemporaryTag, { expiresAt: "2025-12-31" });
        await tempEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });

    test('should execute hook with OR logic for multiple included components', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook for entities with UserTag OR AdminTag (requireAllIncluded = false)
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag, AdminTag],
                    requireAllIncluded: false // OR logic
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with AdminTag - hook should execute
        const adminEntity = Entity.Create();
        adminEntity.add(AdminTag, { adminLevel: 2 });
        await adminEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(adminEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with neither component - hook should NOT execute
        const postEntity = Entity.Create();
        postEntity.add(PostTag, { category: "news" });
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });

    test('should execute hook with AND logic for multiple included components', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook for entities with BOTH UserTag AND AdminTag (requireAllIncluded = true, default)
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag, AdminTag],
                    requireAllIncluded: true // AND logic (default)
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity with both UserTag and AdminTag - hook should execute
        const superUserEntity = Entity.Create();
        superUserEntity.add(UserTag, { userType: "admin" });
        superUserEntity.add(AdminTag, { adminLevel: 3 });
        await superUserEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(superUserEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with only UserTag - hook should NOT execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with only AdminTag - hook should NOT execute
        const adminEntity = Entity.Create();
        adminEntity.add(AdminTag, { adminLevel: 2 });
        await adminEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });

    test('should execute hook without component targeting (backward compatibility)', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook without component targeting (should work for all entities)
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            }
        );

        expect(hookId).toBeDefined();

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create entity with different component - hook should still execute
        const postEntity = Entity.Create();
        postEntity.add(PostTag, { category: "news" });
        await postEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(postEntity.id);
    });

    test('should work with entity update events and component targeting', async () => {
        let hookExecuted = false;
        let executedEntityId: string = "";

        // Register hook for entity updates on entities with UserTag
        const hookId = hookManager.registerEntityHook("entity.updated",
            (event: EntityUpdatedEvent) => {
                hookExecuted = true;
                executedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create and save entity first
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        // Reset for update test
        hookExecuted = false;
        executedEntityId = "";

        // Update the entity - hook should execute
        await userEntity.set(UserTag, { userType: "premium" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        executedEntityId = "";

        // Create and update entity without UserTag - hook should NOT execute
        const postEntity = Entity.Create();
        postEntity.add(PostTag, { category: "news" });
        await postEntity.save();

        await postEntity.set(PostTag, { category: "breaking" });
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(executedEntityId).toBe("");
    });
});

describe('ComponentTargetHook Decorator - Phase 2', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should register and execute decorated hook with include components', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestUserService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag]
            })
            async handleUserCreated(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestUserService();
        registerDecoratedHooks(service);

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "premium" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with different component - hook should NOT execute
        const postEntity = Entity.Create();
        postEntity.add(PostTag, { category: "news" });
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should register and execute decorated hook with exclude components', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestUserService {
            @ComponentTargetHook("entity.created", {
                excludeComponents: [TemporaryTag]
            })
            async handleNonTemporaryEntity(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestUserService();
        registerDecoratedHooks(service);

        // Create entity without TemporaryTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with TemporaryTag - hook should NOT execute
        const tempEntity = Entity.Create();
        tempEntity.add(UserTag, { userType: "temp" });
        tempEntity.add(TemporaryTag, { expiresAt: "2025-12-31" });
        await tempEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should register and execute decorated hook with combined include and exclude', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestUserService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag],
                excludeComponents: [TemporaryTag]
            })
            async handlePermanentUser(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestUserService();
        registerDecoratedHooks(service);

        // Create entity with UserTag but no TemporaryTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with UserTag AND TemporaryTag - hook should NOT execute
        const tempUserEntity = Entity.Create();
        tempUserEntity.add(UserTag, { userType: "temp" });
        tempUserEntity.add(TemporaryTag, { expiresAt: "2025-12-31" });
        await tempUserEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should register and execute decorated hook with OR logic', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestMultiComponentService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag, AdminTag],
                requireAllIncluded: false // OR logic
            })
            async handleUserOrAdmin(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestMultiComponentService();
        registerDecoratedHooks(service);

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with AdminTag - hook should execute
        const adminEntity = Entity.Create();
        adminEntity.add(AdminTag, { adminLevel: 2 });
        await adminEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(adminEntity.id);
    });

    test('should register and execute decorated hook with AND logic', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestSuperUserService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag, AdminTag],
                requireAllIncluded: true // AND logic (default)
            })
            async handleSuperUser(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestSuperUserService();
        registerDecoratedHooks(service);

        // Create entity with both UserTag and AdminTag - hook should execute
        const superUserEntity = Entity.Create();
        superUserEntity.add(UserTag, { userType: "admin" });
        superUserEntity.add(AdminTag, { adminLevel: 3 });
        await superUserEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(superUserEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with only UserTag - hook should NOT execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should work with entity update events using decorator', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestUserUpdateService {
            @ComponentTargetHook("entity.updated", {
                includeComponents: [UserTag]
            })
            async handleUserUpdated(event: EntityUpdatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestUserUpdateService();
        registerDecoratedHooks(service);

        // Create and save entity first
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        // Reset for update test
        hookExecuted = false;
        capturedEntityId = "";

        // Update the entity - hook should execute
        await userEntity.set(UserTag, { userType: "premium" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);
    });

    test('should support multiple decorated hooks on same service', async () => {
        let userHookExecuted = false;
        let adminHookExecuted = false;
        let userEntityId: string = "";
        let adminEntityId: string = "";

        class TestMultiHookService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag]
            })
            async handleUserCreated(event: EntityCreatedEvent) {
                userHookExecuted = true;
                userEntityId = event.getEntity().id;
            }

            @ComponentTargetHook("entity.created", {
                includeComponents: [AdminTag]
            })
            async handleAdminCreated(event: EntityCreatedEvent) {
                adminHookExecuted = true;
                adminEntityId = event.getEntity().id;
            }
        }

        const service = new TestMultiHookService();
        registerDecoratedHooks(service);

        // Create user entity - only user hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "regular" });
        await userEntity.save();

        expect(userHookExecuted).toBe(true);
        expect(adminHookExecuted).toBe(false);
        expect(userEntityId).toBe(userEntity.id);

        // Reset for next test
        userHookExecuted = false;
        adminHookExecuted = false;
        userEntityId = "";
        adminEntityId = "";

        // Create admin entity - only admin hook should execute
        const adminEntity = Entity.Create();
        adminEntity.add(AdminTag, { adminLevel: 2 });
        await adminEntity.save();

        expect(userHookExecuted).toBe(false);
        expect(adminHookExecuted).toBe(true);
        expect(adminEntityId).toBe(adminEntity.id);
    });

    test('should support additional hook options with component targeting', async () => {
        let hookExecuted = false;
        let executionCount = 0;

        class TestPriorityService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag]
            }, {
                priority: 10,
                name: "HighPriorityUserHook"
            })
            async handleUserCreated(event: EntityCreatedEvent) {
                hookExecuted = true;
                executionCount++;
            }
        }

        const service = new TestPriorityService();
        registerDecoratedHooks(service);

        // Create entity with UserTag - hook should execute
        const userEntity = Entity.Create();
        userEntity.add(UserTag, { userType: "premium" });
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(executionCount).toBe(1);
    });
});

describe('Archetype-Based Component Targeting - Phase 2', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should execute hook for entities matching specific archetype', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        // Register hook that only executes for UserArchetype entities
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    archetype: UserArchetype
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity matching UserArchetype - hook should execute
        const userEntity = UserArchetype.fill({
            userTag: { userType: "premium" },
            nameComponent: { value: "John Doe" },
            emailComponent: { value: "john@example.com" }
        }).createEntity();
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with different archetype - hook should NOT execute
        const postEntity = PostArchetype.fill({
            postTag: { category: "news" }
        }).createEntity();
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with UserArchetype but extra component - hook should NOT execute
        const extendedUserEntity = UserArchetype.fill({
            userTag: { userType: "regular" },
            nameComponent: { value: "Jane Doe" },
            emailComponent: { value: "jane@example.com" }
        }).createEntity();
        extendedUserEntity.add(AddressComponent, { street: "123 Main St", city: "Anytown" });
        await extendedUserEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should execute hook for entities matching any of multiple archetypes', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        // Register hook that executes for UserArchetype OR AdminArchetype entities
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    archetypes: [UserArchetype, AdminArchetype]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity matching UserArchetype - hook should execute
        const userEntity = UserArchetype.fill({
            userTag: { userType: "regular" },
            nameComponent: { value: "John Doe" },
            emailComponent: { value: "john@example.com" }
        }).createEntity();
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity matching AdminArchetype - hook should execute
        const adminEntity = AdminArchetype.fill({
            adminTag: { adminLevel: 2 },
            nameComponent: { value: "Admin User" },
            emailComponent: { value: "admin@example.com" }
        }).createEntity();
        await adminEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(adminEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with different archetype - hook should NOT execute
        const postEntity = PostArchetype.fill({
            postTag: { category: "news" }
        }).createEntity();
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should combine archetype and component targeting', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        // Register hook for UserArchetype entities with additional AdminTag
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            },
            {
                componentTarget: {
                    archetype: UserArchetype,
                    includeComponents: [AdminTag] // Must also have AdminTag
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create entity matching UserArchetype with AdminTag - hook should execute
        const superUserEntity = UserArchetype.fill({
            userTag: { userType: "admin" },
            nameComponent: { value: "Super User" },
            emailComponent: { value: "super@example.com" }
        }).createEntity();
        superUserEntity.add(AdminTag, { adminLevel: 3 });
        await superUserEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(superUserEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity matching UserArchetype without AdminTag - hook should NOT execute
        const userEntity = UserArchetype.fill({
            userTag: { userType: "regular" },
            nameComponent: { value: "Regular User" },
            emailComponent: { value: "regular@example.com" }
        }).createEntity();
        await userEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should work with archetype targeting using decorator', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestArchetypeService {
            @ComponentTargetHook("entity.created", {
                archetype: UserArchetype
            })
            async handleUserArchetype(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestArchetypeService();
        registerDecoratedHooks(service);

        // Create entity matching UserArchetype - hook should execute
        const userEntity = UserArchetype.fill({
            userTag: { userType: "premium" },
            nameComponent: { value: "John Doe" },
            emailComponent: { value: "john@example.com" }
        }).createEntity();
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity with different archetype - hook should NOT execute
        const postEntity = PostArchetype.fill({
            postTag: { category: "news" }
        }).createEntity();
        await postEntity.save();

        expect(hookExecuted).toBe(false);
        expect(capturedEntityId).toBe("");
    });

    test('should work with multiple archetypes using decorator', async () => {
        let hookExecuted = false;
        let capturedEntityId: string = "";

        class TestMultiArchetypeService {
            @ComponentTargetHook("entity.created", {
                archetypes: [UserArchetype, AdminArchetype]
            })
            async handleUserOrAdminArchetype(event: EntityCreatedEvent) {
                hookExecuted = true;
                capturedEntityId = event.getEntity().id;
            }
        }

        const service = new TestMultiArchetypeService();
        registerDecoratedHooks(service);

        // Create entity matching UserArchetype - hook should execute
        const userEntity = UserArchetype.fill({
            userTag: { userType: "regular" },
            nameComponent: { value: "John Doe" },
            emailComponent: { value: "john@example.com" }
        }).createEntity();
        await userEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(userEntity.id);

        // Reset for next test
        hookExecuted = false;
        capturedEntityId = "";

        // Create entity matching AdminArchetype - hook should execute
        const adminEntity = AdminArchetype.fill({
            adminTag: { adminLevel: 2 },
            nameComponent: { value: "Admin User" },
            emailComponent: { value: "admin@example.com" }
        }).createEntity();
        await adminEntity.save();

        expect(hookExecuted).toBe(true);
        expect(capturedEntityId).toBe(adminEntity.id);
    });
});

describe('Batch Processing Optimizations - Phase 2', () => {
    beforeEach(() => {
        hookManager.clearAllHooks();
    });

    afterEach(() => {
        hookManager.clearAllHooks();
    });

    test('should efficiently process multiple events in batch with component targeting', async () => {
        let executionCount = 0;
        let executedEntityIds: string[] = [];

        // Register hook that only executes for entities with UserTag
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                executionCount++;
                executedEntityIds.push(event.getEntity().id);
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        expect(hookId).toBeDefined();

        // Create multiple entities in batch
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];
        const postEntities: Entity[] = [];

        // Create 3 user entities and 2 post entities
        for (let i = 0; i < 3; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        for (let i = 0; i < 2; i++) {
            const postEntity = Entity.Create();
            postEntity.add(PostTag, { category: `category${i}` });
            postEntities.push(postEntity);
            events.push(new EntityCreatedEvent(postEntity));
        }

        // Execute hooks in batch
        await hookManager.executeHooksBatch(events);

        // Hook should have executed only for user entities
        expect(executionCount).toBe(3);
        expect(executedEntityIds).toHaveLength(3);

        // Verify the correct entities were processed
        const userEntityIds = userEntities.map(e => e.id);
        expect(executedEntityIds.sort()).toEqual(userEntityIds.sort());
    });

    test('should optimize batch processing by pre-filtering hooks', async () => {
        let userHookExecuted = false;
        let adminHookExecuted = false;
        let postHookExecuted = false;

        // Register multiple hooks with different component targeting
        const userHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                userHookExecuted = true;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        const adminHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                adminHookExecuted = true;
            },
            {
                componentTarget: {
                    includeComponents: [AdminTag]
                }
            }
        );

        const postHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                postHookExecuted = true;
            },
            {
                componentTarget: {
                    includeComponents: [PostTag]
                }
            }
        );

        // Create batch of events with only UserTag entities
        const events: EntityCreatedEvent[] = [];
        for (let i = 0; i < 3; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Execute hooks in batch - only user hook should execute
        await hookManager.executeHooksBatch(events);

        expect(userHookExecuted).toBe(true);
        expect(adminHookExecuted).toBe(false);
        expect(postHookExecuted).toBe(false);
    });

    test('should handle mixed sync and async hooks efficiently in batch', async () => {
        let syncExecutionCount = 0;
        let asyncExecutionCount = 0;
        let syncEntityIds: string[] = [];
        let asyncEntityIds: string[] = [];

        // Register sync hook
        const syncHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                syncExecutionCount++;
                syncEntityIds.push(event.getEntity().id);
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                },
                async: false
            }
        );

        // Register async hook
        const asyncHookId = hookManager.registerEntityHook("entity.created",
            async (event: EntityCreatedEvent) => {
                await new Promise(resolve => setTimeout(resolve, 1)); // Simulate async work
                asyncExecutionCount++;
                asyncEntityIds.push(event.getEntity().id);
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                },
                async: true
            }
        );

        // Create batch of user entities
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];

        for (let i = 0; i < 3; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Execute hooks in batch
        await hookManager.executeHooksBatch(events);

        // Both hooks should have executed for all user entities
        expect(syncExecutionCount).toBe(3);
        expect(asyncExecutionCount).toBe(3);

        const userEntityIds = userEntities.map(e => e.id).sort();
        expect(syncEntityIds.sort()).toEqual(userEntityIds);
        expect(asyncEntityIds.sort()).toEqual(userEntityIds);
    });

    test('should maintain hook execution order in batch processing', async () => {
        let executionOrder: string[] = [];

        // Register hooks with different priorities
        const highPriorityHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                executionOrder.push(`high-${event.getEntity().id}`);
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                },
                priority: 10
            }
        );

        const lowPriorityHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                executionOrder.push(`low-${event.getEntity().id}`);
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                },
                priority: 1
            }
        );

        // Create batch of user entities
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];

        for (let i = 0; i < 2; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Execute hooks in batch
        await hookManager.executeHooksBatch(events);

        // Verify execution order (high priority first)
        expect(executionOrder).toHaveLength(4);
        expect(executionOrder[0]).toMatch(/^high-/);
        expect(executionOrder[1]).toMatch(/^high-/);
        expect(executionOrder[2]).toMatch(/^low-/);
        expect(executionOrder[3]).toMatch(/^low-/);
    });

    test('should handle archetype-based targeting efficiently in batch', async () => {
        let executionCount = 0;
        let executedEntityIds: string[] = [];

        // Register hook for UserArchetype entities
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                executionCount++;
                executedEntityIds.push(event.getEntity().id);
            },
            {
                componentTarget: {
                    archetype: UserArchetype
                }
            }
        );

        // Create batch of mixed entities
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];
        const adminEntities: Entity[] = [];
        const postEntities: Entity[] = [];

        // Create 2 user archetype entities
        for (let i = 0; i < 2; i++) {
            const userEntity = UserArchetype.fill({
                userTag: { userType: `user${i}` },
                nameComponent: { value: `User ${i}` },
                emailComponent: { value: `user${i}@example.com` }
            }).createEntity();
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Create 1 admin archetype entity
        const adminEntity = AdminArchetype.fill({
            adminTag: { adminLevel: 2 },
            nameComponent: { value: "Admin User" },
            emailComponent: { value: "admin@example.com" }
        }).createEntity();
        adminEntities.push(adminEntity);
        events.push(new EntityCreatedEvent(adminEntity));

        // Create 1 post entity
        const postEntity = PostArchetype.fill({
            postTag: { category: "news" }
        }).createEntity();
        postEntities.push(postEntity);
        events.push(new EntityCreatedEvent(postEntity));

        // Execute hooks in batch
        await hookManager.executeHooksBatch(events);

        // Hook should have executed only for user archetype entities
        expect(executionCount).toBe(2);
        expect(executedEntityIds).toHaveLength(2);

        const userEntityIds = userEntities.map(e => e.id);
        expect(executedEntityIds.sort()).toEqual(userEntityIds.sort());
    });

    test('should handle timeout and error scenarios in batch processing', async () => {
        let successCount = 0;
        let errorCount = 0;

        // Register hook that succeeds
        const successHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                successCount++;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        // Register hook that throws error
        const errorHookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                errorCount++;
                throw new Error("Test error");
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        // Create batch of user entities
        const events: EntityCreatedEvent[] = [];
        for (let i = 0; i < 2; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Execute hooks in batch - should handle errors gracefully
        await hookManager.executeHooksBatch(events);

        // Success hook should have executed for both entities
        expect(successCount).toBe(2);
        // Error hook should have executed but thrown errors
        expect(errorCount).toBe(2);
    });

    test('should optimize performance with large batches and component targeting', async () => {
        let executionCount = 0;

        // Register hook with component targeting
        const hookId = hookManager.registerEntityHook("entity.created",
            (event: EntityCreatedEvent) => {
                executionCount++;
            },
            {
                componentTarget: {
                    includeComponents: [UserTag]
                }
            }
        );

        // Create large batch of mixed entities (100 total: 50 users, 50 posts)
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];

        for (let i = 0; i < 50; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        for (let i = 0; i < 50; i++) {
            const postEntity = Entity.Create();
            postEntity.add(PostTag, { category: `category${i}` });
            events.push(new EntityCreatedEvent(postEntity));
        }

        // Execute hooks in batch
        const startTime = performance.now();
        await hookManager.executeHooksBatch(events);
        const endTime = performance.now();

        // Hook should have executed only for user entities
        expect(executionCount).toBe(50);

        // Verify reasonable performance (should complete in reasonable time)
        const executionTime = endTime - startTime;
        expect(executionTime).toBeLessThan(1000); // Should complete in less than 1 second
    });

    test('should work with decorator-based hooks in batch processing', async () => {
        let executionCount = 0;
        let executedEntityIds: string[] = [];

        class TestBatchService {
            @ComponentTargetHook("entity.created", {
                includeComponents: [UserTag]
            })
            async handleUserCreated(event: EntityCreatedEvent) {
                executionCount++;
                executedEntityIds.push(event.getEntity().id);
            }
        }

        const service = new TestBatchService();
        registerDecoratedHooks(service);

        // Create batch of mixed entities
        const events: EntityCreatedEvent[] = [];
        const userEntities: Entity[] = [];

        for (let i = 0; i < 3; i++) {
            const userEntity = Entity.Create();
            userEntity.add(UserTag, { userType: `user${i}` });
            userEntities.push(userEntity);
            events.push(new EntityCreatedEvent(userEntity));
        }

        // Add non-matching entities
        for (let i = 0; i < 2; i++) {
            const postEntity = Entity.Create();
            postEntity.add(PostTag, { category: `category${i}` });
            events.push(new EntityCreatedEvent(postEntity));
        }

        // Execute hooks in batch
        await hookManager.executeHooksBatch(events);

        // Decorator hook should have executed only for user entities
        expect(executionCount).toBe(3);
        expect(executedEntityIds).toHaveLength(3);

        const userEntityIds = userEntities.map(e => e.id);
        expect(executedEntityIds.sort()).toEqual(userEntityIds.sort());
    });
});