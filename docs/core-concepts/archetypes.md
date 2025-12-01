# ArcheType System

ArcheTypes are BunSane's powerful abstraction layer that provides reusable templates for creating entities with predefined sets of components. They eliminate code duplication and ensure consistency across your application by defining entity "blueprints".

## 🎯 What is an ArcheType?

An ArcheType is a template that defines a specific combination of components that should be present on an entity. Think of it as a "class" in traditional OOP, but with the flexibility of composition.

### Key Benefits

- **Consistency**: Ensures entities have the correct component combinations
- **Reusability**: Define once, use everywhere
- **Type Safety**: Full TypeScript support with compile-time guarantees
- **Data Integrity**: Guarantees required components are always present
- **Code Organization**: Clear separation of entity types and their capabilities

## 🏗️ Creating ArcheTypes

### Basic ArcheType Definition

```typescript
import { ArcheType, Component, CompData, BaseComponent } from 'bunsane';

@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';
}

@Component
export class UserPreferences extends BaseComponent {
  @CompData()
  theme: 'light' | 'dark' = 'light';

  @CompData()
  notifications: boolean = true;
}

@Component
export class UserStats extends BaseComponent {
  @CompData()
  loginCount: number = 0;

  @CompData()
  lastLogin: Date = new Date();
}

// Create ArcheType
export const UserArcheType = new ArcheType([
  UserProfile,
  UserPreferences,
  UserStats
]);
```

### Complex ArcheType with Relationships

```typescript
@Component
export class BlogPost extends BaseComponent {
  @CompData()
  title: string = '';

  @CompData()
  content: string = '';

  @CompData({ indexed: true })
  authorId: string = '';

  @CompData()
  tags: string[] = [];
}

@Component
export class PostMetadata extends BaseComponent {
  @CompData()
  publishedAt: Date = new Date();

  @CompData()
  readingTime: number = 0; // in minutes

  @CompData()
  wordCount: number = 0;
}

@Component
export class PostStats extends BaseComponent {
  @CompData()
  viewCount: number = 0;

  @CompData()
  likeCount: number = 0;

  @CompData()
  commentCount: number = 0;
}

export const BlogPostArcheType = new ArcheType([
  BlogPost,
  PostMetadata,
  PostStats
]);
```

## 🎨 Using ArcheTypes

### Creating Entities from ArcheTypes

```typescript
// Create entity with all archetype components
const userEntity = UserArcheType.createEntity();

// The entity now has UserProfile, UserPreferences, and UserStats components
console.log(userEntity.has(UserProfile)); // true
console.log(userEntity.has(UserPreferences)); // true
console.log(userEntity.has(UserStats)); // true
```

### Filling ArcheTypes with Data

```typescript
// Fill archetype with data before creating entity
const userData = {
  userProfile: {
    name: 'John Doe',
    email: 'john@example.com'
  },
  userPreferences: {
    theme: 'dark',
    notifications: false
  },
  userStats: {
    loginCount: 1,
    lastLogin: new Date()
  }
};

const userEntity = UserArcheType.fill(userData).createEntity();
await userEntity.save();
```

### Creating and Saving in One Step

```typescript
// Create and save entity in one operation
const userEntity = await UserArcheType.fill(userData).createAndSaveEntity();

// Entity is now saved to database
console.log(userEntity._persisted); // true
```

## 🔄 ArcheType Operations

### Updating Entities

```typescript
// Update existing entity using archetype
const existingUser = await Entity.FindById(userId);

const updates = {
  userProfile: {
    name: 'Jane Doe'
  },
  userPreferences: {
    theme: 'light'
  }
};

await UserArcheType.updateEntity(existingUser, updates);
await existingUser.save();
```

### Unwrapping Entities

```typescript
// Convert entity back to plain object
const userEntity = await Entity.FindById(userId);
const userData = await UserArcheType.Unwrap(userEntity);

console.log(userData);
// {
//   userProfile: { name: 'John Doe', email: 'john@example.com' },
//   userPreferences: { theme: 'dark', notifications: true },
//   userStats: { loginCount: 5, lastLogin: '2025-09-17T...' }
// }
```

### Unwrapping with Field Exclusion

```typescript
// Exclude sensitive data when unwrapping
const publicUserData = await UserArcheType.Unwrap(userEntity, ['email', 'loginCount']);

console.log(publicUserData);
// {
//   userProfile: { name: 'John Doe' }, // email excluded
//   userPreferences: { theme: 'dark', notifications: true },
//   userStats: { lastLogin: '2025-09-17T...' } // loginCount excluded
// }
```

