# Query API Reference

This page provides detailed API reference for BunSane's query system and database operations.

## 🔍 Query Class

The `Query` class provides a fluent interface for building database queries based on Entity-Component-System (ECS) architecture.

### Constructor

```typescript
new Query()
```

Creates a new query instance. Queries are built by chaining methods to specify which components are required, optional filters, sorting, and pagination.

**Returns:** `Query` - New query instance

**Example:**
```typescript
const query = new Query();
```

### Static Filter Methods

#### `Query.filter(field, operator, value)`

Creates a filter object for use with component queries.

```typescript
static filter(field: string, operator: FilterOperator, value: any): QueryFilter
```

**Parameters:**
- `field`: String - The component data field name
- `operator`: FilterOperator - Comparison operator (`=`, `>`, `<`, `>=`, `<=`, `!=`, `LIKE`, `IN`, `NOT IN`)
- `value`: Any - Value to compare against

**Returns:** `QueryFilter` - Filter configuration object

**Example:**
```typescript
const emailFilter = Query.filter("value", Query.filterOp.EQ, "user@example.com");
```

#### `Query.typedFilter(componentCtor, field, operator, value)`

Creates a type-safe filter for a specific component.

```typescript
static typedFilter<T extends BaseComponent>(
  componentCtor: new (...args: any[]) => T,
  field: keyof ComponentDataType<T>,
  operator: FilterOperator,
  value: any
): QueryFilter
```

**Type Parameters:**
- `T`: Component class extending BaseComponent

**Parameters:**
- `componentCtor`: Component constructor
- `field`: keyof ComponentDataType<T> - Component data field
- `operator`: FilterOperator - Comparison operator
- `value`: Any - Value to compare against

**Returns:** `QueryFilter` - Filter configuration object

**Example:**
```typescript
const nameFilter = Query.typedFilter(NameComponent, "value", Query.filterOp.LIKE, "John%");
```

#### `Query.filters(...filters)`

Creates filter options from multiple filter objects.

```typescript
static filters(...filters: QueryFilter[]): QueryFilterOptions
```

**Parameters:**
- `filters`: QueryFilter[] - Array of filter objects

**Returns:** `QueryFilterOptions` - Filter options for component queries

**Example:**
```typescript
const filterOptions = Query.filters(
  Query.filter("value", Query.filterOp.EQ, "active"),
  Query.filter("value", Query.filterOp.GT, 100)
);
```

### Filter Operators

The `FilterOp` object provides constants for filter operators:

```typescript
FilterOp.EQ      // "="
FilterOp.GT      // ">"
FilterOp.LT      // "<"
FilterOp.GTE     // ">="
FilterOp.LTE     // "<="
FilterOp.NEQ     // "!="
FilterOp.LIKE    // "LIKE"
FilterOp.IN      // "IN"
FilterOp.NOT_IN  // "NOT IN"
```

### Instance Methods

#### `query.with(componentCtor, options?)`

Adds a required component to the query. Entities must have this component to be included in results.

```typescript
with<T extends BaseComponent>(
  ctor: new (...args: any[]) => T,
  options?: QueryFilterOptions
): this
```

**Type Parameters:**
- `T`: Component class extending BaseComponent

**Parameters:**
- `ctor`: Component constructor - The component class that entities must have
- `options` (optional): QueryFilterOptions - Filters to apply to this component

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const users = await new Query()
  .with(UserTag)
  .with(EmailComponent, Query.filters(
    Query.filter("value", Query.filterOp.LIKE, "%@example.com")
  ))
  .exec();
```

#### `query.without(componentCtor)`

Excludes entities that have the specified component.

```typescript
without<T extends BaseComponent>(ctor: new (...args: any[]) => T): this
```

**Type Parameters:**
- `T`: Component class extending BaseComponent

**Parameters:**
- `ctor`: Component constructor - The component that entities must NOT have

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const activeUsers = await new Query()
  .with(UserTag)
  .without(BannedComponent)
  .exec();
```

#### `query.eagerLoadComponents(componentCtors)`

Eager loads the specified components for all matching entities. This improves performance by batch loading component data.

```typescript
eagerLoadComponents(ctors: Array<new () => BaseComponent>): this
```

**Parameters:**
- `ctors`: Array<new () => BaseComponent> - Array of component constructors to eager load

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const users = await new Query()
  .with(UserTag)
  .eagerLoadComponents([NameComponent, EmailComponent, PhoneComponent])
  .exec();
```

#### `query.populate()`

Pre-fills entity objects with the components specified in `.with()` calls. When enabled, entities returned by `.exec()` will have their components already loaded in memory, avoiding the need for subsequent database queries when calling `entity.get()` or `entity.getComponent()` on those specific components.

```typescript
populate(): this
```

**Returns:** `this` - Query instance for chaining

**Behavior:**
- Performs a single bulk query to fetch all requested components for all matching entities
- Components are attached to entities during query execution
- Only populates components specified in `.with()` calls
- Significantly improves performance when you know you'll need component data
- Entities returned will have components already cached, so `entity.get(Component)` won't trigger additional database queries

**Example:**
```typescript
const users = await new Query()
  .with(NameComponent)
  .with(EmailComponent)
  .populate()
  .exec();

