# API Reference

This section provides comprehensive API reference documentation for BunSane framework components, classes, and utilities.

## 📚 API Overview

BunSane's API is organized into several key modules:

- **[Core API](core.md)** - Entity, Component, ArcheType, and base classes
- **[Query API](query.md)** - Database querying and filtering
- **[Service API](service.md)** - GraphQL services and resolvers
- **[Hooks API](hooks.md)** - Lifecycle hooks and event system
- **[Upload API](upload.md)** - File upload and storage system
- **[Scheduler API](scheduler.md)** - Background tasks and scheduling
- **[Database API](database.md)** - Database helpers and utilities
- **[Utils API](utils.md)** - Utility functions and helpers

## 🔍 Quick Reference

### Core Classes

| Class | Description | Location |
|-------|-------------|----------|
| `Entity` | Core entity container | `core/Entity.ts` |
| `BaseComponent` | Component base class | `core/Components.ts` |
| `ArcheType` | Entity template system | `core/ArcheType.ts` |
| `Query` | Database query builder | `core/Query.ts` |
| `BaseService` | Service base class | `service/Service.ts` |
| `App` | Application bootstrap | `core/App.ts` |

### Decorators

| Decorator | Description | Usage |
|-----------|-------------|-------|
| `@Component` | Mark class as component | `core/Components.ts` |
| `@CompData` | Mark property as data field | `core/Components.ts` |
| `@EntityHook` | Register entity lifecycle hook | `core/decorators/EntityHooks.ts` |
| `@ComponentHook` | Register component lifecycle hook | `core/decorators/EntityHooks.ts` |
| `@LifecycleHook` | Register general lifecycle hook | `core/decorators/EntityHooks.ts` |

### Key Functions

| Function | Description | Module |
|----------|-------------|--------|
| `Entity.Create()` | Create new entity | `core/Entity.ts` |
| `Entity.FindById()` | Find entity by ID | `core/Entity.ts` |
| `Entity.LoadMultiple()` | Load multiple entities | `core/Entity.ts` |
| `new Query()` | Create query builder | `core/Query.ts` |
| `ServiceRegistry.register()` | Register service | `service/ServiceRegistry.ts` |
| `App.start()` | Start application | `core/App.ts` |

## 📖 API Documentation Structure

Each API reference page includes:

- **Class/Function Overview** - Purpose and usage
- **Constructor Parameters** - Initialization options
- **Methods** - Available operations with signatures
- **Properties** - Public properties and their types
- **Examples** - Practical usage examples
- **Related Classes** - Connected components

## 🎯 Getting Started with API Reference

### 1. Import Statements

```typescript
// Core imports
import { Entity, Component, CompData, BaseComponent } from 'bunsane';
import { ArcheType } from 'bunsane';
import { Query } from 'bunsane';

// Service imports
import { BaseService, ServiceRegistry } from 'bunsane';

// Hook imports
import { EntityHook, ComponentHook } from 'bunsane';

// Advanced imports
import { BatchLoader } from 'bunsane';
import { UploadManager } from 'bunsane';
```

### 2. Type Definitions

```typescript
// Component data types
type UserProfileData = {
  name: string;
  email: string;
  username: string;
};

// Service method signatures
interface UserService {
  createUser(input: CreateUserInput): Promise<User>;
  getUser(id: string): Promise<User | null>;
  updateUser(id: string, input: UpdateUserInput): Promise<User>;
}
```

### 3. Error Types

```typescript
// Common error types
class ValidationError extends Error {
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

class DatabaseError extends Error {
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
```

## 🔧 API Patterns

### Builder Pattern

Many BunSane APIs use the builder pattern for fluent interfaces:

```typescript
// Query builder
const users = await new Query()
  .with(UserProfile)
  .filter('status', 'active')
  .orderBy('name')
  .limit(10)
  .exec();

// ArcheType builder
const userEntity = UserArcheType
  .fill(userData)
  .createEntity();
```

### Decorator Pattern

Decorators are used extensively for metadata and behavior:

```typescript
@Component
class UserProfile extends BaseComponent {
  @CompData({ indexed: true })
  email: string = '';
}

@EntityHook('entity.created')
async onUserCreated(event: EntityCreatedEvent) {
  // Hook implementation
}
```

### Factory Pattern

Factory functions for complex object creation:

```typescript
// Service factory
function createUserService(db: Database): UserService {
  return new UserService(db);
}

// Component factory
function createUserProfile(data: UserProfileData): UserProfile {
  const component = new UserProfile();
  Object.assign(component, data);
  return component;
}
```

## 📊 API Stability

### Version Compatibility

- **Stable APIs** - Marked with ✅, guaranteed compatibility
- **Beta APIs** - Marked with ⚠️, may change in future versions
- **Experimental APIs** - Marked with 🧪, subject to change
- **Deprecated APIs** - Marked with ❌, will be removed

### Breaking Changes

Breaking changes follow semantic versioning:
- **Major version** (X.0.0) - Breaking changes allowed
- **Minor version** (x.X.0) - New features, backward compatible
- **Patch version** (x.x.X) - Bug fixes, backward compatible

## 🔍 Search and Navigation

Use the search functionality to quickly find:

- Class and method names
- Property definitions
- Type definitions
- Error types
- Usage examples

## 📝 Contributing to API Documentation

When contributing to the API documentation:

1. **Keep Examples Current** - Update examples when APIs change
2. **Document Breaking Changes** - Clearly mark breaking changes
3. **Add Migration Guides** - Provide upgrade paths for breaking changes
4. **Include Type Information** - Show TypeScript types and interfaces
5. **Test Examples** - Ensure code examples are runnable

## 🎯 Next Steps

- **[Core API](core.md)** - Start with fundamental classes
- **[Query API](query.md)** - Learn database operations
- **[Service API](service.md)** - Build GraphQL services
- **[Hooks API](hooks.md)** - Add lifecycle behavior

---

*Ready to dive into the APIs? Start with the [Core API](core.md)!* 🚀