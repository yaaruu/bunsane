# Component System

Components are the fundamental building blocks of BunSane's Entity-Component-System (ECS) architecture. They define the data and behavior that can be attached to entities, providing unparalleled flexibility in data modeling.

## 🎯 What is a Component?

A Component is a pure data structure that represents a specific aspect or capability of an entity. Unlike traditional object-oriented classes, components are:

- **Composable**: Can be mixed and matched on entities as needed
- **Type-Safe**: Full TypeScript support with compile-time guarantees
- **Database-Backed**: Automatically persisted to PostgreSQL
- **Decorator-Driven**: Use simple decorators to define data properties
- **Indexed**: Support for database indexing on frequently queried fields

## 🏗️ Creating Components

### Basic Component Structure

```typescript
import { Component, CompData, BaseComponent } from 'bunsane';

@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';

  @CompData({ indexed: true })
  username: string = '';
}
```

### Component Registration

Components must be decorated with `@Component` and extend `BaseComponent`. The framework automatically:

- Registers the component with the ComponentRegistry
- Generates a unique type ID for database storage
- Creates database tables for component data
- Sets up indexing for marked properties

## 📊 Component Data Properties

### Basic Data Properties

```typescript
@Component
export class ProductInfo extends BaseComponent {
  @CompData()
  title: string = '';

  @CompData()
  description: string = '';

  @CompData()
  price: number = 0;

  @CompData()
  inStock: boolean = true;
}
```

### Indexed Properties

```typescript
@Component
export class BlogPost extends BaseComponent {
  @CompData()
  title: string = '';

  @CompData()
  content: string = '';

  @CompData({ indexed: true })
  authorId: string = '';

  @CompData({ indexed: true })
  publishedAt: Date = new Date();

  @CompData({ indexed: true })
  tags: string[] = [];
}
```

### Complex Data Types

```typescript
@Component
export class UserPreferences extends BaseComponent {
  @CompData()
  theme: 'light' | 'dark' | 'auto' = 'light';

  @CompData()
  notifications: {
    email: boolean;
    push: boolean;
    sms: boolean;
  } = {
    email: true,
    push: false,
    sms: false
  };

  @CompData()
  language: string = 'en';

  @CompData()
  timezone: string = 'UTC';
}
```

## 🔧 Component Methods

### Custom Methods

Components can include methods for data manipulation and business logic:

```typescript
@Component
export class ShoppingCart extends BaseComponent {
  @CompData()
  items: CartItem[] = [];

  @CompData()
  total: number = 0;

  // Custom method to add items
  addItem(productId: string, quantity: number, price: number) {
    const existingItem = this.items.find(item => item.productId === productId);

    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      this.items.push({
        productId,
        quantity,
        price,
        addedAt: new Date()
      });
    }

    this.recalculateTotal();
  }

  // Custom method to remove items
  removeItem(productId: string) {
    this.items = this.items.filter(item => item.productId !== productId);
    this.recalculateTotal();
  }

  // Private helper method
  private recalculateTotal() {
    this.total = this.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  }
}

interface CartItem {
  productId: string;
  quantity: number;
  price: number;
  addedAt: Date;
}
```

## 💾 Component Persistence

### Automatic Database Schema

When you create a component, BunSane automatically:

1. **Creates Database Tables**:
   - `components` - Stores component data as JSON
   - `entity_components` - Links entities to their components
   - `component_indexes` - Stores indexed field values

2. **Handles Data Types**:
   - Primitive types (string, number, boolean)
   - Complex objects and arrays
   - Date objects (stored as ISO strings)
   - Custom classes (serialized as JSON)

### Manual Persistence

```typescript
// Create component instance
const profile = new UserProfile();
profile.name = 'John Doe';
profile.email = 'john@example.com';
profile.username = 'johndoe';

// Save to database (called automatically when entity is saved)
await profile.save(entityId);
```

## 🔍 Component Queries

### Accessing Component Data

```typescript
// Get component from entity
const userEntity = await Entity.FindById(userId);
const profile = userEntity.get(UserProfile);

// Access data properties
console.log(profile.name); // 'John Doe'
console.log(profile.email); // 'john@example.com'

// Get all data as object
const profileData = profile.data();
console.log(profileData); // { name: 'John Doe', email: 'john@example.com', username: 'johndoe' }
```

### Component Metadata

```typescript
// Get component type ID
const typeId = profile.getTypeID();
console.log(typeId); // 'sha256_hash_of_UserProfile'

// Get component properties
const properties = profile.properties();
console.log(properties); // ['name', 'email', 'username']

// Get indexed properties
const indexedProps = profile.indexedProperties();
console.log(indexedProps); // ['username']
```

## 🔄 Component Updates

### Updating Component Data

```typescript
// Update existing component on entity
await userEntity.set(UserProfile, {
  name: 'Jane Doe',
  email: 'jane@example.com'
});

// Save changes
await userEntity.save();
```

### Partial Updates

```typescript
// Update only specific fields
const profile = userEntity.get(UserProfile);
profile.name = 'Updated Name';

// Mark as dirty for saving
profile.setDirty(true);
await userEntity.save();
```

## 🏷️ Component Relationships

### Reference Components

