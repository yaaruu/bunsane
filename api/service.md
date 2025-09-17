# Service API Reference

This page provides detailed API reference for BunSane's service layer and business logic components.

## 🏢 BaseService Class

The `BaseService` class provides the foundation for all business logic services in BunSane.

### Constructor

```typescript
new BaseService()
```

### Instance Methods

#### `service.initialize()`

Initializes the service with dependencies.

```typescript
async initialize(): Promise<void>
```

**Returns:** `Promise<void>`

**Example:**
```typescript
await userService.initialize();
// Service is now ready to use
```

## 👤 ServiceRegistry Class

Manages service registration and dependency injection. Services are automatically registered when they extend `BaseService` and are imported in your application.

### Static Methods

#### `ServiceRegistry.register(serviceClass)`

Registers a service with the registry.

```typescript
static register(serviceClass: new () => BaseService): void
```

**Parameters:**
- `serviceClass`: Service constructor

**Example:**
```typescript
export class UserService extends BaseService {
  // Service implementation
}

// Automatic registration when imported
// No manual registration needed in most cases
ServiceRegistry.register(UserService);
```

#### `ServiceRegistry.get(serviceClass)`

Gets a service instance by class.

```typescript
static get<T extends BaseService>(serviceClass: new () => T): T
```

**Type Parameters:**
- `T`: Service class

**Parameters:**
- `serviceClass`: Service constructor

**Returns:** `T` - Service instance

**Example:**
```typescript
const userService = ServiceRegistry.get(UserService);
```

### Automatic Service Discovery

Services are automatically discovered and registered when:
1. They extend `BaseService`
2. They are imported in your application entry point
3. The application starts via `App.start()`

```typescript
// app.ts
import { App } from 'bunsane';
import { UserService } from './services/UserService';
import { OrderService } from './services/OrderService';

const app = new App();

// Services are automatically registered when imported
// No manual registration required
app.start();
```

### Service Dependencies

Services can access other services through the ServiceRegistry:

```typescript
export class OrderService extends BaseService {
  private userService: UserService;

  async initialize(): Promise<void> {
    await super.initialize();
    // Get service instance from registry
    this.userService = ServiceRegistry.get(UserService);
  }

  async createOrder(userId: string, orderData: any) {
    // Validate user exists
    const user = await this.userService.getUser({ id: userId });
    if (!user) throw new Error('User not found');

    // Create order logic
    const order = Entity.Create();
    // ... order creation logic
    return order;
  }
}
```

## 🎯 GraphQL Service Decorators

### @GraphQLObjectType

Defines a GraphQL object type for the service.

```typescript
@GraphQLObjectType(config: GraphQLObjectTypeConfig): ClassDecorator
```

**Parameters:**
- `config`: GraphQLObjectTypeConfig - Type configuration

**Example:**
```typescript
const userFields = {
  id: GraphQLFieldTypes.ID_REQUIRED,
  name: GraphQLFieldTypes.STRING_OPTIONAL,
  email: GraphQLFieldTypes.STRING_REQUIRED
};

@GraphQLObjectType({
  name: "User",
  fields: userFields
})
export class UserService extends BaseService {
  // Service implementation
}
```

### @GraphQLOperation

Defines a GraphQL operation (Query/Mutation).

```typescript
@GraphQLOperation(config: GraphQLOperationConfig): MethodDecorator
```

**Parameters:**
- `config`: GraphQLOperationConfig - Operation configuration

**Example:**
```typescript
@GraphQLOperation({
  type: "Query",
  input: { id: GraphQLFieldTypes.ID_REQUIRED },
  output: "User"
})
async getUser(args: { id: string }) {
  // Implementation
}

@GraphQLOperation({
  type: "Mutation",
  input: {
    name: GraphQLFieldTypes.STRING_REQUIRED,
    email: GraphQLFieldTypes.STRING_REQUIRED
  },
  output: "User"
})
async createUser(args: { name: string; email: string }) {
  // Implementation
}
```

### @GraphQLField

Defines a GraphQL field resolver.

```typescript
@GraphQLField(config: GraphQLFieldConfig): MethodDecorator
```

**Parameters:**
- `config`: GraphQLFieldConfig - Field configuration