### Loading Entities with Components

```typescript
// Load entity with all archetype components pre-populated
const userEntity = await UserArcheType.getEntityWithID(userId);

// All components are now loaded and cached
const profile = await userEntity.get(UserProfile); // No additional DB query
const preferences = await userEntity.get(UserPreferences); // No additional DB query
```

#### Advanced Loading Options

```typescript
// Load only specific components
const userEntity = await UserArcheType.getEntityWithID(userId, {
  includeComponents: ['userProfile', 'userPreferences']
});

// Exclude certain components
const userEntity = await UserArcheType.getEntityWithID(userId, {
  excludeComponents: ['userStats']
});

// Load with relations populated
const userEntity = await UserArcheType.getEntityWithID(userId, {
  populateRelations: true
});

// Throw error if entity not found
const userEntity = await UserArcheType.getEntityWithID(userId, {
  throwOnNotFound: true
});
```

#### Static Method Usage

```typescript
// Using static method for convenience
const userEntity = await BaseArcheType.getEntityWithID(UserArcheTypeClass, userId);
```

#### Migration from Manual Loading

```typescript
// Before: Manual component loading (multiple DB queries)
const entity = await Entity.FindById(userId);
const profile = await entity.get(UserProfile);
const preferences = await entity.get(UserPreferences);
const stats = await entity.get(UserStats);

// After: Single optimized query with all components
const entity = await UserArcheType.getEntityWithID(userId);
// All components are pre-loaded and cached
```

## 🏷️ ArcheType Inheritance and Composition

### Base ArcheTypes

```typescript
// Base archetype for all content
export const ContentArcheType = new ArcheType([
  BaseContent,
  ContentMetadata
]);

// Extended archetypes
export const BlogPostArcheType = new ArcheType([
  ...ContentArcheType.getComponents(),
  BlogPost,
  PostStats
]);

export const PageArcheType = new ArcheType([
  ...ContentArcheType.getComponents(),
  PageContent,
  PageSettings
]);
```

### Specialized ArcheTypes

```typescript
// Admin user archetype (extends regular user)
export const AdminUserArcheType = new ArcheType([
  ...UserArcheType.getComponents(),
  AdminPermissions,
  AdminStats
]);

// Premium user archetype
export const PremiumUserArcheType = new ArcheType([
  ...UserArcheType.getComponents(),
  PremiumFeatures,
  BillingInfo
]);
```

## 🔍 ArcheType Queries

### Querying by ArcheType

```typescript
import { Query } from 'bunsane';

// Find all users
const userQuery = new Query()
  .with(UserProfile) // Must have UserProfile component
  .with(UserPreferences); // Must have UserPreferences component

const users = await userQuery.exec();

// Find premium users
const premiumQuery = new Query()
  .with(UserProfile)
  .with(PremiumFeatures);

const premiumUsers = await premiumQuery.exec();
```

### ArcheType-Specific Queries

```typescript
// Query with archetype filtering
const adminUsers = await new Query()
  .with(UserProfile)
  .with(AdminPermissions)
  .exec();

// Get user count
const userCount = await new Query()
  .with(UserProfile)
  .count();
```

## 🎭 Advanced ArcheType Patterns

### Dynamic ArcheTypes

```typescript
class DynamicArcheType extends ArcheType {
  constructor(userType: 'basic' | 'premium' | 'admin') {
    const baseComponents = [UserProfile, UserPreferences];

    const additionalComponents = {
      basic: [],
      premium: [PremiumFeatures, BillingInfo],
      admin: [AdminPermissions, AdminStats, AuditLog]
    };

    super([...baseComponents, ...additionalComponents[userType]]);
  }
}

// Usage
const basicUserArchetype = new DynamicArcheType('basic');
const premiumUserArchetype = new DynamicArcheType('premium');
const adminUserArchetype = new DynamicArcheType('admin');
```

### Conditional Components

```typescript
class ConditionalArcheType extends ArcheType {
  constructor(includeStats: boolean = false, includeAudit: boolean = false) {
    const components = [UserProfile, UserPreferences];

    if (includeStats) {
      components.push(UserStats);
    }

    if (includeAudit) {
      components.push(AuditLog);
    }

    super(components);
  }
}

// Usage
const minimalUserArchetype = new ConditionalArcheType();
const fullUserArchetype = new ConditionalArcheType(true, true);
```

### ArcheType Factories

