# Entity Lifecycle Hooks System Documentation

## Overview

The Entity Lifecycle Hooks system provides a powerful reactive programming framework for the BunSane ECS architecture. It enables developers to register callbacks for entity creation, updates, deletions, and component modifications, allowing for clean separation of concerns and modular application design.

## Key Features

- **Reactive Programming**: Event-driven architecture for entity operations
- **Type Safety**: Full TypeScript support with compile-time validation
- **Performance Monitoring**: Built-in metrics collection and performance tracking
- **Async Support**: Promise-based asynchronous hook execution
- **Batch Processing**: Efficient handling of multiple events
- **Decorator Pattern**: Clean, declarative hook registration
- **Error Isolation**: Graceful failure handling with hook isolation
- **Priority System**: Configurable execution ordering
- **Filtering**: Conditional hook execution based on event properties

## Quick Start

### Basic Hook Registration

```typescript
import { EntityHookManager, EntityCreatedEvent } from "bunsane";

// Register a simple hook
const hookId = EntityHookManager.registerEntityHook("entity.created", (event: EntityCreatedEvent) => {
    console.log(`Entity ${event.getEntity().id} was created`);
});

// Hook is automatically executed when entities are created
const entity = Entity.Create();
await entity.save(); // Hook executes here
```

### Decorator-Based Registration

```typescript
import { EntityHook, ComponentHook } from "bunsane";
import { EntityCreatedEvent, ComponentAddedEvent } from "bunsane";

class AuditService {
    @EntityHook("entity.created")
    async handleEntityCreated(event: EntityCreatedEvent) {
        await this.logAuditEvent("entity_created", event.getEntity().id);
    }

    @ComponentHook("component.added")
    async handleComponentAdded(event: ComponentAddedEvent) {
        await this.logAuditEvent("component_added", {
            entityId: event.getEntity().id,
            componentType: event.getComponentType()
        });
    }

    private async logAuditEvent(type: string, data: any) {
        // Implementation for audit logging
    }
}

// Register decorated hooks
const auditService = new AuditService();
registerDecoratedHooks(auditService);
```

## Hook Types

### Entity Lifecycle Hooks

| Event Type | Description | Event Class |
|------------|-------------|-------------|
| `entity.created` | Fired when a new entity is created and saved | `EntityCreatedEvent` |
| `entity.updated` | Fired when an existing entity is modified and saved | `EntityUpdatedEvent` |
| `entity.deleted` | Fired when an entity is deleted | `EntityDeletedEvent` |

### Component Lifecycle Hooks

| Event Type | Description | Event Class |
|------------|-------------|-------------|
| `component.added` | Fired when a component is added to an entity | `ComponentAddedEvent` |
| `component.updated` | Fired when a component's data is modified | `ComponentUpdatedEvent` |
| `component.removed` | Fired when a component is removed from an entity | `ComponentRemovedEvent` |

## Advanced Features

### Asynchronous Hooks

```typescript
EntityHookManager.registerEntityHook("entity.created",
    async (event: EntityCreatedEvent) => {
        // Perform async operations
        await someAsyncOperation();
    },
    { async: true }
);
```

### Hook Prioritization

```typescript
// High priority hook (executes first)
EntityHookManager.registerEntityHook("entity.created",
    (event) => console.log("High priority"),
    { priority: 10 }
);

// Low priority hook (executes last)
EntityHookManager.registerEntityHook("entity.created",
    (event) => console.log("Low priority"),
    { priority: 1 }
);
```

### Conditional Execution with Filters

```typescript
EntityHookManager.registerEntityHook("entity.created",
    (event: EntityCreatedEvent) => {
        // Only execute for new entities
        console.log("New entity created!");
    },
    {
        filter: (event) => event instanceof EntityCreatedEvent && event.isNew
    }
);
```

### Timeout Handling

```typescript
EntityHookManager.registerEntityHook("entity.created",
    async (event: EntityCreatedEvent) => {
        // Hook that might take too long
        await slowOperation();
    },
    {
        async: true,
        timeout: 5000 // 5 second timeout
    }
);
```

### Batch Processing

```typescript
// Execute hooks for multiple events efficiently
const events = [
    new EntityCreatedEvent(entity1),
    new EntityCreatedEvent(entity2),
    new EntityUpdatedEvent(entity3)
];

await EntityHookManager.executeHooksBatch(events);
```

