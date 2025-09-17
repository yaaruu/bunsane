# Entity System

The Entity system is the foundation of BunSane's architecture. Unlike traditional objects or database rows, Entities in BunSane are dynamic containers composed of multiple Components, providing unparalleled flexibility in data modeling.

## 🎯 What is an Entity?

An Entity represents a single "thing" in your application - a user, a product, a blog post, etc. However, unlike traditional models, Entities don't have a fixed structure. Instead, they're composed of Components that define their properties and behavior.

### Key Characteristics

- **Dynamic Composition**: Entities can have any combination of components
- **Type-Safe**: Full TypeScript support with compile-time guarantees
- **Database-Backed**: Automatically persisted to PostgreSQL
- **Event-Driven**: Supports lifecycle hooks for business logic
- **Relationship-Aware**: Can reference other entities through components

## 🏗️ Creating Entities

### Basic Entity Creation

```typescript
import { Entity } from 'bunsane';

// Create a new empty entity
const user = Entity.Create();

// The entity gets a unique ID automatically
console.log(user.id); // "01HXXXXXXXXXXXXXXXXXXXXX"
```

### Adding Components to Entities

```typescript
import { Entity, Component, CompData, BaseComponent } from 'bunsane';

@Component
class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';
}

@Component
class UserPreferences extends BaseComponent {
  @CompData()
  theme: 'light' | 'dark' = 'light';

  @CompData()
  notifications: boolean = true;
}

// Create entity and add components
const user = Entity.Create();
user.add(UserProfile, {
  name: 'John Doe',
  email: 'john@example.com'
});

user.add(UserPreferences, {
  theme: 'dark',
  notifications: false
});
```

## 💾 Persisting Entities

### Saving to Database

```typescript
// Save the entity to database
await user.save();

// The entity is now persisted
console.log(user._persisted); // true
```

### Loading from Database

```typescript
// Load entity by ID
const loadedUser = await Entity.FindById(user.id);

// Load multiple entities
const userIds = ['01HXXX...', '01HYYY...'];
const users = await Entity.LoadMultiple(userIds);
```

## 🔍 Accessing Component Data

### Getting Component Data

```typescript
// Get component data
const profile = user.get(UserProfile);
console.log(profile.data()); // { name: 'John Doe', email: 'john@example.com' }

// Direct property access
const userName = profile.name; // 'John Doe'
const userEmail = profile.email; // 'john@example.com'
```

### Checking Component Existence

```typescript
// Check if entity has a component
if (user.has(UserProfile)) {
  const profile = user.get(UserProfile);
  console.log('User has profile:', profile.name);
}

// Get all components
const allComponents = user.componentList();
console.log('Entity has', allComponents.length, 'components');
```

## 🔄 Updating Entities

### Updating Component Data

```typescript
// Update existing component
user.set(UserProfile, {
  name: 'Jane Doe',
  email: 'jane@example.com'
});

// Add new component
@Component
class UserStats extends BaseComponent {
  @CompData()
  loginCount: number = 0;

  @CompData()
  lastLogin: Date = new Date();
}

user.add(UserStats, {
  loginCount: 1,
  lastLogin: new Date()
});

// Save changes
await user.save();
```

### Bulk Updates

```typescript
// Update multiple components at once
await user.set(UserProfile, { name: 'Updated Name' });
await user.set(UserStats, { loginCount: 2 });

// Save all changes
await user.save();
```

## 🗑️ Deleting Entities

### Soft Delete

```typescript
// Mark entity as deleted (soft delete)
await user.delete();

// Entity is marked as deleted but still exists
console.log(user._persisted); // false
```

### Force Delete

```typescript
// Permanently delete entity and all its components
await user.delete(true);
```

## 🔗 Entity Relationships

### Referencing Other Entities

```typescript
@Component
class BlogPost extends BaseComponent {
  @CompData()
  title: string = '';

  @CompData()
  content: string = '';

  @CompData()
  authorId: string = ''; // Reference to User entity
}

@Component
class Comment extends BaseComponent {
  @CompData()
  content: string = '';

  @CompData()
  postId: string = ''; // Reference to BlogPost entity

  @CompData()
  authorId: string = ''; // Reference to User entity
}

// Create related entities
const author = Entity.Create();
author.add(UserProfile, { name: 'Author Name', email: 'author@example.com' });
await author.save();

const post = Entity.Create();
post.add(BlogPost, {
  title: 'My First Post',
  content: 'Post content...',
  authorId: author.id
});
await post.save();

const comment = Entity.Create();
comment.add(Comment, {
  content: 'Great post!',
  postId: post.id,
  authorId: author.id
});
await comment.save();
```

## 📊 Advanced Entity Operations

### Entity Metadata

```typescript
// Check if entity is dirty (has unsaved changes)
console.log(user._dirty); // true/false

// Get entity creation timestamp (if available)
console.log(user.createdAt);

// Get list of dirty components
const dirtyComponents = user.getDirtyComponents();
console.log('Dirty components:', dirtyComponents);
```

### Batch Operations

```typescript
// Create multiple entities efficiently
const entities = [];
for (let i = 0; i < 100; i++) {
  const entity = Entity.Create();
  entity.add(UserProfile, {
    name: `User ${i}`,
    email: `user${i}@example.com`
  });
  entities.push(entity);
}

// Save all at once (more efficient)
await Promise.all(entities.map(entity => entity.save()));
```

## 🎣 Entity Lifecycle

Entities go through several lifecycle stages:

1. **Created**: Entity instantiated with `Entity.Create()`
2. **Composed**: Components added to entity
3. **Persisted**: Entity saved to database
4. **Loaded**: Entity retrieved from database
5. **Updated**: Entity modified and re-saved
6. **Deleted**: Entity marked as deleted or force-deleted

## 🔧 Best Practices

### Entity Design

- **Keep Entities Focused**: Each entity should represent one logical concept
- **Use Components Wisely**: Break down data into logical, reusable components
- **Plan Relationships**: Design entity references carefully to avoid circular dependencies
- **Index Strategically**: Use `@CompData({ indexed: true })` for frequently queried fields

### Performance Considerations

- **Batch Operations**: Use `Entity.LoadMultiple()` for loading multiple entities
- **Lazy Loading**: Only load components when needed
- **Efficient Queries**: Use the Query system for complex data retrieval
- **Monitor Entity Size**: Large entities with many components can impact performance

### Error Handling

```typescript
try {
  const entity = Entity.Create();
  entity.add(UserProfile, userData);
  await entity.save();
} catch (error) {
  console.error('Failed to create user:', error);
  // Handle error appropriately
}
```

## 🚀 What's Next?

Now that you understand Entities, let's explore:

- **[Components](components.md)** - The building blocks of entities
- **[ArcheTypes](archetypes.md)** - Reusable entity templates
- **[Query System](query.md)** - Efficient data retrieval
- **[Services](services.md)** - Business logic and GraphQL integration

---

*Ready to dive deeper? Let's look at [Components](components.md) next!* 🚀