```typescript
@Component
export class BlogPost extends BaseComponent {
  @CompData()
  title: string = '';

  @CompData()
  content: string = '';

  @CompData({ indexed: true })
  authorId: string = ''; // Reference to User entity

  @CompData()
  categoryIds: string[] = []; // References to Category entities
}

@Component
export class Comment extends BaseComponent {
  @CompData()
  content: string = '';

  @CompData({ indexed: true })
  postId: string = ''; // Reference to BlogPost entity

  @CompData({ indexed: true })
  authorId: string = ''; // Reference to User entity

  @CompData()
  parentId?: string; // Reference to parent Comment (for nested comments)
}
```

### Polymorphic References

```typescript
@Component
export class Like extends BaseComponent {
  @CompData({ indexed: true })
  userId: string = '';

  @CompData({ indexed: true })
  targetType: 'post' | 'comment' | 'user' = 'post';

  @CompData({ indexed: true })
  targetId: string = '';

  @CompData()
  createdAt: Date = new Date();
}
```

## 🎨 Advanced Component Patterns

### Validation Components

```typescript
@Component
export class EmailValidation extends BaseComponent {
  @CompData()
  isValid: boolean = false;

  @CompData()
  validationErrors: string[] = [];

  @CompData()
  lastValidated: Date = new Date();

  // Custom validation method
  validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    this.isValid = emailRegex.test(email);

    if (!this.isValid) {
      this.validationErrors = ['Invalid email format'];
    } else {
      this.validationErrors = [];
    }

    this.lastValidated = new Date();
    return this.isValid;
  }
}
```

### Computed Properties

```typescript
@Component
export class ProductStats extends BaseComponent {
  @CompData()
  viewCount: number = 0;

  @CompData()
  purchaseCount: number = 0;

  @CompData()
  rating: number = 0;

  @CompData()
  reviewCount: number = 0;

  // Computed property (not stored in DB)
  get averageRating(): number {
    return this.reviewCount > 0 ? this.rating / this.reviewCount : 0;
  }

  // Computed property for popularity score
  get popularityScore(): number {
    return (this.viewCount * 0.3) + (this.purchaseCount * 0.7);
  }

  // Method to update stats
  recordView() {
    this.viewCount++;
  }

  recordPurchase() {
    this.purchaseCount++;
  }

  addRating(newRating: number) {
    this.rating = ((this.rating * this.reviewCount) + newRating) / (this.reviewCount + 1);
    this.reviewCount++;
  }
}
```

### Event Components

```typescript
@Component
export class AuditLog extends BaseComponent {
  @CompData({ indexed: true })
  entityId: string = '';

  @CompData({ indexed: true })
  action: 'create' | 'update' | 'delete' = 'create';

  @CompData()
  changes: Record<string, { old: any; new: any }> = {};

  @CompData()
  timestamp: Date = new Date();

  @CompData()
  userId?: string;

  @CompData()
  ipAddress?: string;

  // Method to record changes
  recordChanges(oldData: any, newData: any) {
    const changes: Record<string, { old: any; new: any }> = {};

    for (const key in newData) {
      if (oldData[key] !== newData[key]) {
        changes[key] = {
          old: oldData[key],
          new: newData[key]
        };
      }
    }

    this.changes = changes;
  }
}
```

## 🔧 Component Registry

### Component Management

```typescript
import ComponentRegistry from 'bunsane/core/ComponentRegistry';

// Check if component is registered
const isRegistered = ComponentRegistry.isComponentReady('UserProfile');
console.log(isRegistered); // true

// Get component ID
const componentId = ComponentRegistry.getComponentId('UserProfile');
console.log(componentId); // 'sha256_hash'

// Get all registered components
const allComponents = ComponentRegistry.getAllComponents();
console.log(allComponents); // ['UserProfile', 'ProductInfo', ...]
```

## 📈 Best Practices

### Component Design

- **Single Responsibility**: Each component should represent one clear concept
- **Minimal Data**: Keep components focused and avoid bloated data structures
- **Consistent Naming**: Use clear, descriptive names for components and properties
- **Index Strategically**: Only index fields that are frequently queried
- **Type Safety**: Leverage TypeScript for robust type checking

### Performance Considerations

- **Lazy Loading**: Only load components when needed
- **Batch Operations**: Use entity batching for multiple component operations
- **Efficient Queries**: Leverage indexed fields for fast lookups
- **Memory Management**: Be mindful of component size and complexity

### Error Handling

```typescript
try {
  const component = new UserProfile();
  component.name = userData.name;
  component.email = userData.email;

  // Validate before saving
  if (!component.email.includes('@')) {
    throw new Error('Invalid email format');
  }

  await entity.add(component).save();
} catch (error) {
  console.error('Failed to create user profile:', error);
  // Handle error appropriately
}
```

## 🚀 What's Next?

Now that you understand Components, let's explore:

- **[ArcheTypes](archetypes.md)** - Reusable entity templates
- **[Entity System](entity.md)** - How entities use components
- **[Query System](query.md)** - Efficient data retrieval
- **[Services](services.md)** - Business logic and GraphQL integration

---

*Ready to build with components? Let's look at [ArcheTypes](archetypes.md) next!* 🚀