## Performance Monitoring

### Metrics Collection

```typescript
// Get global metrics
const globalMetrics = EntityHookManager.getMetrics();
console.log(`Total executions: ${globalMetrics.totalExecutions}`);
console.log(`Average execution time: ${globalMetrics.averageExecutionTime}ms`);

// Get event-specific metrics
const createdMetrics = EntityHookManager.getMetrics("entity.created");
console.log(`Entity created hooks executed: ${createdMetrics.totalExecutions}`);
```

### Performance Optimization Guidelines

- **Use async hooks sparingly**: Async hooks have higher overhead than sync hooks
- **Batch operations**: Use `executeHooksBatch()` for multiple events
- **Filter early**: Use filters to avoid unnecessary hook execution
- **Monitor performance**: Regularly check metrics for bottlenecks
- **Set timeouts**: Prevent hanging hooks from blocking the system

## Error Handling

### Hook Failure Isolation

```typescript
// Multiple hooks - one fails, others continue
EntityHookManager.registerEntityHook("entity.created", () => {
    throw new Error("This hook fails");
});

EntityHookManager.registerEntityHook("entity.created", () => {
    console.log("This hook still executes");
});
```

### Error Logging

All hook errors are automatically logged with detailed context:
- Hook ID and event type
- Execution time and error details
- Stack traces for debugging

## Integration with Application Lifecycle

The hook system integrates with the BunSane ApplicationLifecycle:

```typescript
// Wait for hook system to be ready
await EntityHookManager.waitForReady();

// Check if ready for registration
if (EntityHookManager.isReady()) {
    // Safe to register hooks
}
```

## Common Use Cases

### Audit Logging

```typescript
class AuditLogger {
    @EntityHook("entity.created")
    async logEntityCreation(event: EntityCreatedEvent) {
        await this.auditLog("CREATE", "entity", event.getEntity().id);
    }

    @EntityHook("entity.updated")
    async logEntityUpdate(event: EntityUpdatedEvent) {
        await this.auditLog("UPDATE", "entity", event.getEntity().id);
    }

    @EntityHook("entity.deleted")
    async logEntityDeletion(event: EntityDeletedEvent) {
        await this.auditLog("DELETE", "entity", event.getEntity().id);
    }

    private async auditLog(action: string, type: string, id: string) {
        // Implementation for audit logging
    }
}
```

### Cache Invalidation

```typescript
class CacheManager {
    @EntityHook("entity.updated")
    async invalidateEntityCache(event: EntityUpdatedEvent) {
        const entityId = event.getEntity().id;
        await this.cache.del(`entity:${entityId}`);
    }

    @ComponentHook("component.updated")
    async invalidateComponentCache(event: ComponentUpdatedEvent) {
        const entityId = event.getEntity().id;
        const componentType = event.getComponentType();
        await this.cache.del(`component:${entityId}:${componentType}`);
    }

    private cache: RedisClient;
}
```

### Business Rule Validation

```typescript
class BusinessRuleValidator {
    @EntityHook("entity.updated")
    async validateBusinessRules(event: EntityUpdatedEvent) {
        const entity = event.getEntity();

        // Validate business rules
        if (await this.hasInvalidState(entity)) {
            throw new Error("Business rule violation");
        }
    }

    private async hasInvalidState(entity: Entity): Promise<boolean> {
        // Implementation of business rule validation
        return false;
    }
}
```

### Search Index Updates

```typescript
class SearchIndexer {
    @EntityHook("entity.created")
    async indexNewEntity(event: EntityCreatedEvent) {
        await this.updateSearchIndex(event.getEntity());
    }

    @EntityHook("entity.updated")
    async reindexEntity(event: EntityUpdatedEvent) {
        await this.updateSearchIndex(event.getEntity());
    }

    @EntityHook("entity.deleted")
    async removeFromIndex(event: EntityDeletedEvent) {
        await this.searchIndex.delete(event.getEntity().id);
    }

    private async updateSearchIndex(entity: Entity) {
        // Implementation for search indexing
    }
}
```

## Best Practices

### 1. Hook Registration Timing

```typescript
// Register hooks after application is ready
await app.waitForAppReady();
await EntityHookManager.waitForReady();

// Now safe to register hooks
registerDecoratedHooks(myService);
```

### 2. Error Handling

