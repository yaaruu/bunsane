# Entity Lifecycle Hooks

Entity Lifecycle Hooks provide a powerful way to execute business logic at specific points during an entity's lifecycle. They enable you to react to entity creation, updates, and deletion, as well as component changes, making it easy to implement cross-cutting concerns like auditing, notifications, and data validation.

## 🎯 What are Lifecycle Hooks?

Lifecycle hooks are functions that automatically execute when specific events occur in an entity's lifecycle. They allow you to:

- **Validate data** before saving
- **Send notifications** when entities change
- **Update related entities** automatically
- **Log audit trails** for compliance
- **Enforce business rules** across your application
- **Trigger background tasks** based on entity changes

### Hook Types

- **Entity Hooks**: Triggered by entity lifecycle events (create, update, delete)
- **Component Hooks**: Triggered by component changes on entities
- **Component-Targeted Hooks**: Entity hooks with fine-grained component-based filtering
- **Lifecycle Hooks**: Hooks that listen to all lifecycle events

## 🏗️ Basic Hook Implementation

### Entity Lifecycle Hooks

```typescript
import { EntityHook, registerDecoratedHooks } from 'bunsane/decorators/EntityHooks';
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent } from 'bunsane/events/EntityLifecycleEvents';

export class UserService {
  @EntityHook('entity.created')
  async onUserCreated(event: EntityCreatedEvent) {
    console.log('New user created:', event.getEntity().id);

    // Send welcome email
    await this.sendWelcomeEmail(event.getEntity());

    // Create user stats
    // Implementation here...
  }

  @EntityHook('entity.updated')
  async onUserUpdated(event: EntityUpdatedEvent) {
    console.log('User updated:', event.getEntity().id);

    // Log the change
    await this.logUserChange(event);
  }

  @EntityHook('entity.deleted')
  async onUserDeleted(event: EntityDeletedEvent) {
    console.log('User deleted:', event.getEntity().id);

    // Clean up related data
    await this.cleanupUserData(event.getEntity().id);
  }

  // Register hooks when service is instantiated
  constructor() {
    registerDecoratedHooks(this);
  }
}
```

### Component Lifecycle Hooks

```typescript
import { ComponentHook } from 'bunsane/decorators/EntityHooks';
import { ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from 'bunsane/events/EntityLifecycleEvents';

export class UserService {
  @ComponentHook('component.added')
  async onComponentAdded(event: ComponentAddedEvent) {
    if (event.getComponentType() === 'EmailComponent') {
      console.log('Email component added to entity:', event.getEntity().id);

      // Validate email format
      const emailComponent = event.getComponent();
      if (!this.isValidEmail(emailComponent.value)) {
        throw new Error('Invalid email format');
      }
    }
  }

  @ComponentHook('component.updated')
  async onComponentUpdated(event: ComponentUpdatedEvent) {
    if (event.getComponentType() === 'EmailComponent') {
      console.log('Email component updated');

      // Check for email changes
      const oldEmail = event.getOldData()?.value;
      const newEmail = event.getNewData()?.value;

      if (oldEmail !== newEmail) {
        // Send email verification
        await this.sendEmailVerification(newEmail);
      }
    }
  }

  @ComponentHook('component.removed')
  async onComponentRemoved(event: ComponentRemovedEvent) {
    if (event.getComponentType() === 'ProfileComponent') {
      console.log('Profile component removed');

      // Handle profile removal
      await this.handleProfileRemoval(event.getEntity().id);
    }
  }
}
```

## 🎭 Component-Targeted Hooks

### Archetype-Targeted Hooks

```typescript
import { ComponentTargetHook } from 'bunsane/decorators/EntityHooks';

export class ContentService {
  @ComponentTargetHook('entity.created', {
    includeComponents: [BlogPost, AuthorComponent]
  })
  async onBlogPostCreated(event: EntityCreatedEvent) {
    console.log('New blog post created');

    // Extract post data
    const postData = await event.getEntity().get(BlogPost);
    const authorData = await event.getEntity().get(AuthorComponent);

    // Notify followers
    await this.notifyFollowers(authorData.authorId, {
      type: 'new_post',
      postId: event.getEntity().id,
      title: postData.title
    });

    // Update author stats
    await this.incrementAuthorPostCount(authorData.authorId);
  }

  @ComponentTargetHook('entity.updated', {
    includeComponents: [PublishedStatus],
    requireAllIncluded: true
  })
  async onContentPublished(event: EntityUpdatedEvent) {
    const entity = event.getEntity();

    // Check if this is a publish event
    if (entity.has(PublishedStatus)) {
      const status = await entity.get(PublishedStatus);

      if (status.isPublished && !status.wasPublished) {
        // Content was just published
        await this.onContentPublished(entity);
      }
    }
  }
}
```

