# Entity Lifecycle Hooks Examples

This directory contains example implementations of common use cases for the Entity Lifecycle Hooks system. Each example demonstrates best practices for hook implementation, error handling, and performance optimization.

## Examples Overview

### 1. Audit Logging (`audit-logger.ts`)
Demonstrates comprehensive audit logging for entity lifecycle events with different storage backends.

### 2. Cache Management (`cache-manager.ts`)
Shows how to implement intelligent cache invalidation and population using entity hooks.

### 3. Search Indexing (`search-indexer.ts`)
Illustrates real-time search index updates for entities and components.

### 4. Business Rules (`business-rules.ts`)
Examples of business rule validation and enforcement using component hooks.

### 5. Notifications (`notification-service.ts`)
Demonstrates event-driven notification systems for user actions.

### 6. Data Synchronization (`data-sync.ts`)
Shows cross-system data synchronization patterns.

### 7. Metrics Collection (`metrics-collector.ts`)
Performance monitoring and metrics collection for entity operations.

### 8. Security (`security-hooks.ts`)
Security-related hooks for access control and data protection.

## Usage

Each example can be used as a starting point for your own implementations. Import the example classes and register them with the hook system:

```typescript
import { AuditLogger } from "./examples/hooks/audit-logger";
import { registerDecoratedHooks } from "bunsane";

// Register example hooks
const auditLogger = new AuditLogger();
registerDecoratedHooks(auditLogger);
```

## Best Practices Demonstrated

- **Error Isolation**: Each hook handles its own errors without affecting others
- **Performance Optimization**: Use of filters, batching, and async operations
- **Resource Management**: Proper cleanup and resource handling
- **Type Safety**: Full TypeScript support with proper typing
- **Monitoring**: Built-in metrics and logging
- **Configuration**: Environment-based configuration
- **Testing**: Testable hook implementations

## Common Patterns

### Conditional Execution
```typescript
@EntityHook("entity.created")
async handleEntityCreated(event: EntityCreatedEvent) {
    // Only process specific entity types
    if (!event.getEntity().has(TargetComponent)) return;

    // Process the entity
    await this.processEntity(event.getEntity());
}
```

### Batch Processing
```typescript
private pendingEvents: EntityCreatedEvent[] = [];

@EntityHook("entity.created")
handleEntityCreated(event: EntityCreatedEvent) {
    this.pendingEvents.push(event);

    // Process in batches to improve performance
    if (this.pendingEvents.length >= 10) {
        this.processBatch();
    }
}
```

### Error Handling
```typescript
@EntityHook("entity.created")
async handleEntityCreated(event: EntityCreatedEvent) {
    try {
        await this.unreliableOperation();
    } catch (error) {
        // Log error but don't throw - preserve other hooks
        this.logger.error("Hook execution failed:", error);
    }
}
```

### Resource Cleanup
```typescript
@EntityHook("entity.deleted")
handleEntityDeleted(event: EntityDeletedEvent) {
    // Clean up resources associated with the entity
    this.cache.delete(event.getEntity().id);
    this.pendingOperations.delete(event.getEntity().id);
}
```

## Configuration

Most examples support configuration through environment variables or constructor parameters:

```typescript
// Environment-based configuration
const auditLogger = new AuditLogger({
    enabled: process.env.AUDIT_ENABLED === 'true',
    level: process.env.AUDIT_LEVEL || 'info',
    storage: process.env.AUDIT_STORAGE || 'database'
});
```

## Testing

Each example includes testing patterns:

```typescript
describe("AuditLogger", () => {
    let auditLogger: AuditLogger;

    beforeEach(() => {
        auditLogger = new AuditLogger();
        registerDecoratedHooks(auditLogger);
    });

    afterEach(() => {
        EntityHookManager.clearAllHooks();
    });

    test("should log entity creation", async () => {
        const entity = Entity.Create();
        await entity.save();

        // Verify audit log was created
        expect(auditLogger.getLogs()).toContain(/* expected log entry */);
    });
});
```

## Performance Considerations

Examples demonstrate performance optimization techniques:

- **Filtering**: Reduce unnecessary hook execution
- **Batching**: Group operations for efficiency
- **Async Processing**: Use async hooks for I/O operations
- **Caching**: Cache frequently accessed data
- **Timeouts**: Prevent hanging operations

## Integration

Examples show how to integrate with existing systems:

- **Database**: Entity persistence and queries
- **Cache**: Redis, Memcached, or in-memory caching
- **Search**: Elasticsearch, Algolia, or custom search
- **Queues**: Background job processing
- **Monitoring**: Metrics collection and alerting
- **Logging**: Structured logging with context

## Customization

Examples are designed to be easily customizable:

```typescript
// Extend base examples
class CustomAuditLogger extends AuditLogger {
    @EntityHook("entity.updated")
    async handleCustomUpdate(event: EntityUpdatedEvent) {
        // Custom logic
        await super.handleEntityUpdated(event);

        // Additional processing
        await this.customProcessing(event);
    }
}
```

## Monitoring

Examples include monitoring and health checks:

```typescript
// Health check endpoint
app.get('/health/hooks', async (req, res) => {
    const metrics = EntityHookManager.getMetrics();
    const health = {
        status: metrics.errorCount > 10 ? 'unhealthy' : 'healthy',
        metrics,
        timestamp: new Date().toISOString()
    };

    res.json(health);
});
```

## Troubleshooting

Common issues and solutions:

1. **Hooks not executing**: Check `EntityHookManager.waitForReady()`
2. **Performance issues**: Use `EntityHookManager.getMetrics()` to identify bottlenecks
3. **Memory leaks**: Ensure proper cleanup in deletion hooks
4. **Error propagation**: Handle errors gracefully to prevent hook isolation issues

## Contributing

When adding new examples:

1. Follow the established patterns and best practices
2. Include comprehensive error handling
3. Add performance optimizations
4. Provide configuration options
5. Include tests and documentation
6. Demonstrate integration patterns

## Related Documentation

- [Hooks Documentation](../HOOKS_DOCUMENTATION.md)
- [Migration Guide](../HOOKS_MIGRATION_GUIDE.md)
- [Performance Guide](../HOOKS_PERFORMANCE_GUIDE.md)
- [API Reference](../HOOKS_DOCUMENTATION.md#api-reference)