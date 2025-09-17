# Migration Guide: Adopting Entity Lifecycle Hooks

## Overview

This guide provides step-by-step instructions for migrating existing BunSane services to use the new Entity Lifecycle Hooks system. The migration process is designed to be gradual and backward-compatible, allowing you to adopt hooks incrementally without breaking existing functionality.

## Migration Benefits

- **Separation of Concerns**: Move business logic out of core entity operations
- **Reusability**: Share common logic across multiple services
- **Maintainability**: Centralized hook management and monitoring
- **Testability**: Isolated hook testing without entity setup
- **Performance**: Built-in metrics and optimization features

## Assessment Phase

### Step 1: Identify Migration Candidates

Analyze your existing services for patterns that would benefit from hooks:

```typescript
// Look for patterns like these in your services:

// Manual event handling after entity operations
await entity.save();
await this.auditService.logCreation(entity);

// Business logic mixed with entity operations
const entity = Entity.Create();
entity.add(SomeComponent, { data: "value" });
await this.validateBusinessRules(entity); // Should be a hook
await entity.save();

// Repeated logic across services
// Same validation logic in multiple places
```

### Step 2: Categorize Hook Opportunities

**Entity Lifecycle Hooks:**
- Audit logging (creation, updates, deletions)
- Business rule validation
- Search index updates
- Cache invalidation
- Notification triggers

**Component Lifecycle Hooks:**
- Data validation
- Derived data calculation
- External system synchronization
- Component-specific business rules

## Migration Strategies

### Strategy 1: Gradual Migration (Recommended)

Migrate functionality incrementally without breaking existing code:

```typescript
// Before: Manual hook calls
class UserService {
    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);
        await entity.save();

        // Manual audit logging
        await this.auditService.logUserCreation(entity.id, userData);
        await this.notificationService.sendWelcomeEmail(userData.email);

        return entity;
    }
}

// After: Hook-based approach
class UserService {
    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);
        await entity.save();

        // Entity save automatically triggers hooks
        // Manual calls can remain until hooks are fully tested
        await this.auditService.logUserCreation(entity.id, userData);
        await this.notificationService.sendWelcomeEmail(userData.email);

        return entity;
    }
}

// New: Dedicated hook service
class UserLifecycleService {
    @EntityHook("entity.created")
    async handleUserCreation(event: EntityCreatedEvent) {
        const entity = event.getEntity();

        // Only process User entities
        if (!entity.has(UserComponent)) return;

        const userData = entity.get(UserComponent);
        if (!userData) return;

        // Automatic audit logging
        await this.auditService.logUserCreation(entity.id, userData.data);

        // Automatic notifications
        await this.notificationService.sendWelcomeEmail(userData.data.email);
    }
}
```

### Strategy 2: Parallel Implementation

Run both old and new implementations during transition:

```typescript
class MigrationWrapper {
    private useHooks = process.env.USE_HOOKS === 'true';

    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);
        await entity.save();

        if (this.useHooks) {
            // New hook-based logic
            // Automatic processing via hooks
        } else {
            // Legacy manual processing
            await this.auditService.logUserCreation(entity.id, userData);
            await this.notificationService.sendWelcomeEmail(userData.email);
        }

        return entity;
    }
}
```

### Strategy 3: Feature Flags

Use feature flags for gradual rollout:

```typescript
class UserService {
    private hooksEnabled = process.env.USER_HOOKS_ENABLED === 'true';

    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);
        await entity.save();

        // Always execute legacy logic for safety
        await this.auditService.logUserCreation(entity.id, userData);
        await this.notificationService.sendWelcomeEmail(userData.email);

        // Conditionally register hooks
        if (this.hooksEnabled) {
            this.registerUserHooks();
        }

        return entity;
    }

    private registerUserHooks() {
        // Register hooks only when enabled
        EntityHookManager.registerEntityHook("entity.created",
            this.handleUserCreation.bind(this),
            {
                filter: (event) => event instanceof EntityCreatedEvent &&
                                  event.getEntity().has(UserComponent)
            }
        );
    }
}
```

## Implementation Steps

### Step 1: Create Hook Services

Create dedicated services for hook logic:

