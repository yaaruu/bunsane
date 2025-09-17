# Hooks API Reference

This page provides detailed API reference for BunSane's hook system and lifecycle events.

## 🪝 EntityHookManager Class

The `EntityHookManager` class manages lifecycle hooks for entities and components.

### Static Methods

#### `EntityHookManager.on(event, handler)`

Registers an event handler.

```typescript
static on(event: string, handler: HookHandler): void
```

**Parameters:**
- `event`: String - Event name
- `handler`: HookHandler - Event handler function

**Example:**
```typescript
EntityHookManager.on('entity:created', async (entity) => {
  console.log('Entity created:', entity.id);
});
```

#### `EntityHookManager.off(event, handler)`

Removes an event handler.

```typescript
static off(event: string, handler: HookHandler): void
```

**Parameters:**
- `event`: String - Event name
- `handler`: HookHandler - Event handler function

**Example:**
```typescript
const handler = (entity) => console.log('Entity created');
EntityHookManager.on('entity:created', handler);
// Later...
EntityHookManager.off('entity:created', handler);
```

#### `EntityHookManager.emit(event, data)`

Emits an event to all registered handlers.

```typescript
static async emit(event: string, data: any): Promise<void>
```

**Parameters:**
- `event`: String - Event name
- `data`: Any - Event data

**Returns:** `Promise<void>`

**Example:**
```typescript
await EntityHookManager.emit('custom:event', { message: 'Hello' });
```

#### `EntityHookManager.clear(event)`

Clears all handlers for an event.

```typescript
static clear(event?: string): void
```

**Parameters:**
- `event` (optional): String - Event name, clears all if not specified

**Example:**
```typescript
// Clear all handlers for entity:created
EntityHookManager.clear('entity:created');

// Clear all handlers
EntityHookManager.clear();
```

## 🎣 Hook Types

### HookHandler

Function signature for hook handlers.

```typescript
type HookHandler = (data: any, context?: HookContext) => Promise<void> | void;
```

### HookContext

Context information passed to hook handlers.

```typescript
interface HookContext {
  userId?: string;
  requestId?: string;
  timestamp: Date;
  source?: string;
}
```

## 📋 Entity Lifecycle Events

### Entity Events

#### `entity:creating`

Fired before an entity is created.

```typescript
EntityHookManager.on('entity:creating', async (entity: Entity) => {
  // Validate entity data
  // Set default values
  // Generate additional data
});
```

#### `entity:created`

Fired after an entity is created.

```typescript
EntityHookManager.on('entity:created', async (entity: Entity) => {
  // Send notifications
  // Update caches
  // Log creation
  console.log(`Entity ${entity.id} created`);
});
```

#### `entity:saving`

Fired before an entity is saved.

```typescript
EntityHookManager.on('entity:saving', async (entity: Entity) => {
  // Validate data
  // Update timestamps
  entity.set(TimestampComponent, { updatedAt: new Date() });
});
```

#### `entity:saved`

Fired after an entity is saved.

```typescript
EntityHookManager.on('entity:saved', async (entity: Entity) => {
  // Update search indexes
  // Send real-time updates
  // Trigger background jobs
});
```

#### `entity:updating`

Fired before an entity is updated.

```typescript
EntityHookManager.on('entity:updating', async (entity: Entity) => {
  // Validate update permissions
  // Create audit trail
  // Backup old data
});
```

#### `entity:updated`

Fired after an entity is updated.

```typescript
EntityHookManager.on('entity:updated', async (entity: Entity) => {
  // Send notifications
  // Update caches
  // Log changes
});
```

#### `entity:deleting`

Fired before an entity is deleted.

```typescript
EntityHookManager.on('entity:deleting', async (entity: Entity) => {
  // Check deletion permissions
  // Create backup
  // Cascade delete related data
});
```

#### `entity:deleted`

Fired after an entity is deleted.

```typescript
EntityHookManager.on('entity:deleted', async (entity: Entity) => {
  // Clean up related data
  // Update caches
  // Send notifications
});
```

### Component Events

#### `component:attaching`

Fired before a component is attached to an entity.

```typescript
EntityHookManager.on('component:attaching', async (data: {
  entity: Entity;
  component: BaseComponent;
  componentType: string;
}) => {
  // Validate component compatibility
  // Set up component relationships
});
```

#### `component:attached`

Fired after a component is attached to an entity.

```typescript
EntityHookManager.on('component:attached', async (data: {
  entity: Entity;
  component: BaseComponent;
  componentType: string;
}) => {
  // Initialize component data
  // Update entity state
});
```

#### `component:detaching`

Fired before a component is detached from an entity.

```typescript
EntityHookManager.on('component:detaching', async (data: {
  entity: Entity;
  component: BaseComponent;
  componentType: string;
}) => {
  // Clean up component resources
  // Update relationships
});
```

#### `component:detached`

Fired after a component is detached from an entity.

```typescript
EntityHookManager.on('component:detached', async (data: {
  entity: Entity;
  component: BaseComponent;
  componentType: string;
}) => {
  // Update caches
  // Send notifications
});
```

## 🔧 Component Hooks

### @Hook Decorator

Marks a method as a component hook.

```typescript
@Hook(event: string): MethodDecorator
```

**Parameters:**
- `event`: String - Hook event name