**Example:**
```typescript
@GraphQLField({ type: "User", field: "name" })
async nameResolver(parent: Entity) {
  const profile = await parent.get(UserProfile);
  return profile?.name ?? "";
}
```

## 🌐 REST Service Decorators

### @Post

Defines a POST REST endpoint.

```typescript
@Post(path: string): MethodDecorator
```

**Parameters:**
- `path`: String - Endpoint path

**Example:**
```typescript
@Post("/auth/login")
async userLogin(req: Request) {
  // Handle login logic
  return new Response(JSON.stringify({ token: "jwt-token" }));
}
```

## ⏰ Scheduled Task Decorators

### @ScheduledTask

Defines a scheduled background task.

```typescript
@ScheduledTask(config: ScheduledTaskConfig): MethodDecorator
```

**Parameters:**
- `config`: ScheduledTaskConfig - Task configuration

**Example:**
```typescript
@ScheduledTask({
  interval: ScheduleInterval.MINUTE,
  componentTarget: {
    includeComponents: [UserTag],
  }
})
async checkUserPerMinutes(entities: Entity[]) {
  // Run every minute for user entities
}
```

## 🎣 Lifecycle Hook Decorators

### @ComponentTargetHook

Defines a component lifecycle hook.

```typescript
@ComponentTargetHook(event: string, config: HookConfig): MethodDecorator
```

**Parameters:**
- `event`: String - Hook event name
- `config`: HookConfig - Hook configuration

**Example:**
```typescript
@ComponentTargetHook("entity.created", {
  includeComponents: [UserTag, EmailComponent]
})
async onUserCreate(event: EntityCreatedEvent) {
  const emailComp = await event.entity.get(EmailComponent);
  console.log(`New user: ${emailComp?.value}`);
}
```

## 📋 Service Patterns

### GraphQL CRUD Service Pattern

```typescript
import { GraphQLObjectType, GraphQLOperation, GraphQLField, GraphQLFieldTypes } from 'bunsane';

const userFields = {
  id: GraphQLFieldTypes.ID_REQUIRED,
  name: GraphQLFieldTypes.STRING_OPTIONAL,
  email: GraphQLFieldTypes.STRING_REQUIRED,
  username: GraphQLFieldTypes.STRING_OPTIONAL
};

const userInputs = {
  createUser: {
    name: GraphQLFieldTypes.STRING_REQUIRED,
    email: GraphQLFieldTypes.STRING_REQUIRED,
    username: GraphQLFieldTypes.STRING_REQUIRED
  },
  getUser: {
    id: GraphQLFieldTypes.ID_REQUIRED
  },
  updateUser: {
    id: GraphQLFieldTypes.ID_REQUIRED,
    name: GraphQLFieldTypes.STRING_OPTIONAL,
    email: GraphQLFieldTypes.STRING_OPTIONAL
  }
};

@GraphQLObjectType({
  name: "User",
  fields: userFields
})
export class UserService extends BaseService {
  @GraphQLOperation({
    type: "Mutation",
    input: userInputs.createUser,
    output: "User"
  })
  async createUser(args: { name: string; email: string; username: string }) {
    const userEntity = UserArcheType.fill(args).createEntity();
    await userEntity.save();
    return await UserArcheType.Unwrap(userEntity);
  }

  @GraphQLOperation({
    type: "Query",
    input: userInputs.getUser,
    output: "User"
  })
  async getUser(args: { id: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) return null;
    return await UserArcheType.Unwrap(entity);
  }

  @GraphQLOperation({
    type: "Mutation",
    input: userInputs.updateUser,
    output: "User"
  })
  async updateUser(args: { id: string; name?: string; email?: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) throw new Error('User not found');

    await UserArcheType.updateEntity(entity, args);
    await entity.save();
    return await UserArcheType.Unwrap(entity);
  }

  @GraphQLField({ type: "User", field: "id" })
  idResolver(parent: Entity) {
    return parent.id;
  }

  @GraphQLField({ type: "User", field: "name" })
  async nameResolver(parent: Entity) {
    const profile = await parent.get(UserProfile);
    return profile?.name ?? "";
  }

  @GraphQLField({ type: "User", field: "email" })
  async emailResolver(parent: Entity) {
    const profile = await parent.get(UserProfile);
    return profile?.email ?? "";
  }

  @GraphQLField({ type: "User", field: "username" })
  async usernameResolver(parent: Entity) {
    const profile = await parent.get(UserProfile);
    return profile?.username ?? "";
  }
}
```