```typescript
class ArcheTypeFactory {
  static createUserArchetype(userType: string): ArcheType {
    switch (userType) {
      case 'admin':
        return new ArcheType([
          UserProfile,
          UserPreferences,
          AdminPermissions,
          AdminStats
        ]);

      case 'premium':
        return new ArcheType([
          UserProfile,
          UserPreferences,
          PremiumFeatures,
          BillingInfo
        ]);

      default:
        return new ArcheType([
          UserProfile,
          UserPreferences
        ]);
    }
  }

  static createContentArchetype(contentType: string): ArcheType {
    const baseComponents = [BaseContent, ContentMetadata];

    switch (contentType) {
      case 'blog':
        return new ArcheType([...baseComponents, BlogPost, PostStats]);

      case 'page':
        return new ArcheType([...baseComponents, PageContent, PageSettings]);

      case 'product':
        return new ArcheType([...baseComponents, ProductInfo, Inventory]);

      default:
        return new ArcheType(baseComponents);
    }
  }
}

// Usage
const adminArchetype = ArcheTypeFactory.createUserArchetype('admin');
const blogArchetype = ArcheTypeFactory.createContentArchetype('blog');
```

## 🔧 ArcheType Management

### ArcheType Registry

```typescript
// Register archetypes for easy access
class ArcheTypeRegistry {
  private static archetypes: Map<string, ArcheType> = new Map();

  static register(name: string, archetype: ArcheType) {
    this.archetypes.set(name, archetype);
  }

  static get(name: string): ArcheType | undefined {
    return this.archetypes.get(name);
  }

  static getAll(): Map<string, ArcheType> {
    return this.archetypes;
  }
}

// Register common archetypes
ArcheTypeRegistry.register('user', UserArcheType);
ArcheTypeRegistry.register('admin', AdminUserArcheType);
ArcheTypeRegistry.register('blog-post', BlogPostArcheType);

// Usage
const userArchetype = ArcheTypeRegistry.get('user');
const adminArchetype = ArcheTypeRegistry.get('admin');
```

### ArcheType Validation

```typescript
class ValidatedArcheType extends ArcheType {
  constructor(components: any[], requiredComponents: any[] = []) {
    super(components);
    this.requiredComponents = requiredComponents;
  }

  validateEntity(entity: Entity): boolean {
    // Check if entity has all required components
    return this.requiredComponents.every(component =>
      entity.has(component)
    );
  }

  createValidatedEntity(data?: any): Entity {
    const entity = this.fill(data || {}).createEntity();

    if (!this.validateEntity(entity)) {
      throw new Error('Entity does not meet archetype requirements');
    }

    return entity;
  }
}

// Usage
const validatedUserArchetype = new ValidatedArcheType(
  [UserProfile, UserPreferences, UserStats],
  [UserProfile] // UserProfile is required
);

try {
  const user = validatedUserArchetype.createValidatedEntity(userData);
} catch (error) {
  console.error('Validation failed:', error);
}
```

## 📊 Best Practices

### ArcheType Design

- **Clear Purpose**: Each archetype should have a single, clear responsibility
- **Minimal Components**: Include only essential components to avoid bloat
- **Consistent Naming**: Use descriptive names that indicate the archetype's purpose
- **Versioning**: Consider versioning for archetypes that evolve over time
- **Documentation**: Document the purpose and usage of each archetype

### Performance Considerations

- **Component Loading**: Be mindful of the number of components in an archetype
- **Query Optimization**: Design archetypes to support efficient queries
- **Memory Usage**: Consider the memory impact of large archetypes
- **Caching**: Cache frequently used archetypes to improve performance

### Error Handling

```typescript
try {
  // Validate data before creating entity
  if (!userData.email || !userData.name) {
    throw new Error('Missing required user data');
  }

  const userEntity = await UserArcheType.fill(userData).createAndSaveEntity();
  console.log('User created successfully:', userEntity.id);

} catch (error) {
  console.error('Failed to create user:', error);

  // Log error details for debugging
  logger.error('User creation failed', {
    error: error.message,
    userData: userData,
    archetype: 'UserArcheType'
  });
}
```

## 🚀 What's Next?

Now that you understand ArcheTypes, let's explore:

- **[Services](services.md)** - Business logic and GraphQL integration
- **[Query System](query.md)** - Efficient data retrieval
- **[Entity System](entity.md)** - How entities work with archetypes
- **[Lifecycle Hooks](hooks.md)** - Business logic integration

---

*Ready to build with archetypes? Let's look at [Services](services.md) next!* 🚀