### Conditional Component Targeting

```typescript
export class NotificationService {
  @ComponentTargetHook('entity.created', {
    includeComponents: [UserProfile],
    excludeComponents: [GuestUser]
  })
  async onRegularUserCreated(event: EntityCreatedEvent) {
    // Only triggered for regular users, not guests
    await this.sendWelcomeEmail(event.getEntity());
  }

  @ComponentTargetHook('entity.updated', {
    includeComponents: [UserProfile, EmailComponent],
    requireAllIncluded: true
  })
  async onUserEmailChanged(event: EntityUpdatedEvent) {
    // Only triggered when both UserProfile and EmailComponent are present
    const profile = await event.getEntity().get(UserProfile);
    const email = await event.getEntity().get(EmailComponent);

    await this.sendEmailChangeNotification(profile.email, email.value);
  }
}
```

## 🔧 Hook Configuration and Options

### Hook Priority and Execution Order

```typescript
export class OrderedHookService {
  @EntityHook('entity.created', { priority: 1 })
  async validateEntity(event: EntityCreatedEvent) {
    // High priority validation (executes first)
    if (!this.isValidEntity(event.getEntity())) {
      throw new Error('Entity validation failed');
    }
  }

  @EntityHook('entity.created', { priority: 10 })
  async sendWelcomeEmail(event: EntityCreatedEvent) {
    // Lower priority - runs after validation
    await this.sendEmail(event.getEntity());
  }

  @EntityHook('entity.created', { priority: 5 })
  async createDefaultComponents(event: EntityCreatedEvent) {
    // Medium priority
    await this.addDefaultComponents(event.getEntity());
  }
}
```

### Async Hooks and Timeouts

```typescript
export class AsyncHookService {
  @EntityHook('entity.created', { async: true, timeout: 5000 })
  async sendWelcomeEmailAsync(event: EntityCreatedEvent) {
    // This hook runs asynchronously with 5 second timeout
    try {
      await this.sendWelcomeEmail(event.getEntity());
    } catch (error) {
      console.error('Failed to send welcome email:', error);
    }
  }

  @ComponentHook('component.updated', { timeout: 2000 })
  async validateComponentUpdate(event: ComponentUpdatedEvent) {
    // 2 second timeout for validation
    const isValid = await this.validateUpdate(event);
    if (!isValid) {
      throw new Error('Component update validation failed');
    }
  }
}
```

### Hook Filtering

```typescript
export class FilteredHookService {
  @EntityHook('entity.created', {
    filter: (event) => event.getEntity().has(PremiumFeature)
  })
  async onPremiumUserCreated(event: EntityCreatedEvent) {
    // Only executes for premium users
    await this.setupPremiumFeatures(event.getEntity());
  }

  @ComponentHook('component.updated', {
    filter: (event) => {
      const oldData = event.getOldData();
      const newData = event.getNewData();
      return oldData?.status !== newData?.status; // Only status changes
    }
  })
  async onStatusChanged(event: ComponentUpdatedEvent) {
    // Only executes when status actually changes
    await this.handleStatusChange(event);
  }
}
```

## 🎯 Real-World Examples

### Audit Logging (from examples/hooks/audit-logger.ts)

```typescript
import { EntityHook, ComponentHook } from 'bunsane/decorators/EntityHooks';

export class AuditLogger {
  @EntityHook("entity.created")
  async handleEntityCreated(event: EntityCreatedEvent) {
    const entry = {
      id: this.generateId(),
      timestamp: new Date(),
      action: 'create',
      entityId: event.getEntity().id,
      entityType: this.getEntityType(event.getEntity()),
      userId: this.getCurrentUserId(),
      newData: await this.extractEntityData(event.getEntity())
    };

    await this.storeLogEntry(entry);
  }

  @EntityHook("entity.updated")
  async handleEntityUpdated(event: EntityUpdatedEvent) {
    const entry = {
      id: this.generateId(),
      timestamp: new Date(),
      action: 'update',
      entityId: event.getEntity().id,
      changedComponents: event.getChangedComponents()
    };

    await this.storeLogEntry(entry);
  }

  @ComponentHook("component.added")
  async handleComponentAdded(event: ComponentAddedEvent) {
    const entry = {
      id: this.generateId(),
      action: 'add_component',
      entityId: event.getEntity().id,
      componentType: event.getComponentType(),
      newData: event.getComponent().data()
    };

    await this.storeLogEntry(entry);
  }
}
```

