# Core API Reference

This page provides detailed API reference for BunSane's core classes and functionality.

## 🏗️ Entity Class

The `Entity` class is the fundamental building block of BunSane's ECS architecture.

### Constructor

```typescript
new Entity(id?: string)
```

**Parameters:**
- `id` (optional): String - Unique identifier for the entity

### Static Methods

#### `Entity.Create()`

Creates a new entity instance with auto-generated ID.

```typescript
static Create(): Entity
```

**Returns:** `Entity` - New entity instance

**Example:**
```typescript
const user = Entity.Create();
// Entity has auto-generated ID like "01HXXXXXXXXXXXXXXXXXXXXX"
```

#### `Entity.FindById(id)`

Finds an entity by its ID.

```typescript
static async FindById(id: string): Promise<Entity | null>
```

**Parameters:**
- `id`: String - Entity ID to find

**Returns:** `Promise<Entity | null>` - Found entity or null

**Example:**
```typescript
const user = await Entity.FindById('01HXXXXXXXXXXXXXXXXXXXXX');
if (user) {
  console.log('User found:', user.id);
}
```

#### `Entity.LoadMultiple(ids)`

Loads multiple entities by their IDs.

```typescript
static async LoadMultiple(ids: string[]): Promise<Entity[]>
```

**Parameters:**
- `ids`: String[] - Array of entity IDs

**Returns:** `Promise<Entity[]>` - Array of found entities

**Example:**
```typescript
const userIds = ['01HXXX...', '01HYYY...'];
const users = await Entity.LoadMultiple(userIds);
console.log(`Loaded ${users.length} users`);
```

### Instance Methods

#### `entity.add(component, data)`

Adds a component to the entity.

```typescript
add<T extends BaseComponent>(
  ctor: new (...args: any[]) => T,
  data: Partial<ComponentDataType<T>>
): this
```

**Type Parameters:**
- `T`: Component class extending BaseComponent

**Parameters:**
- `ctor`: Component constructor
- `data`: Partial component data

**Returns:** `this` - Entity instance for chaining

**Example:**
```typescript
const user = Entity.Create();
user.add(UserProfile, {
  name: 'John Doe',
  email: 'john@example.com'
});
```

#### `entity.get(component)`

Gets a component from the entity.

```typescript
get<T extends BaseComponent>(ctor: new (...args: any[]) => T): T
```

**Type Parameters:**
- `T`: Component class

**Parameters:**
- `ctor`: Component constructor

**Returns:** `T` - Component instance

**Throws:** Error if component not found

**Example:**
```typescript
const profile = user.get(UserProfile);
console.log(profile.name); // 'John Doe'
```

#### `entity.has(component)`

Checks if entity has a specific component.

```typescript
has<T extends BaseComponent>(ctor: new (...args: any[]) => T): boolean
```

**Type Parameters:**
- `T`: Component class

**Parameters:**
- `ctor`: Component constructor

**Returns:** `boolean` - True if component exists

**Example:**
```typescript
if (user.has(UserProfile)) {
  const profile = user.get(UserProfile);
  console.log('User name:', profile.name);
}
```

#### `entity.set(component, data)`

Updates or adds a component with new data.

```typescript
set<T extends BaseComponent>(
  ctor: new (...args: any[]) => T,
  data: Partial<ComponentDataType<T>>
): this
```

**Type Parameters:**
- `T`: Component class

**Parameters:**
- `ctor`: Component constructor
- `data`: Partial component data

**Returns:** `this` - Entity instance for chaining

**Example:**
```typescript
user.set(UserProfile, {
  name: 'Jane Doe',
  email: 'jane@example.com'
});
```

#### `entity.save()`

Saves the entity and all its components to the database.

```typescript
async save(): Promise<void>
```

**Returns:** `Promise<void>`

**Example:**
```typescript
await user.save();
console.log('User saved with ID:', user.id);
```

#### `entity.delete(force)`

Marks the entity as deleted (soft delete) or permanently deletes it.

```typescript
async delete(force?: boolean): Promise<void>
```

**Parameters:**
- `force` (optional): Boolean - If true, permanently delete

**Returns:** `Promise<void>`

**Example:**
```typescript
// Soft delete
await user.delete();

// Permanent delete
await user.delete(true);
```

#### `entity.componentList()`

Gets all components attached to the entity.

```typescript
componentList(): BaseComponent[]
```

**Returns:** `BaseComponent[]` - Array of component instances

**Example:**
```typescript
const components = user.componentList();
console.log(`Entity has ${components.length} components`);
```

## 🧩 BaseComponent Class

Base class for all components in BunSane.

### Properties

#### `id`
```typescript
id: string
```
Unique identifier for the component instance.

#### `_persisted`
```typescript
protected _persisted: boolean = false
```
Whether the component has been saved to the database.

#### `_dirty`
```typescript
protected _dirty: boolean = false
```
Whether the component has unsaved changes.

### Methods

#### `getTypeID()`

Gets the component's type identifier.

```typescript
getTypeID(): string
```

**Returns:** `string` - Type identifier (SHA256 hash of class name)

**Example:**
```typescript
const typeId = profile.getTypeID();
console.log(typeId); // 'a1b2c3d4...'
```

#### `properties()`

Gets all property names marked with @CompData.

```typescript
properties(): string[]
```

**Returns:** `string[]` - Array of property names

**Example:**
```typescript
const props = profile.properties();
console.log(props); // ['name', 'email', 'username']
```

#### `data()`

Gets all component data as a plain object.

```typescript
data<T extends this>(): ComponentDataType<T>
```