### REST Service Pattern

```typescript
import { Post } from 'bunsane';

export class AuthService extends BaseService {
  @Post("/auth/login")
  async userLogin(req: Request) {
    const body = await req.json();
    const { email, password } = body;

    // Authentication logic
    const user = await this.authenticateUser(email, password);
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401
      });
    }

    const token = this.generateToken(user);
    return new Response(JSON.stringify({ token, user }), { status: 200 });
  }

  @Post("/auth/register")
  async userRegister(req: Request) {
    try {
      const body = await req.json();
      const input = this.validateRegistrationData(body);

      const existingUser = await Query.Find(UserTag)
        .with(EmailComponent, Query.filters(
          Query.filter("value", Query.filterOp.EQ, input.email)
        ))
        .exec();

      if (existingUser.length > 0) {
        return new Response(JSON.stringify({
          error: "Email already in use"
        }), { status: 400 });
      }

      const entity = UserArcheType.fill(input).createEntity();
      await entity.save();

      return new Response(JSON.stringify({
        message: "User registered successfully",
        user: await UserArcheType.Unwrap(entity, ['password'])
      }), { status: 201 });
    } catch (error) {
      return new Response(JSON.stringify({
        error: "Registration failed"
      }), { status: 500 });
    }
  }

  private async authenticateUser(email: string, password: string) {
    // Authentication implementation
    return null;
  }

  private generateToken(user: any) {
    // JWT token generation
    return "jwt-token";
  }

  private validateRegistrationData(data: any) {
    // Validation logic
    return data;
  }
}
```

### Scheduled Task Service Pattern

```typescript
import { ScheduledTask, ScheduleInterval, ComponentTargetHook } from 'bunsane';

export class MaintenanceService extends BaseService {
  @ScheduledTask({
    interval: ScheduleInterval.HOUR,
    componentTarget: {
      includeComponents: [UserTag],
    }
  })
  async cleanupInactiveUsers(entities: Entity[]) {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    for (const entity of entities) {
      const lastLogin = await entity.get(LastLoginComponent);
      if (lastLogin && lastLogin.value < oneMonthAgo) {
        // Mark user as inactive or send reminder
        await this.sendInactivityReminder(entity);
      }
    }
  }

  @ScheduledTask({
    interval: ScheduleInterval.DAY,
    componentTarget: {
      includeComponents: [PostTag],
    }
  })
  async cleanupOldPosts(entities: Entity[]) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    for (const entity of entities) {
      const createdAt = await entity.get(DateComponent);
      if (createdAt && createdAt.value < thirtyDaysAgo) {
        // Archive or delete old posts
        await entity.delete();
      }
    }
  }

  @ComponentTargetHook("entity.created", {
    includeComponents: [UserTag, EmailComponent]
  })
  async onUserCreated(event: EntityCreatedEvent) {
    const emailComp = await event.entity.get(EmailComponent);
    if (emailComp) {
      await this.sendWelcomeEmail(emailComp.value);
    }
  }

  private async sendInactivityReminder(entity: Entity) {
    // Send reminder email implementation
  }

  private async sendWelcomeEmail(email: string) {
    // Send welcome email implementation
  }
}
```

## 🔄 Service Communication

### Service Dependencies

```typescript
export class NotificationService extends BaseService {
  private emailService: EmailService;
  private smsService: SmsService;

  async initialize(): Promise<void> {
    await super.initialize();
    this.emailService = ServiceRegistry.get(EmailService);
    this.smsService = ServiceRegistry.get(SmsService);
  }

  async sendWelcomeMessage(userId: string): Promise<void> {
    const user = await Entity.FindById(userId);
    if (!user) return;

    const profile = await user.get(UserProfile);

    // Send both email and SMS
    await Promise.all([
      this.emailService.sendWelcomeEmail(profile.email, profile.name),
      this.smsService.sendWelcomeSms(profile.phone, profile.name)
    ]);
  }
}
```

