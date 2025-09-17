# Query System

BunSane's Query system provides a powerful, type-safe way to retrieve and filter entities from your database. It supports complex filtering, relationships, sorting, pagination, and eager loading - all while maintaining excellent performance.

## 🎯 What is the Query System?

The Query system is BunSane's fluent API for database operations. Unlike traditional ORMs, it works directly with your Entity-Component-System architecture, providing efficient queries that leverage your component structure.

### Key Features

- **Type Safety**: Full TypeScript support with compile-time guarantees
- **Fluent API**: Chainable methods for building complex queries
- **Component-Based**: Query by component presence and data
- **Relationship Support**: Efficient loading of related entities
- **Performance Optimized**: Smart query generation and execution
- **Pagination**: Built-in support for offset-based pagination

## 🏗️ Basic Queries

### Simple Component Queries

```typescript
import { Query } from 'bunsane';

// Find all entities with UserTag component
const users = await new Query()
  .with(UserTag)
  .exec();

// Find entities with multiple required components
const usersWithDetails = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .with(EmailComponent)
  .exec();
```

### Single Entity Queries

```typescript
// Find entity by ID
const user = await new Query()
  .with(UserTag)
  .findById('user-123')
  .exec();

// Convenience method for single entity
const userEntity = await new Query()
  .findOneById('user-123');
```

## 🔍 Filtering

### Component-Based Filters

```typescript
// Filter by component data using Query.filter()
const users = await new Query()
  .with(UserTag)
  .with(EmailComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "john@example.com")
  ))
  .exec();

// Multiple filters on same component (AND condition)
const premiumUsers = await new Query()
  .with(UserTag)
  .with(StatusComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "active")
  ))
  .with(PlanComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "premium")
  ))
  .exec();
```

### Advanced Filtering

```typescript
// Range filters
const recentUsers = await new Query()
  .with(UserTag)
  .with(CreatedAtComponent, Query.filters(
    Query.filter("value", Query.filterOp.GTE, new Date('2025-01-01')),
    Query.filter("value", Query.filterOp.LTE, new Date('2025-12-31'))
  ))
  .exec();

// LIKE queries
const johnUsers = await new Query()
  .with(UserTag)
  .with(NameComponent, Query.filters(
    Query.filter("value", Query.filterOp.LIKE, "John%")
  ))
  .exec();

// IN queries
const specificUsers = await new Query()
  .with(UserTag)
  .with(AuthorComponent, Query.filters(
    Query.filter("value", Query.filterOp.IN, ["user-1", "user-2", "user-3"])
  ))
  .exec();
```

### Exclusion Filters

```typescript
// Exclude entities with certain components
const activeUsers = await new Query()
  .with(UserTag)
  .without(BannedComponent)
  .exec();

// Combine inclusion and exclusion
const verifiedUnbannedUsers = await new Query()
  .with(UserTag)
  .with(VerifiedComponent)
  .without(BannedComponent)
  .exec();
```

## 🔗 Relationships and Eager Loading

### Component Relationships

```typescript
// Query posts with author information
const posts = await new Query()
  .with(PostTag)
  .with(AuthorComponent)
  .exec();

// Load related components efficiently
const postsWithDetails = await new Query()
  .with(PostTag)
  .eagerLoadComponents([
    TitleComponent,
    ContentComponent,
    DateComponent
  ])
  .exec();

// Each post entity will have related components loaded
for (const post of postsWithDetails) {
  const title = await post.get(TitleComponent);
  const content = await post.get(ContentComponent);
  console.log(`Post: ${title?.value}, Content: ${content?.value}`);
}
```

### Batch Loading Related Entities

```typescript
import { BatchLoader } from 'bunsane';

// Load posts with their authors in batch
const posts = await new Query()
  .with(PostTag)
  .exec();

// Batch load all authors
const authors = await BatchLoader.loadRelatedEntitiesBatched(
  posts,
  AuthorComponent,
  Entity.LoadMultiple
);

// Associate authors with posts
const postsWithAuthors = posts.map(post => ({
  post,
  author: authors.get(post.id)
}));
```

### Full Entity Population