### User Service Hooks (from UserService.ts)

```typescript
export class UserService extends BaseService {
  @ComponentTargetHook("entity.created", {
    includeComponents: [UserTag, EmailComponent]
  })
  async onUserCreate(event: EntityCreatedEvent) {
    const emailComp = await event.entity.get(EmailComponent);
    logger.info(`New user created with email: ${emailComp?.value}`);
    // Here you could add logic to send a welcome email, etc.
  }
}
```

## 🔄 Hook Registration and Management

### Automatic Hook Registration

```typescript
import { registerDecoratedHooks } from 'bunsane/decorators/EntityHooks';

export class MyService {
  @EntityHook('entity.created')
  async handleCreation(event: EntityCreatedEvent) {
    // Hook implementation
  }

  constructor() {
    // Automatically register all decorated hooks
    registerDecoratedHooks(this);
  }
}
```

### Manual Hook Registration

```typescript
import EntityHookManager from 'bunsane/core/EntityHookManager';

class CustomNotificationService {
  async sendNotification(entityId: string, message: string) {
    // Implementation
  }

  registerHooks() {
    // Register entity hooks
    EntityHookManager.registerEntityHook(
      'entity.created',
      async (event: EntityCreatedEvent) => {
        if (event.getEntity().has(UserProfile)) {
          await this.sendNotification(
            event.getEntity().id,
            'Welcome to our platform!'
          );
        }
      },
      { priority: 5 }
    );

    // Register component hooks
    EntityHookManager.registerComponentHook(
      'component.updated',
      async (event: ComponentUpdatedEvent) => {
        if (event.getComponentType() === 'UserProfile') {
          await this.sendNotification(
            event.getEntity().id,
            'Your profile has been updated'
          );
        }
      }
    );
  }
}
```

## 🎯 Advanced Hook Patterns

### Batch Event Processing

```typescript
export class BatchProcessor {
  private eventBuffer: LifecycleEvent[] = [];
  private processingTimer: NodeJS.Timeout | null = null;

  @EntityHook('entity.created', { async: true })
  async bufferEvent(event: EntityCreatedEvent) {
    this.eventBuffer.push(event);

    // Process in batches of 10 or after 5 seconds
    if (this.eventBuffer.length >= 10) {
      await this.processBatch();
    } else if (!this.processingTimer) {
      this.processingTimer = setTimeout(() => this.processBatch(), 5000);
    }
  }

  private async processBatch() {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    // Process events in batch
    await this.bulkProcessEvents(events);
  }
}
```

### Saga Pattern with Hooks

```typescript
export class OrderSagaService {
  private sagas = new Map<string, SagaState>();

  @EntityHook('entity.created')
  async startOrderSaga(event: EntityCreatedEvent) {
    if (event.getEntity().has(OrderComponent)) {
      const sagaId = `order-${event.getEntity().id}`;

      this.sagas.set(sagaId, {
        id: sagaId,
        steps: ['validate', 'charge', 'ship', 'complete'],
        currentStep: 0,
        entityId: event.getEntity().id
      });

      await this.executeSagaStep(sagaId);
    }
  }

  @EntityHook('entity.updated')
  async continueOrderSaga(event: EntityUpdatedEvent) {
    const sagaId = `order-${event.getEntity().id}`;
    const saga = this.sagas.get(sagaId);

    if (saga && saga.currentStep < saga.steps.length) {
      await this.executeSagaStep(sagaId);
    }
  }

  private async executeSagaStep(sagaId: string) {
    const saga = this.sagas.get(sagaId);
    if (!saga) return;

    const step = saga.steps[saga.currentStep];
    try {
      await this.executeStep(step, saga.entityId);
      saga.currentStep++;

      if (saga.currentStep >= saga.steps.length) {
        // Saga completed
        this.sagas.delete(sagaId);
      }
    } catch (error) {
      // Saga failed - execute compensation
      await this.compensateSaga(saga);
      this.sagas.delete(sagaId);
    }
  }
}
```

## ⚡ Performance Optimization

### Efficient Hook Execution