**Example:**
```typescript
@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';

  @Hook('component:attached')
  async onAttached(entity: Entity): Promise<void> {
    console.log(`UserProfile attached to entity ${entity.id}`);
  }

  @Hook('component:detaching')
  async onDetaching(entity: Entity): Promise<void> {
    console.log(`UserProfile detaching from entity ${entity.id}`);
  }
}
```

### Built-in Component Hooks

```typescript
@Component
export class AuditableComponent extends BaseComponent {
  @CompData()
  createdAt: Date = new Date();

  @CompData()
  updatedAt: Date = new Date();

  @CompData()
  createdBy: string = '';

  @CompData()
  updatedBy: string = '';

  @Hook('component:attaching')
  async setCreationData(entity: Entity): Promise<void> {
    this.createdAt = new Date();
    this.createdBy = RequestContext.getCurrentUser()?.id || 'system';
  }

  @Hook('component:saving')
  async setUpdateData(entity: Entity): Promise<void> {
    this.updatedAt = new Date();
    this.updatedBy = RequestContext.getCurrentUser()?.id || 'system';
  }
}
```

## 🎯 Custom Hooks

### Creating Custom Events

```typescript
// Define custom event types
export const CUSTOM_EVENTS = {
  USER_REGISTERED: 'user:registered',
  ORDER_COMPLETED: 'order:completed',
  PAYMENT_FAILED: 'payment:failed'
} as const;

// Emit custom events
export class UserService extends BaseService {
  async registerUser(userData: UserData): Promise<Entity> {
    const user = Entity.Create();
    user.add(UserProfile, userData);
    await user.save();

    // Emit custom event
    await EntityHookManager.emit(CUSTOM_EVENTS.USER_REGISTERED, {
      userId: user.id,
      email: userData.email,
      timestamp: new Date()
    });

    return user;
  }
}
```

### Handling Custom Events

```typescript
// Handle custom events
EntityHookManager.on(CUSTOM_EVENTS.USER_REGISTERED, async (data) => {
  console.log('New user registered:', data.email);

  // Send welcome email
  await emailService.sendWelcomeEmail(data.email);

  // Create user preferences
  const user = await Entity.FindById(data.userId);
  if (user) {
    user.add(UserPreferences, {
      theme: 'light',
      notifications: true
    });
    await user.save();
  }
});
```

## 🔄 Async Hook Patterns

### Sequential Processing

```typescript
EntityHookManager.on('entity:saving', async (entity) => {
  // Step 1: Validate data
  await validateEntityData(entity);

  // Step 2: Update timestamps
  entity.set(TimestampComponent, { updatedAt: new Date() });

  // Step 3: Generate audit trail
  await createAuditEntry(entity);
});
```

### Parallel Processing

```typescript
EntityHookManager.on('entity:created', async (entity) => {
  // Run multiple operations in parallel
  await Promise.all([
    sendWelcomeEmail(entity),
    createUserStats(entity),
    updateUserCount(),
    logUserCreation(entity)
  ]);
});
```

### Conditional Hooks

```typescript
EntityHookManager.on('entity:updating', async (entity) => {
  const profile = entity.get(UserProfile);

  // Only run for premium users
  if (profile.tier === 'premium') {
    await sendPremiumNotification(entity);
  }

  // Only run if email changed
  if (entity.hasChanged('email')) {
    await sendEmailVerification(entity);
  }
});
```

## 🛡️ Error Handling in Hooks

### Hook Error Handling

```typescript
EntityHookManager.on('entity:saving', async (entity) => {
  try {
    await validateEntityData(entity);
    await updateTimestamps(entity);
  } catch (error) {
    console.error('Hook error:', error);
    // Don't rethrow - hooks should not block entity operations
    // Log error and continue
  }
});
```

### Hook Error Propagation

```typescript
// For critical validation hooks
EntityHookManager.on('entity:saving', async (entity) => {
  const validationErrors = await validateCriticalData(entity);
  if (validationErrors.length > 0) {
    throw new ValidationError('Critical validation failed', validationErrors);
  }
});
```

## 🚀 Performance Optimization

### Hook Debouncing

```typescript
class HookDebouncer {
  private timeouts = new Map<string, NodeJS.Timeout>();

  debounce(key: string, fn: () => void, delay: number = 1000): void {
    const existing = this.timeouts.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    this.timeouts.set(key, setTimeout(() => {
      fn();
      this.timeouts.delete(key);
    }, delay));
  }
}

const debouncer = new HookDebouncer();

EntityHookManager.on('entity:updated', (entity) => {
  debouncer.debounce(`update-cache-${entity.id}`, async () => {
    await updateCache(entity);
  });
});
```

### Hook Filtering

```typescript
// Only run hooks for specific component types
EntityHookManager.on('component:attached', async (data) => {
  if (data.componentType === 'UserProfile') {
    await handleUserProfileAttached(data.entity);
  }
});
```

### Batch Hook Processing

```typescript
class BatchProcessor {
  private queue: any[] = [];
  private processing = false;

  async add(item: any): Promise<void> {
    this.queue.push(item);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, 10); // Process 10 at a time
      await Promise.all(batch.map(item => processItem(item)));
    }

    this.processing = false;
  }
}

const batchProcessor = new BatchProcessor();

EntityHookManager.on('entity:created', (entity) => {
  batchProcessor.add(entity);
});
```

## 🔗 Related APIs

- **[Entity API](core.md)** - Entity operations
- **[Component API](core.md)** - Component management
- **[Service API](service.md)** - Business logic layer

---

*Need more details? Check the [Upload API](upload.md) for file handling operations!* 🚀