```typescript
// Load complete entity data
const fullPosts = await new Query()
  .with(PostTag)
  .populate() // Loads all components for each entity
  .exec();

// Now all component data is immediately available
for (const post of fullPosts) {
  // No async calls needed - all data is loaded
  const title = post.get(TitleComponent);
  const content = post.get(ContentComponent);
  const author = post.get(AuthorComponent);
}
```

## 📊 Sorting and Ordering

### Basic Sorting

```typescript
// Sort by component field
const usersByName = await new Query()
  .with(UserTag)
  .with(NameComponent)
  .sortBy(NameComponent, "value", "ASC")
  .exec();

// Sort by multiple fields
const usersByStatusAndName = await new Query()
  .with(UserTag)
  .with(StatusComponent)
  .with(NameComponent)
  .orderBy([
    { component: "StatusComponent", property: "value", direction: "DESC" },
    { component: "NameComponent", property: "value", direction: "ASC" }
  ])
  .exec();
```

### Advanced Sorting

```typescript
// Sort with null handling
const usersByLastLogin = await new Query()
  .with(UserTag)
  .with(LastLoginComponent)
  .sortBy(LastLoginComponent, "value", "DESC", true) // nulls first
  .exec();

// Multiple sort criteria with different null handling
const sortedUsers = await new Query()
  .with(UserTag)
  .with(PriorityComponent)
  .with(NameComponent)
  .orderBy([
    { component: "PriorityComponent", property: "value", direction: "DESC", nullsFirst: false },
    { component: "NameComponent", property: "value", direction: "ASC", nullsFirst: false }
  ])
  .exec();
```

## 📄 Pagination

### Offset-Based Pagination

```typescript
// Basic pagination
const page1 = await new Query()
  .with(UserTag)
  .take(10)
  .offset(0)
  .exec();

const page2 = await new Query()
  .with(UserTag)
  .take(10)
  .offset(10)
  .exec();
```

### Pagination Helper

```typescript
class PaginatedQuery {
  static async execute(query: Query, page: number = 1, limit: number = 10) {
    const offset = (page - 1) * limit;

    // Get paginated results
    const results = await query
      .take(limit)
      .offset(offset)
      .exec();

    return {
      data: results,
      pagination: {
        page,
        limit,
        offset,
        hasNext: results.length === limit,
        hasPrev: page > 1
      }
    };
  }
}

// Usage
const result = await PaginatedQuery.execute(
  new Query().with(UserTag),
  2, // page
  20 // limit
);

console.log(result.pagination);
// { page: 2, limit: 20, offset: 20, hasNext: true, hasPrev: true }
```

## 🎯 Advanced Query Patterns

### Conditional Query Building

```typescript
class UserQueryBuilder {
  private query: Query;

  constructor() {
    this.query = new Query().with(UserTag);
  }

  withStatus(status?: string) {
    if (status) {
      this.query = this.query.with(StatusComponent, Query.filters(
        Query.filter("value", Query.filterOp.EQ, status)
      ));
    }
    return this;
  }

  withRole(role?: string) {
    if (role) {
      this.query = this.query.with(RoleComponent, Query.filters(
        Query.filter("value", Query.filterOp.EQ, role)
      ));
    }
    return this;
  }

  withDateRange(startDate?: Date, endDate?: Date) {
    if (startDate || endDate) {
      const filters = [];
      if (startDate) {
        filters.push(Query.filter("value", Query.filterOp.GTE, startDate));
      }
      if (endDate) {
        filters.push(Query.filter("value", Query.filterOp.LTE, endDate));
      }
      this.query = this.query.with(CreatedAtComponent, Query.filters(...filters));
    }
    return this;
  }

  async execute() {
    return await this.query.exec();
  }
}

// Usage
const users = await new UserQueryBuilder()
  .withStatus('active')
  .withRole('admin')
  .withDateRange(new Date('2025-01-01'), new Date('2025-12-31'))
  .execute();
```

### Query Composition

```typescript
// Base queries
const baseUserQuery = new Query().with(UserTag);

const activeUsersQuery = baseUserQuery
  .with(StatusComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "active")
  ));

const adminQuery = activeUsersQuery
  .with(RoleComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "admin")
  ));

const premiumQuery = activeUsersQuery
  .with(PlanComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "premium")
  ));

// Execute multiple queries
const [admins, premiumUsers] = await Promise.all([
  adminQuery.exec(),
  premiumQuery.exec()
]);
```