```typescript
// hooks/UserHooks.ts
import { EntityHook, ComponentHook } from "bunsane";
import { EntityCreatedEvent, ComponentUpdatedEvent } from "bunsane";

export class UserHooks {
    constructor(
        private auditService: AuditService,
        private notificationService: NotificationService,
        private validationService: ValidationService
    ) {}

    @EntityHook("entity.created")
    async handleUserCreation(event: EntityCreatedEvent) {
        const entity = event.getEntity();

        // Type guard
        if (!entity.has(UserComponent)) return;

        const userData = entity.get(UserComponent);
        if (!userData) return;

        // Business logic
        await this.auditService.logUserCreation(entity.id, userData.data);
        await this.notificationService.sendWelcomeEmail(userData.data.email);
    }

    @ComponentHook("component.updated")
    async validateUserData(event: ComponentUpdatedEvent) {
        if (event.getComponentType() !== UserComponent.getTypeID()) return;

        const newData = event.getNewData();
        await this.validationService.validateUserData(newData);
    }
}
```

### Step 2: Register Hooks

Register hooks in your application initialization:

```typescript
// In your main application file or service registry
import { UserHooks } from "./hooks/UserHooks";

export class Application {
    async initialize() {
        // Wait for hook system to be ready
        await EntityHookManager.waitForReady();

        // Register hook services
        const userHooks = new UserHooks(
            this.auditService,
            this.notificationService,
            this.validationService
        );

        registerDecoratedHooks(userHooks);

        logger.info("User hooks registered successfully");
    }
}
```

### Step 3: Update Existing Services

Modify existing services to remove manual hook calls:

```typescript
// Before
class UserService {
    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);

        // Manual validation (move to hooks)
        await this.validateUserData(userData);

        await entity.save();

        // Manual audit (move to hooks)
        await this.auditService.logUserCreation(entity.id, userData);

        return entity;
    }

    async updateUser(entityId: string, updates: any) {
        const entity = await Entity.Find(entityId);
        if (!entity) throw new Error("User not found");

        // Manual validation (move to hooks)
        await this.validateUserData(updates);

        entity.set(UserComponent, updates);
        await entity.save();

        // Manual audit (move to hooks)
        await this.auditService.logUserUpdate(entityId, updates);

        return entity;
    }
}

// After
class UserService {
    async createUser(userData: any) {
        const entity = Entity.Create();
        entity.add(UserComponent, userData);
        await entity.save();

        // Validation and audit now happen automatically via hooks
        return entity;
    }

    async updateUser(entityId: string, updates: any) {
        const entity = await Entity.Find(entityId);
        if (!entity) throw new Error("User not found");

        entity.set(UserComponent, updates);
        await entity.save();

        // Validation and audit now happen automatically via hooks
        return entity;
    }
}
```

### Step 4: Handle Dependencies

Ensure hook services have access to required dependencies:

```typescript
// Dependency injection for hooks
class HookServiceProvider {
    private services = new Map<string, any>();

    registerService(name: string, service: any) {
        this.services.set(name, service);
    }

    getService<T>(name: string): T {
        const service = this.services.get(name);
        if (!service) {
            throw new Error(`Service ${name} not registered`);
        }
        return service as T;
    }
}

// Usage
const provider = new HookServiceProvider();
provider.registerService("audit", auditService);
provider.registerService("notification", notificationService);

class UserHooks {
    private get auditService() {
        return this.provider.getService<AuditService>("audit");
    }

    // ... hook methods
}
```

## Testing Migration

### Step 1: Test Hook Isolation

Test hooks independently of entity operations:

```typescript
describe("UserHooks", () => {
    let hookService: UserHooks;
    let mockAuditService: jest.Mocked<AuditService>;

    beforeEach(() => {
        mockAuditService = {
            logUserCreation: jest.fn()
        };

        hookService = new UserHooks(mockAuditService);
        registerDecoratedHooks(hookService);
    });

    afterEach(() => {
        EntityHookManager.clearAllHooks();
    });

    test("should log user creation", async () => {
        const entity = Entity.Create();
        entity.add(UserComponent, { email: "test@example.com" });

        await entity.save();

        expect(mockAuditService.logUserCreation).toHaveBeenCalledWith(
            entity.id,
            { email: "test@example.com" }
        );
    });
});
```

### Step 2: Test Integration

Test that hooks work with existing entity operations:

```typescript
describe("Migration Integration", () => {
    test("should work with existing entity operations", async () => {
        // Register hooks
        const userHooks = new UserHooks(auditService, notificationService);
        registerDecoratedHooks(userHooks);

        // Use existing service methods
        const userService = new UserService();
        const entity = await userService.createUser({
            email: "test@example.com"
        });

        // Verify hooks were executed
        expect(auditService.logUserCreation).toHaveBeenCalled();
        expect(notificationService.sendWelcomeEmail).toHaveBeenCalled();
    });
});
```