**Type Parameters:**
- `T`: Component class

**Returns:** `ComponentDataType<T>` - Plain object with component data

**Example:**
```typescript
const data = profile.data();
console.log(data); // { name: 'John', email: 'john@example.com' }
```

#### `indexedProperties()`

Gets property names marked with @CompData({ indexed: true }).

```typescript
indexedProperties(): string[]
```

**Returns:** `string[]` - Array of indexed property names

**Example:**
```typescript
const indexed = profile.indexedProperties();
console.log(indexed); // ['email', 'username']
```

## 🏛️ ArcheType Class

Template system for creating entities with predefined components.

### Constructor

```typescript
new ArcheType(components: (new () => BaseComponent)[])
```

**Parameters:**
- `components`: Array of component constructors

### Methods

#### `createEntity()`

Creates a new entity with all archetype components.

```typescript
createEntity(): Entity
```

**Returns:** `Entity` - New entity with all components attached

**Example:**
```typescript
const userEntity = UserArcheType.createEntity();
// Entity has UserProfile, UserPreferences, UserStats components
```

#### `fill(data)`

Fills archetype with data for entity creation.

```typescript
fill(data: object, strict?: boolean): this
```

**Parameters:**
- `data`: Object - Data to fill components
- `strict` (optional): Boolean - Whether to enforce strict data matching

**Returns:** `this` - ArcheType instance for chaining

**Example:**
```typescript
const userEntity = UserArcheType.fill({
  userProfile: { name: 'John', email: 'john@example.com' },
  userPreferences: { theme: 'dark' }
}).createEntity();
```

#### `createAndSaveEntity()`

Creates and immediately saves an entity.

```typescript
async createAndSaveEntity(): Promise<Entity>
```

**Returns:** `Promise<Entity>` - Saved entity

**Example:**
```typescript
const user = await UserArcheType.fill(userData).createAndSaveEntity();
console.log('Created user:', user.id);
```

#### `Unwrap(entity, exclude)`

Converts entity back to plain object.

```typescript
async Unwrap(entity: Entity, exclude?: string[]): Promise<Record<string, any>>
```

**Parameters:**
- `entity`: Entity - Entity to unwrap
- `exclude` (optional): String[] - Property names to exclude

**Returns:** `Promise<Record<string, any>>` - Plain object with component data

**Example:**
```typescript
const userData = await UserArcheType.Unwrap(userEntity);
console.log(userData);
// {
//   userProfile: { name: 'John', email: 'john@example.com' },
//   userPreferences: { theme: 'dark' }
// }
```

#### `updateEntity(entity, updates)`

Updates an existing entity using archetype data structure.

```typescript
async updateEntity<T>(entity: Entity, updates: Partial<T>): Promise<void>
```

**Type Parameters:**
- `T`: Update data type

**Parameters:**
- `entity`: Entity - Entity to update
- `updates`: Partial<T> - Updates to apply

**Returns:** `Promise<void>`

**Example:**
```typescript
await UserArcheType.updateEntity(userEntity, {
  userProfile: { name: 'Jane Doe' },
  userPreferences: { theme: 'light' }
});
```

## 🎨 Decorators

### @Component

Marks a class as a BunSane component.

```typescript
@Component(target: any): any
```

**Parameters:**
- `target`: Class constructor to decorate

**Example:**
```typescript
@Component
export class UserProfile extends BaseComponent {
  // Component implementation
}
```

### @CompData

Marks a property as component data.

```typescript
@CompData(options?: { indexed?: boolean }): PropertyDecorator
```

**Parameters:**
- `options.indexed` (optional): Boolean - Whether to create database index

**Example:**
```typescript
@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData({ indexed: true })
  email: string = '';
}
```

## 📊 Type Definitions

### ComponentDataType<T>

Extracts data properties from a component class.

```typescript
type ComponentDataType<T extends BaseComponent> = {
  [K in keyof T as T[K] extends Function ? never :
                  K extends `_${string}` ? never :
                  K extends 'id' | 'getTypeID' | 'properties' | 'data' | 'save' | 'insert' | 'update' ? never :
                  K]: T[K];
};
```

### ComponentGetter<T>

Type for accessing component data and methods.

```typescript
type ComponentGetter<T extends BaseComponent> = Pick<T, "properties" | "id"> & {
  data(): ComponentDataType<T>;
};
```

## 🚨 Error Types

### Component Errors

```typescript
class ComponentNotFoundError extends Error {
  constructor(componentName: string) {
    super(`Component ${componentName} not found`);
  }
}

class ComponentNotRegisteredError extends Error {
  constructor(componentName: string) {
    super(`Component ${componentName} is not registered`);
  }
}
```

### Entity Errors

```typescript
class EntityNotFoundError extends Error {
  constructor(entityId: string) {
    super(`Entity ${entityId} not found`);
  }
}

class EntityValidationError extends Error {
  constructor(message: string, entityId: string) {
    super(`Entity validation failed: ${message}`);
    this.entityId = entityId;
  }
}
```

## 📈 Performance Notes

- **Entity Creation**: Use `ArcheType.createEntity()` for consistent component sets
- **Bulk Operations**: Use `Entity.LoadMultiple()` for loading multiple entities
- **Component Access**: Cache component references when accessing repeatedly
- **Database Indexes**: Use `@CompData({ indexed: true })` for frequently queried fields

## 🔗 Related APIs

- **[Query API](query.md)** - Database querying
- **[Service API](service.md)** - Business logic layer
- **[Hooks API](hooks.md)** - Lifecycle events

---

*Need more details? Check the [Query API](query.md) for database operations!* 🚀