```typescript
// Always handle errors in hooks
EntityHookManager.registerEntityHook("entity.created",
    async (event: EntityCreatedEvent) => {
        try {
            await riskyOperation();
        } catch (error) {
            logger.error("Hook execution failed:", error);
            // Don't re-throw - let other hooks continue
        }
    },
    { async: true }
);
```

### 3. Performance Considerations

```typescript
// Use filters to avoid unnecessary execution
EntityHookManager.registerEntityHook("entity.updated",
    (event: EntityUpdatedEvent) => {
        // Only process if specific component changed
        if (event.getChangedComponents().includes("ImportantComponent")) {
            // Heavy processing here
        }
    },
    {
        filter: (event) => event instanceof EntityUpdatedEvent &&
                          event.getChangedComponents().includes("ImportantComponent")
    }
);
```

### 4. Resource Cleanup

```typescript
// Store hook IDs for cleanup if needed
const hookIds: string[] = [];

hookIds.push(EntityHookManager.registerEntityHook("entity.created", handler1));
hookIds.push(EntityHookManager.registerEntityHook("entity.updated", handler2));

// Cleanup when needed
hookIds.forEach(id => EntityHookManager.removeHook(id));
```

## Migration Guide

### From Manual Event Handling

```typescript
// Before: Manual event handling
entity.save().then(() => {
    // Custom logic here
});

// After: Hook-based approach
EntityHookManager.registerEntityHook("entity.created", (event) => {
    // Same logic, but automatically executed
});
```

### From Service Methods

```typescript
// Before: Calling service methods manually
await entity.save();
await auditService.logCreation(entity);

// After: Automatic hook execution
await entity.save(); // Audit hook executes automatically
```

## API Reference

### EntityHookManager

#### Methods

- `registerEntityHook(eventType, callback, options?)` - Register entity lifecycle hook
- `registerComponentHook(eventType, callback, options?)` - Register component lifecycle hook
- `registerLifecycleHook(callback, options?)` - Register hook for all lifecycle events
- `removeHook(hookId)` - Remove hook by ID
- `executeHooks(event)` - Execute hooks for single event
- `executeHooksBatch(events)` - Execute hooks for multiple events
- `getHookCount(eventType?)` - Get number of registered hooks
- `getMetrics(eventType?)` - Get performance metrics
- `resetMetrics(eventType?)` - Reset performance metrics
- `clearAllHooks()` - Remove all hooks
- `waitForReady()` - Wait for system to be ready
- `isReady()` - Check if system is ready

#### Types

- `EntityHookCallback<T>` - Callback type for entity events
- `ComponentHookCallback<T>` - Callback type for component events
- `LifecycleHookCallback` - Callback type for any lifecycle event
- `HookOptions` - Configuration options for hooks

### Decorators

- `@EntityHook(eventType)` - Decorate method as entity lifecycle hook
- `@ComponentHook(eventType)` - Decorate method as component lifecycle hook
- `@LifecycleHook()` - Decorate method as general lifecycle hook

### Events

- `EntityCreatedEvent` - Entity creation event
- `EntityUpdatedEvent` - Entity update event
- `EntityDeletedEvent` - Entity deletion event
- `ComponentAddedEvent` - Component addition event
- `ComponentUpdatedEvent` - Component update event
- `ComponentRemovedEvent` - Component removal event

## Troubleshooting

### Common Issues

1. **Hooks not executing**
   - Ensure `EntityHookManager.waitForReady()` is called before registration
   - Check that the correct event type is used
   - Verify hook registration succeeded (returns hook ID)

2. **Performance issues**
   - Use `getMetrics()` to identify slow hooks
   - Consider using filters to reduce execution
   - Use batch processing for multiple events

3. **Memory leaks**
   - Always remove hooks when no longer needed
   - Use `clearAllHooks()` in tests
   - Avoid capturing large objects in hook closures

4. **Async hook timeouts**
   - Set appropriate timeout values in hook options
   - Handle timeout errors gracefully
   - Consider breaking long operations into smaller steps

### Debug Logging

Enable detailed logging to troubleshoot issues:

```typescript
// All hook operations are logged with context
// Look for log messages with scope: "EntityHookManager"
```

### Testing

```typescript
// Clear hooks between tests
beforeEach(() => {
    EntityHookManager.clearAllHooks();
    EntityHookManager.resetMetrics();
});
```

This documentation provides comprehensive guidance for using the Entity Lifecycle Hooks system effectively in BunSane applications.