### Step 3: Performance Testing

Monitor performance during migration:

```typescript
describe("Performance Tests", () => {
    test("should not impact entity save performance", async () => {
        const entity = Entity.Create();
        entity.add(UserComponent, { email: "test@example.com" });

        const startTime = performance.now();
        await entity.save();
        const endTime = performance.now();

        // Should be under 10ms as per requirements
        expect(endTime - startTime).toBeLessThan(10);
    });

    test("should collect hook metrics", async () => {
        // Execute some hooks
        const entity = Entity.Create();
        await entity.save();

        const metrics = EntityHookManager.getMetrics("entity.created");
        expect(metrics.totalExecutions).toBeGreaterThan(0);
        expect(metrics.averageExecutionTime).toBeGreaterThan(0);
    });
});
```

## Rollback Strategy

### Quick Rollback

If issues arise, you can quickly disable hooks:

```typescript
// Emergency disable
EntityHookManager.clearAllHooks();

// Or disable specific hooks
const hookIds = [
    EntityHookManager.registerEntityHook("entity.created", handler1),
    EntityHookManager.registerEntityHook("entity.updated", handler2)
];

// Store for later removal
this.registeredHooks = hookIds;

// Remove when needed
this.registeredHooks.forEach(id => EntityHookManager.removeHook(id));
```

### Gradual Rollback

Implement feature flags for rollback:

```typescript
class HookManager {
    private enabledHooks = new Set<string>();

    enableHook(type: string) {
        this.enabledHooks.add(type);
    }

    disableHook(type: string) {
        this.enabledHooks.delete(type);
    }

    isHookEnabled(type: string): boolean {
        return this.enabledHooks.has(type);
    }
}

// Usage in hooks
class UserHooks {
    @EntityHook("entity.created")
    async handleUserCreation(event: EntityCreatedEvent) {
        if (!this.hookManager.isHookEnabled("user.creation")) {
            return; // Skip hook execution
        }

        // Normal hook logic
    }
}
```

## Common Migration Patterns

### Pattern 1: Extract Method to Hook

```typescript
// Before: Method with side effects
class UserService {
    async createUser(data: any) {
        // Core logic
        const entity = Entity.Create();
        entity.add(UserComponent, data);
        await entity.save();

        // Side effect - extract to hook
        await this.sendWelcomeEmail(data.email);
    }
}

// After: Side effect moved to hook
class UserNotificationHooks {
    @EntityHook("entity.created")
    async sendWelcomeEmail(event: EntityCreatedEvent) {
        const entity = event.getEntity();
        if (!entity.has(UserComponent)) return;

        const userData = entity.get(UserComponent);
        if (!userData?.data?.email) return;

        await this.emailService.sendWelcome(userData.data.email);
    }
}
```

### Pattern 2: Consolidate Multiple Services

```typescript
// Before: Multiple services with similar logic
class AuditService {
    async logUserCreation(entityId: string, data: any) { /* ... */ }
}

class NotificationService {
    async sendWelcomeEmail(email: string) { /* ... */ }
}

class ValidationService {
    async validateUserData(data: any) { /* ... */ }
}

// After: Single hook service
class UserLifecycleHooks {
    @EntityHook("entity.created")
    async handleUserLifecycle(event: EntityCreatedEvent) {
        const entity = event.getEntity();
        if (!entity.has(UserComponent)) return;

        const userData = entity.get(UserComponent);
        if (!userData) return;

        // All related logic in one place
        await this.auditService.logUserCreation(entity.id, userData.data);
        await this.notificationService.sendWelcomeEmail(userData.data.email);
        await this.validationService.validateUserData(userData.data);
    }
}
```

### Pattern 3: Conditional Hook Execution