### Real-world Service Patterns

Based on actual service implementations:

```typescript
// From UserService.ts - Finding users by email
const userCheck = await new Query()
  .with(UserTag)
  .with(EmailComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, input.email)
  ))
  .exec();

// From PostService.ts - Posts with eager loading
const posts = await new Query()
  .with(PostTag)
  .eagerLoadComponents([
    TitleComponent,
    ContentComponent,
    AuthorComponent,
    ImageViewComponent
  ])
  .exec();

// From PostService.ts - Related entity batch loading
if (isFieldRequested(info, 'author')) {
  context.authors = await BatchLoader.loadRelatedEntitiesBatched(
    entities,
    AuthorComponent,
    Entity.LoadMultiple
  );
}
```

## ⚡ Performance Optimization

### Efficient Loading Strategies

```typescript
// Use eager loading to reduce database round trips
const postsWithDetails = await new Query()
  .with(PostTag)
  .eagerLoadComponents([
    TitleComponent,
    ContentComponent,
    AuthorComponent,
    DateComponent
  ])
  .exec();

// Single query loads all required data
for (const post of postsWithDetails) {
  const title = await post.get(TitleComponent);
  const content = await post.get(ContentComponent);
  const author = await post.get(AuthorComponent);
  // Components are already loaded - no additional queries
}
```

### Query Result Caching

```typescript
class CachedQuery {
  private static cache = new Map<string, { data: any[], timestamp: number }>();
  private static CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  static async execute(query: Query, cacheKey: string) {
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    // Execute query
    const data = await query.exec();

    // Cache result
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    return data;
  }

  static invalidate(cacheKey: string) {
    this.cache.delete(cacheKey);
  }

  static clearAll() {
    this.cache.clear();
  }
}

// Usage
const users = await CachedQuery.execute(
  new Query().with(UserTag),
  'active-users'
);
```

### Component Design for Query Performance

```typescript
// Design components to optimize queries
@Component
class UserStatusComponent extends BaseComponent {
  @CompData()
  value: 'active' | 'inactive' | 'banned' = 'active';
}

@Component
class UserEmailComponent extends BaseComponent {
  @CompData()
  value: string = '';
}

// Efficient queries leverage component structure
const activeUsers = await new Query()
  .with(UserTag)
  .with(UserStatusComponent, Query.filters(
    Query.filter("value", Query.filterOp.EQ, "active")
  ))
  .eagerLoadComponents([UserEmailComponent])
  .exec();
```

## 🔧 Best Practices

### Query Design

- **Component-First**: Design queries around component requirements
- **Eager Loading**: Use `eagerLoadComponents()` for frequently accessed data
- **Selective Filtering**: Apply filters at the component level for precision
- **Pagination**: Always use `take()` and `offset()` for large result sets
- **Batch Operations**: Use BatchLoader for relationship loading

### Error Handling

```typescript
try {
  const users = await new Query()
    .with(UserTag)
    .with(EmailComponent, Query.filters(
      Query.filter("value", Query.filterOp.EQ, userEmail)
    ))
    .exec();

  if (users.length === 0) {
    throw new Error('User not found');
  }

  return users[0];

} catch (error) {
  logger.error('Query failed', {
    error: error.message,
    query: 'findUserByEmail',
    email: userEmail
  });

  throw new Error('Unable to find user');
}
```

### Query Validation

```typescript
class ValidatedQuery {
  static async safeExecute(query: Query, options: {
    maxResults?: number;
    timeout?: number;
  } = {}) {
    const { maxResults = 1000, timeout = 30000 } = options;

    // Add safety limits
    query = query.take(maxResults);

    // Execute with timeout
    const result = await Promise.race([
      query.exec(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), timeout)
      )
    ]);

    return result;
  }
}

// Usage
const users = await ValidatedQuery.safeExecute(
  new Query().with(UserTag),
  { maxResults: 100, timeout: 10000 }
);
```

## 🚀 What's Next?

Now that you understand the Query system, let's explore:

- **[Lifecycle Hooks](hooks.md)** - Business logic integration
- **[Entity System](entity.md)** - How entities work with queries
- **[Services](services.md)** - Using queries in services

---

*Ready to master data retrieval? Let's look at [Lifecycle Hooks](hooks.md) next!* 🚀