// No additional database queries - components already loaded
for (const user of users) {
  const name = await user.get(NameComponent);  // Instant - already in memory
  const email = await user.get(EmailComponent); // Instant - already in memory
}
```

**Performance Note:** Without `.populate()`, each `entity.get()` call would trigger a separate database query. With `.populate()`, all component data is fetched in one optimized bulk query.

#### `query.findById(id)`

Filters results to only include the entity with the specified ID.

```typescript
findById(id: string): this
```

**Parameters:**
- `id`: String - Entity ID to find

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const user = await new Query()
  .with(UserTag)
  .findById("01HXXX...")
  .exec();
```

#### `query.take(limit)`

Limits the number of results returned.

```typescript
take(limit: number): this
```

**Parameters:**
- `limit`: Number - Maximum number of entities to return

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const firstTenUsers = await new Query()
  .with(UserTag)
  .take(10)
  .exec();
```

#### `query.offset(offset)`

Skips the first N results (for pagination).

```typescript
offset(offset: number): this
```

**Parameters:**
- `offset`: Number - Number of results to skip

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const pageTwoUsers = await new Query()
  .with(UserTag)
  .take(10)
  .offset(10) // Skip first 10, get next 10
  .exec();
```

#### `query.sortBy(componentCtor, property, direction?, nullsFirst?)`

Sorts results by a component property.

```typescript
sortBy<T extends BaseComponent>(
  componentCtor: new (...args: any[]) => T,
  property: keyof ComponentDataType<T>,
  direction?: SortDirection,
  nullsFirst?: boolean
): this
```

**Type Parameters:**
- `T`: Component class extending BaseComponent

**Parameters:**
- `componentCtor`: Component constructor - Component to sort by
- `property`: keyof ComponentDataType<T> - Property name to sort by
- `direction` (optional): "ASC" | "DESC" - Sort direction (default: "ASC")
- `nullsFirst` (optional): Boolean - Whether nulls should appear first (default: false)

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const sortedUsers = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .sortBy(NameComponent, "value", "ASC")
  .exec();
```

#### `query.orderBy(orders)`

Sorts results by multiple criteria using SortOrder objects.

```typescript
orderBy(orders: SortOrder[]): this
```

**Parameters:**
- `orders`: SortOrder[] - Array of sort specifications

**Returns:** `this` - Query instance for chaining

**Example:**
```typescript
const sortedUsers = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .with(EmailComponent)
  .orderBy([
    { component: "NameComponent", property: "value", direction: "ASC" },
    { component: "EmailComponent", property: "value", direction: "DESC" }
  ])
  .exec();
```

#### `query.exec()`

Executes the query and returns matching entities.

```typescript
async exec(): Promise<Entity[]>
```

**Returns:** `Promise<Entity[]>` - Array of Entity objects matching the query criteria

**Example:**
```typescript
const users = await new Query()
  .with(UserTag)
  .exec();
```

#### `query.findOneById(id)`

Convenience method to find and return a single entity by ID.

```typescript
async findOneById(id: string): Promise<Entity | null>
```

**Parameters:**
- `id`: String - Entity ID to find

**Returns:** `Promise<Entity | null>` - Single entity or null if not found

**Example:**
```typescript
const user = await new Query()
  .findOneById("01HXXX...");
```

## 📋 QueryCondition & Filter Types

### QueryFilter

Interface for defining component filters.

```typescript
interface QueryFilter {
    field: string;
    operator: FilterOperator;
    value: any;
}
```

### QueryFilterOptions

Interface for filter options.

```typescript
interface QueryFilterOptions {
    filters: QueryFilter[];
}
```

### SortOrder

Interface for sort specifications.

```typescript
interface SortOrder {
    component: string;
    property: string;
    direction: SortDirection;
    nullsFirst?: boolean;
}
```

### FilterOperator

Supported filter operators:

```typescript
type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "IN" | "NOT IN";
```

## 🔍 Query Examples

### Basic Component Queries

#### Find all users
```typescript
const users = await new Query()
  .with(UserTag)
  .exec();
```

#### Find users with specific email
```typescript
const users = await new Query()
  .with(UserTag)
  .with(EmailComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "john@example.com")
  ))
  .exec();
```

#### Find active users (exclude banned)
```typescript
const activeUsers = await new Query()
  .with(UserTag)
  .without(BannedComponent)
  .exec();
```

### Filtering Examples

#### Multiple filters on same component
```typescript
const filteredUsers = await new Query()
  .with(UserTag)
  .with(NameComponent, Query.filters(
    Query.filter("value", Query.filterOp.LIKE, "John%")
  ))
  .with(EmailComponent, Query.filters(
    Query.filter("value", Query.filterOp.LIKE, "%@example.com")
  ))
  .exec();