```typescript
export class EfficientHookService {
  private cache = new Map<string, any>();

  @EntityHook('entity.created')
  async onEntityCreated(event: EntityCreatedEvent) {
    // Cache expensive operations
    const cacheKey = `entity:${event.getEntity().id}`;
    if (this.cache.has(cacheKey)) {
      return; // Already processed
    }

    // Perform expensive operation
    await this.expensiveOperation(event.getEntity());

    // Cache result
    this.cache.set(cacheKey, true);

    // Clean up cache periodically
    if (this.cache.size > 1000) {
      this.clearOldCacheEntries();
    }
  }

  @ComponentTargetHook('entity.updated', {
    includeComponents: [FrequentlyUpdatedComponent],
    requireAllIncluded: true
  })
  async onFrequentUpdate(event: EntityUpdatedEvent) {
    // Use component targeting to avoid unnecessary executions
    await this.handleFrequentUpdate(event.getEntity());
  }
}
```

### Hook Metrics and Monitoring

```typescript
export class MonitoredHookService {
  private metrics = new Map<string, number[]>();

  @EntityHook('entity.created')
  async monitoredHook(event: EntityCreatedEvent) {
    const startTime = performance.now();

    try {
      await this.doWork(event);
    } finally {
      const duration = performance.now() - startTime;
      this.recordMetric('entity.created', duration);
    }
  }

  private recordMetric(hookName: string, duration: number) {
    if (!this.metrics.has(hookName)) {
      this.metrics.set(hookName, []);
    }

    const timings = this.metrics.get(hookName)!;
    timings.push(duration);

    // Keep only last 100 measurements
    if (timings.length > 100) {
      timings.shift();
    }
  }

  getMetrics() {
    const result: Record<string, any> = {};

    for (const [hookName, timings] of this.metrics) {
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      const max = Math.max(...timings);
      const min = Math.min(...timings);

      result[hookName] = { avg, max, min, count: timings.length };
    }

    return result;
  }
}
```

## 🔧 Best Practices

### Error Handling in Hooks

```typescript
export class RobustHookService {
  @EntityHook('entity.created')
  async onEntityCreated(event: EntityCreatedEvent) {
    try {
      await this.processEntityCreation(event);
    } catch (error) {
      // Log error but don't prevent entity creation
      console.error('Hook processing failed:', error);

      // Optionally send to error tracking service
      await this.reportError(error, {
        hook: 'entity.created',
        entityId: event.getEntity().id
      });
    }
  }

  @EntityHook('entity.created')
  async criticalValidation(event: EntityCreatedEvent) {
    // For critical validations, let errors propagate
    // This will prevent entity creation if validation fails
    if (!this.isValidEntity(event.getEntity())) {
      throw new Error('Critical validation failed - entity creation blocked');
    }
  }
}
```

### Hook Testing

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { Entity, EntityCreatedEvent } from 'bunsane';

describe('User Creation Hooks', () => {
  let hookService: UserService;
  let mockEmailService: any;

  beforeEach(() => {
    mockEmailService = {
      sendWelcomeEmail: jest.fn(),
      sendVerificationEmail: jest.fn()
    };

    hookService = new UserService(mockEmailService);
  });

  test('should send welcome email on user creation', async () => {
    // Create test entity
    const userEntity = UserArcheType.fill({
      userProfile: { name: 'Test User', email: 'test@example.com' }
    }).createEntity();

    // Create event
    const event = new EntityCreatedEvent(userEntity);

    // Trigger hook manually for testing
    await hookService.onUserCreated(event);

    // Verify email was sent
    expect(mockEmailService.sendWelcomeEmail).toHaveBeenCalledWith(
      'test@example.com'
    );
  });
});
```

## 🚀 Event Types Reference

### Entity Events

- **`entity.created`**: Fired when an entity is created (first save)
- **`entity.updated`**: Fired when an entity is updated (subsequent saves)
- **`entity.deleted`**: Fired when an entity is deleted

### Component Events

- **`component.added`**: Fired when a component is added to an entity
- **`component.updated`**: Fired when a component data is updated
- **`component.removed`**: Fired when a component is removed from an entity

### Event Properties

All events provide:
- `eventType`: String identifier of the event type
- `timestamp`: When the event occurred
- `entity`: The entity associated with the event

Entity events additionally provide:
- `isNew`: Boolean indicating if this is a new entity

Component events additionally provide:
- `component`: The component instance
- `componentType`: String identifier of the component type

## 🚀 What's Next?

Now that you understand Lifecycle Hooks, let's explore:

- **[Services](services.md)** - Using hooks in services
- **[Query System](query.md)** - Advanced querying with hooks
- **[API Reference](../api/)** - Complete hook API documentation

---

*Ready to add dynamic behavior to your entities? Let's look at [Advanced Features](../advanced/) next!* 🚀