```typescript
// Before: Conditional logic in service methods
class UserService {
    async updateUser(entityId: string, updates: any) {
        if (updates.email) {
            await this.sendEmailChangeNotification(updates.email);
        }

        if (updates.role) {
            await this.updatePermissions(entityId, updates.role);
        }
    }
}

// After: Conditional hooks
class UserUpdateHooks {
    @EntityHook("entity.updated")
    async handleEmailChange(event: EntityUpdatedEvent) {
        const changedComponents = event.getChangedComponents();

        if (changedComponents.includes(UserComponent.getTypeID())) {
            const oldData = event.getOldData();
            const newData = event.getNewData();

            if (oldData?.email !== newData?.email) {
                await this.sendEmailChangeNotification(newData.email);
            }
        }
    }

    @EntityHook("entity.updated")
    async handleRoleChange(event: EntityUpdatedEvent) {
        const changedComponents = event.getChangedComponents();

        if (changedComponents.includes(UserComponent.getTypeID())) {
            const oldData = event.getOldData();
            const newData = event.getNewData();

            if (oldData?.role !== newData?.role) {
                await this.updatePermissions(event.getEntity().id, newData.role);
            }
        }
    }
}
```

## Best Practices

### 1. Start Small

Begin with simple hooks and gradually migrate complex logic:

```typescript
// Phase 1: Simple audit logging
@entityHook("entity.created")
async logCreation(event: EntityCreatedEvent) {
    await this.auditService.log(event.getEntity().id, "created");
}

// Phase 2: Add validation
@entityHook("entity.created")
async validateAndLog(event: EntityCreatedEvent) {
    const entity = event.getEntity();
    await this.validationService.validate(entity);
    await this.auditService.log(entity.id, "created");
}

// Phase 3: Add notifications
@entityHook("entity.created")
async fullLifecycle(event: EntityCreatedEvent) {
    const entity = event.getEntity();
    await this.validationService.validate(entity);
    await this.auditService.log(entity.id, "created");
    await this.notificationService.notify(entity);
}
```

### 2. Test Thoroughly

Test hooks in isolation and integration:

```typescript
describe("Hook Migration", () => {
    test("hooks execute correctly", async () => {
        // Test hook logic in isolation
    });

    test("existing functionality preserved", async () => {
        // Test that existing service methods still work
    });

    test("performance requirements met", async () => {
        // Test performance impact
    });
});
```

### 3. Monitor and Optimize

Use built-in metrics to monitor hook performance:

```typescript
// Monitor hook performance
setInterval(() => {
    const metrics = EntityHookManager.getMetrics();
    if (metrics.averageExecutionTime > 5) {
        logger.warn("Hook execution time is high:", metrics);
    }
}, 60000); // Check every minute
```

### 4. Document Dependencies

Document hook dependencies and execution order:

```typescript
/**
 * UserLifecycleHooks
 *
 * Dependencies:
 * - AuditService: For logging user actions
 * - NotificationService: For sending emails
 * - ValidationService: For data validation
 *
 * Execution Order:
 * 1. Validation hooks (priority: 100)
 * 2. Audit hooks (priority: 50)
 * 3. Notification hooks (priority: 10)
 */
class UserLifecycleHooks {
    // Implementation
}
```

## Troubleshooting

### Issue: Hooks not executing

**Symptoms:** Hook methods are not called when entities are created/updated

**Solutions:**
1. Check that `EntityHookManager.waitForReady()` was called
2. Verify hook registration succeeded (check returned hook ID)
3. Ensure correct event type is used
4. Check for typos in decorator parameters

### Issue: Performance degradation

**Symptoms:** Entity operations are slower after hook migration

**Solutions:**
1. Use `EntityHookManager.getMetrics()` to identify slow hooks
2. Add filters to reduce unnecessary hook execution
3. Use async hooks only when necessary
4. Consider batch processing for multiple operations

### Issue: Hook conflicts

**Symptoms:** Multiple hooks interfering with each other

**Solutions:**
1. Use priorities to control execution order
2. Add filters to make hooks more specific
3. Use different event types for different concerns
4. Consolidate related logic into single hooks

### Issue: Testing difficulties

**Symptoms:** Hard to test hook logic in isolation

**Solutions:**
1. Extract hook logic into separate methods
2. Use dependency injection for test doubles
3. Test hooks through entity operations when needed
4. Use `EntityHookManager.clearAllHooks()` in test cleanup

## Summary

Migrating to Entity Lifecycle Hooks provides significant benefits for code organization, reusability, and maintainability. The migration process should be approached gradually, with thorough testing at each step. Start with simple hooks, ensure backward compatibility, and use the built-in monitoring features to maintain performance.

Remember to:
- Test thoroughly at each migration step
- Monitor performance metrics
- Have rollback strategies ready
- Document hook dependencies and behavior
- Use feature flags for gradual rollout

The hook system is designed to be backward-compatible, so you can migrate at your own pace while maintaining existing functionality.