```

#### Using IN operator
```typescript
const admins = await new Query()
  .with(UserTag)
  .with(RoleComponent, Query.filters(
    Query.filter("value", Query.filterOp.IN, ["admin", "moderator"])
  ))
  .exec();
```

#### Range queries
```typescript
const recentUsers = await new Query()
  .with(UserTag)
  .with(CreatedAtComponent, Query.filters(
    Query.filter("value", Query.filterOp.GTE, new Date('2024-01-01'))
  ))
  .exec();
```

### Eager Loading

#### Load multiple components efficiently
```typescript
const usersWithDetails = await new Query()
  .with(UserTag)
  .eagerLoadComponents([NameComponent, EmailComponent, PhoneComponent])
  .exec();
```

#### Full entity population
```typescript
const fullUsers = await new Query()
  .with(UserTag)
  .populate() // Loads all components for each entity
  .exec();
```

### Sorting and Pagination

#### Sort by name
```typescript
const sortedUsers = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .sortBy(NameComponent, "value", "ASC")
  .exec();
```

#### Multiple sort criteria
```typescript
const sortedUsers = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .with(CreatedAtComponent)
  .orderBy([
    { component: "NameComponent", property: "value", direction: "ASC" },
    { component: "CreatedAtComponent", property: "value", direction: "DESC" }
  ])
  .exec();
```

#### Pagination
```typescript
const pageSize = 20;
const page = 2;

const users = await new Query()
  .with(UserTag)
  .take(pageSize)
  .offset((page - 1) * pageSize)
  .exec();
```

### Real-world Usage Patterns

#### User Service Query (from UserService.ts)
```typescript
const query = new Query()
  .with(UserTag)
  .with(EmailComponent, 
    Query.filters(
      Query.filter("value", Query.filterOp.EQ, input.email)
    )
  )
  .exec();
```

#### Post Service Query with Relationships (from PostService.ts)
```typescript
const query = new Query()
  .with(PostTag)
  .with(AuthorComponent, 
    Query.filters(
      Query.filter("value", Query.filterOp.IN, userIds)
    )
  )
  .eagerLoadComponents(postComponentsToLoad)
  .exec();
```

#### Finding by ID
```typescript
const user = await new Query()
  .with(UserTag)
  .findById(userId)
  .exec();
```

## 🔗 Advanced Query Features

### Component Archetypes

Queries work with component archetypes - groups of components that define entity types:

```typescript
const UserArcheType = new ArcheType([
  UserTag,
  NameComponent,
  EmailComponent,
  PasswordComponent
]);
```

### Batch Loading Relationships

For efficient relationship loading, use batch loaders:

```typescript
// Preload related entities
context.authors = await BatchLoader.loadRelatedEntitiesBatched(
  posts,
  AuthorComponent,
  Entity.LoadMultiple
);
```

### Performance Optimization

#### Use eager loading for frequently accessed components
```typescript
const users = await new Query()
  .with(UserTag)
  .eagerLoadComponents([NameComponent, EmailComponent]) // Batch load
  .exec();
```

#### Filter early to reduce data transfer
```typescript
const activeUsers = await new Query()
  .with(UserTag)
  .with(StatusComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "active")
  ))
  .exec();
```

#### Use pagination for large result sets
```typescript
const users = await new Query()
  .with(UserTag)
  .take(50)
  .offset(0)
  .exec();
```

## 🚀 Performance Optimization

### Indexing Strategy

Components are automatically indexed by entity_id and type_id. For optimal performance:

- Filter on component data fields that are frequently queried
- Use `eagerLoadComponents()` for components accessed together
- Prefer `populate()` only when you need all component data

### Query Optimization Tips

- **Use specific component requirements** - only include components you need with `.with()`
- **Eager load related components** - use `.eagerLoadComponents()` to batch load component data
- **Filter at the component level** - apply filters to specific components rather than post-processing
- **Use pagination** - always use `.take()` and `.offset()` for large datasets
- **Batch operations** - load related entities in batches using BatchLoader

### Execution Time Monitoring

```typescript
const startTime = Date.now();

const results = await new Query()
  .with(UserTag)
  .exec();

const executionTime = Date.now() - startTime;
console.log(`Query executed in ${executionTime}ms`);
```

## 📊 Query Statistics

### Result Analysis

```typescript
const query = new Query().with(UserTag);

const results = await query.take(10).exec();
console.log(`Found ${results.length} users (limited to 10)`);
```

### Memory Considerations

- `exec()` returns lightweight Entity objects by default
- Use `eagerLoadComponents()` to load component data efficiently
- Use `populate()` sparingly as it loads all components for each entity

## 🔗 Related APIs

- **[Entity API](entity.md)** - Entity operations and lifecycle
- **[Component API](components.md)** - Component management and data access
- **[Service API](service.md)** - Business logic layer using queries
- **[BatchLoader API](batch-loader.md)** - Efficient relationship loading

---

*Need more details? Check the [Service API](service.md) for real-world query usage patterns!* 🚀