### Event-Driven Services

```typescript
export class AuditService extends BaseService {
  async initialize(): Promise<void> {
    await super.initialize();

    // Listen to entity events
    EntityHookManager.on('entity:created', this.onEntityCreated.bind(this));
    EntityHookManager.on('entity:updated', this.onEntityUpdated.bind(this));
    EntityHookManager.on('entity:deleted', this.onEntityDeleted.bind(this));
  }

  private async onEntityCreated(entity: Entity): Promise<void> {
    await this.logAuditEvent({
      action: 'CREATE',
      entityId: entity.id,
      timestamp: new Date(),
      userId: this.getCurrentUserId()
    });
  }

  private async onEntityUpdated(entity: Entity): Promise<void> {
    await this.logAuditEvent({
      action: 'UPDATE',
      entityId: entity.id,
      timestamp: new Date(),
      userId: this.getCurrentUserId()
    });
  }

  private async onEntityDeleted(entity: Entity): Promise<void> {
    await this.logAuditEvent({
      action: 'DELETE',
      entityId: entity.id,
      timestamp: new Date(),
      userId: this.getCurrentUserId()
    });
  }

  private async logAuditEvent(event: AuditEvent): Promise<void> {
    const auditEntity = Entity.Create();
    await auditEntity.add(AuditLog, event);
    await auditEntity.save();
  }

  private getCurrentUserId(): string {
    // Get current user from context
    return RequestContext.getCurrentUser()?.id || 'system';
  }
}
```

## 🛡️ Error Handling

### Service Error Types

```typescript
export class ServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string, public field?: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ServiceError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}
```

### Error Handling Patterns

```typescript
export class UserService extends BaseService {
  async createUser(userData: CreateUserData): Promise<Entity> {
    try {
      // Validate input
      this.validateUserData(userData);

      // Check for existing user
      const existing = await Query.Find(UserProfile)
        .where({ email: userData.email })
        .first();

      if (existing) {
        throw new ValidationError('Email already exists', 'email');
      }

      // Create user
      const user = Entity.Create();
      await user.add(UserProfile, userData);
      await user.save();

      return user;
    } catch (error) {
      this.getLogger().error('Failed to create user', { error, userData });
      throw error;
    }
  }

  private validateUserData(data: CreateUserData): void {
    if (!data.email || !data.email.includes('@')) {
      throw new ValidationError('Invalid email address', 'email');
    }

    if (!data.name || data.name.length < 2) {
      throw new ValidationError('Name must be at least 2 characters', 'name');
    }
  }
}
```

## 🚀 Performance Optimization

### Service Caching

```typescript
export class CacheService extends BaseService {
  private cache = new Map<string, any>();

  async get<T>(key: string, ttl: number = 300000): Promise<T | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }
    return null;
  }

  async set<T>(key: string, value: T, ttl: number = 300000): Promise<void> {
    this.cache.set(key, {
      value,
      expires: Date.now() + ttl
    });
  }

  clear(): void {
    this.cache.clear();
  }
}
```

### Batch Operations

```typescript
export class BulkOperationService extends BaseService {
  async bulkCreateUsers(userData: CreateUserData[]): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Process in batches to avoid memory issues
    const batchSize = 100;
    for (let i = 0; i < userData.length; i += batchSize) {
      const batch = userData.slice(i, i + batchSize);
      const batchEntities = await this.createUserBatch(batch);
      entities.push(...batchEntities);
    }

    return entities;
  }

  private async createUserBatch(batch: CreateUserData[]): Promise<Entity[]> {
    const entities = batch.map(data => {
      const entity = Entity.Create();
      await entity.add(UserProfile, data);
      return entity;
    });

    // Save all entities in parallel
    await Promise.all(entities.map(entity => entity.save()));
    return entities;
  }
}
```

## 🔗 Related APIs

- **[Entity API](core.md)** - Entity operations
- **[Query API](query.md)** - Database querying
- **[Hooks API](hooks.md)** - Lifecycle events

---

*Need more details? Check the [Hooks API](hooks.md) for lifecycle event handling!* 🚀