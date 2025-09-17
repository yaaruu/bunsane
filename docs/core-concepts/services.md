# Service System

Services are BunSane's business logic layer that provide a clean separation between your application's logic and data layer. Services extend `BaseService` and can integrate with GraphQL resolvers for API endpoints.

## 🎯 What is a Service?

A Service is a class that contains your application's business logic. Services extend `BaseService` and work with the service registry for dependency management.

### Key Features

- **Business Logic Organization**: Clean separation of concerns
- **Type Safety**: Full TypeScript integration with compile-time guarantees
- **Dependency Injection**: Built-in service registry and dependency management
- **GraphQL Integration**: Can be used with GraphQL resolvers
- **Validation**: Input validation and error handling

## 🏗️ Creating Services

### Basic Service Structure

```typescript
import { BaseService, ServiceRegistry } from 'bunsane';

export default class UserService extends BaseService {
  async createUser(userData: { name: string; email: string; username: string }) {
    const userEntity = UserArcheType.fill(userData).createEntity();
    await userEntity.save();
    return await UserArcheType.Unwrap(userEntity);
  }

  async getUser(args: { id: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) return null;
    return await UserArcheType.Unwrap(entity);
  }

  async updateUser(args: any) {
    const entity = await Entity.FindById(args.id);
    if (!entity) throw new Error('User not found');

    await UserArcheType.updateEntity(entity, args);
    await entity.save();
    return await UserArcheType.Unwrap(entity);
  }
}

// Services are automatically registered when imported
// No manual registration needed
```

### GraphQL Service with Decorators

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
export default class UserService extends BaseService {
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
}
```

## 📊 GraphQL Type Definitions

### Field Types

BunSane provides predefined GraphQL field types for common use cases:

```typescript
import { GraphQLFieldTypes } from 'bunsane';

// Available field types
const fieldTypes = {
  // ID fields
  ID_REQUIRED: GraphQLFieldTypes.ID_REQUIRED,           // ID!
  ID_OPTIONAL: GraphQLFieldTypes.ID_OPTIONAL,           // ID

  // String fields
  STRING_REQUIRED: GraphQLFieldTypes.STRING_REQUIRED,   // String!
  STRING_OPTIONAL: GraphQLFieldTypes.STRING_OPTIONAL,   // String

  // Numeric fields
  INT_REQUIRED: GraphQLFieldTypes.INT_REQUIRED,         // Int!
  INT_OPTIONAL: GraphQLFieldTypes.INT_OPTIONAL,         // Int
  FLOAT_REQUIRED: GraphQLFieldTypes.FLOAT_REQUIRED,     // Float!
  FLOAT_OPTIONAL: GraphQLFieldTypes.FLOAT_OPTIONAL,     // Float

  // Boolean fields
  BOOLEAN_REQUIRED: GraphQLFieldTypes.BOOLEAN_REQUIRED, // Boolean!
  BOOLEAN_OPTIONAL: GraphQLFieldTypes.BOOLEAN_OPTIONAL, // Boolean

  // Custom types
  JSON: GraphQLFieldTypes.JSON,                         // JSON (custom scalar)
  DATE: GraphQLFieldTypes.DATE,                         // Date (custom scalar)
};
```

### Complex Type Definitions

```typescript
export default class BlogService extends BaseService {
  // Post type definition
  postFields = {
    id: GraphQLFieldTypes.ID_REQUIRED,
    title: GraphQLFieldTypes.STRING_REQUIRED,
    content: GraphQLFieldTypes.STRING_REQUIRED,
    author: 'User',  // Reference to another type
    tags: '[String]', // Array of strings
    publishedAt: GraphQLFieldTypes.DATE,
    stats: 'PostStats' // Nested object
  };

  // Stats nested type
  postStatsFields = {
    viewCount: GraphQLFieldTypes.INT_REQUIRED,
    likeCount: GraphQLFieldTypes.INT_REQUIRED,
    commentCount: GraphQLFieldTypes.INT_REQUIRED
  };

  // Input definitions
  postInputs = {
    createPost: {
      title: GraphQLFieldTypes.STRING_REQUIRED,
      content: GraphQLFieldTypes.STRING_REQUIRED,
      tags: '[String]'
    },
    updatePost: {
      id: GraphQLFieldTypes.ID_REQUIRED,
      title: GraphQLFieldTypes.STRING_OPTIONAL,
      content: GraphQLFieldTypes.STRING_OPTIONAL,
      tags: '[String]'
    }
  };
}
```

## 🔧 GraphQL Resolvers

### Query Resolvers

```typescript
export default class UserService extends BaseService {
  // Simple queries
  async getUser(args: { id: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) return null;
    return await UserArcheType.Unwrap(entity);
  }

  async getUsers(args: { limit?: number; offset?: number }) {
    const query = new Query()
      .with(UserProfile)
      .limit(args.limit || 10)
      .offset(args.offset || 0);

    const entities = await query.exec();
    return await Promise.all(
      entities.map(entity => UserArcheType.Unwrap(entity))
    );
  }

  // Complex queries with filtering
  async searchUsers(args: { query: string; role?: string }) {
    const searchQuery = new Query().with(UserProfile);

    if (args.role) {
      searchQuery.with(UserRole).filter('role', args.role);
    }

    // Add text search if supported
    if (args.query) {
      searchQuery.filter('name', `%${args.query}%`, 'LIKE');
    }

    const entities = await searchQuery.exec();
    return await Promise.all(
      entities.map(entity => UserArcheType.Unwrap(entity))
    );
  }
}
```

### Mutation Resolvers

```typescript
export default class UserService extends BaseService {
  async createUser(args: { input: any }) {
    // Validate input
    if (!args.input.email || !args.input.name) {
      throw new Error('Name and email are required');
    }

    // Check for existing user
    const existingQuery = new Query()
      .with(UserProfile)
      .filter('email', args.input.email);

    const existing = await existingQuery.exec();
    if (existing.length > 0) {
      throw new Error('User with this email already exists');
    }

    // Create new user
    const userEntity = UserArcheType.fill({
      userProfile: args.input,
      userPreferences: { theme: 'light', notifications: true },
      userStats: { loginCount: 0, lastLogin: new Date() }
    }).createEntity();

    await userEntity.save();
    return await UserArcheType.Unwrap(userEntity);
  }

  async updateUser(args: { id: string; input: any }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) {
      throw new Error('User not found');
    }

    // Update only provided fields
    const updates: any = {};
    if (args.input.name) updates.userProfile = { name: args.input.name };
    if (args.input.email) updates.userProfile = { ...updates.userProfile, email: args.input.email };

    await UserArcheType.updateEntity(entity, updates);
    await entity.save();

    return await UserArcheType.Unwrap(entity);
  }

  async deleteUser(args: { id: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) {
      throw new Error('User not found');
    }

    await entity.delete(true); // Force delete
    return { success: true, message: 'User deleted successfully' };
  }
}
```

## 🔗 Service Relationships

### Service Dependencies

```typescript
export default class PostService extends BaseService {
  private userService: UserService;

  async initialize(): Promise<void> {
    await super.initialize();
    // Get service instance from registry
    this.userService = ServiceRegistry.get(UserService);
  }

  async createPost(args: { input: any }) {
    // Verify author exists
    const author = await this.userService.getUser({ id: args.input.authorId });
    if (!author) {
      throw new Error('Author not found');
    }

    const postEntity = BlogPostArcheType.fill(args.input).createEntity();
    await postEntity.save();

    return await BlogPostArcheType.Unwrap(postEntity);
  }

  async getPostWithAuthor(args: { id: string }) {
    const postEntity = await Entity.FindById(args.id);
    if (!postEntity) return null;

    const post = await BlogPostArcheType.Unwrap(postEntity);

    // Fetch author details
    if (post.authorId) {
      post.author = await this.userService.getUser({ id: post.authorId });
    }

    return post;
  }
}
```

### Cross-Service Queries

```typescript
export default class AnalyticsService extends BaseService {
  private userService: UserService;
  private postService: PostService;

  async initialize(): Promise<void> {
    await super.initialize();
    this.userService = ServiceRegistry.get(UserService);
    this.postService = ServiceRegistry.get(PostService);
  }

  async getUserStats(args: { userId: string }) {
    const user = await this.userService.getUser({ id: args.userId });
    if (!user) return null;

    // Get user's posts
    const userPosts = await new Query()
      .with(BlogPost)
      .filter('authorId', args.userId)
      .exec();

    // Calculate stats
    const totalPosts = userPosts.length;
    const totalViews = userPosts.reduce((sum, post) => {
      const stats = post.get(PostStats);
      return sum + (stats?.viewCount || 0);
    }, 0);

    return {
      user: user,
      stats: {
        totalPosts,
        totalViews,
        averageViews: totalPosts > 0 ? totalViews / totalPosts : 0
      }
    };
  }
}
```

## 🎭 Advanced Service Patterns

### Service with Middleware

```typescript
export default class SecureService extends BaseService {
  // Middleware for authentication
  async authenticate(context: any, next: Function) {
    const token = context.request.headers.authorization;
    if (!token) {
      throw new Error('Authentication required');
    }

    // Verify token and set user context
    const user = await this.verifyToken(token);
    context.user = user;

    return next();
  }

  // Middleware for authorization
  async authorize(context: any, next: Function) {
    if (!context.user.isAdmin) {
      throw new Error('Admin access required');
    }

    return next();
  }

  // Protected resolver
  async adminOnlyAction(args: any, context: any) {
    // This resolver is automatically protected by middleware
    return { success: true, user: context.user };
  }
}
```

### Service with Caching

```typescript
export default class CachedUserService extends BaseService {
  private cache = new Map<string, any>();

  async getUser(args: { id: string }) {
    // Check cache first
    const cacheKey = `user:${args.id}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Fetch from database
    const entity = await Entity.FindById(args.id);
    if (!entity) return null;

    const user = await UserArcheType.Unwrap(entity);

    // Cache for 5 minutes
    this.cache.set(cacheKey, user);
    setTimeout(() => {
      this.cache.delete(cacheKey);
    }, 5 * 60 * 1000);

    return user;
  }

  // Invalidate cache on updates
  async updateUser(args: any) {
    const result = await super.updateUser(args);

    // Clear cache
    const cacheKey = `user:${args.id}`;
    this.cache.delete(cacheKey);

    return result;
  }
}
```

### Batch Operations Service

```typescript
export default class BatchService extends BaseService {
  async createUsers(args: { inputs: any[] }) {
    const results = [];
    const errors = [];

    for (const input of args.inputs) {
      try {
        const user = await this.createUser({ input });
        results.push(user);
      } catch (error) {
        errors.push({
          input,
          error: error.message
        });
      }
    }

    return {
      results,
      errors,
      success: errors.length === 0
    };
  }

  async bulkUpdateUsers(args: { updates: Array<{ id: string; input: any }> }) {
    const results = [];
    const errors = [];

    // Process in batches to avoid overwhelming the database
    const batchSize = 10;
    for (let i = 0; i < args.updates.length; i += batchSize) {
      const batch = args.updates.slice(i, i + batchSize);

      const batchPromises = batch.map(async (update) => {
        try {
          const user = await this.updateUser({
            id: update.id,
            input: update.input
          });
          return { success: true, user };
        } catch (error) {
          return { success: false, error: error.message, id: update.id };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return {
      results,
      errors: results.filter(r => !r.success),
      success: results.every(r => r.success)
    };
  }
}
```

## 🔧 Service Registry

### Automatic Service Registration

Services are automatically discovered and registered when:
1. They extend `BaseService`
2. They are imported in your application entry point
3. The application starts via `App.start()`

```typescript
// app.ts
import { App } from 'bunsane';
import UserService from './services/UserService';
import PostService from './services/PostService';

const app = new App();

// Services are automatically registered when imported
// No manual registration required
app.start();
```

### Accessing Services

```typescript
// Get service instance
const userService = ServiceRegistry.get(UserService);
const postService = ServiceRegistry.get(PostService);

// Use services in your application
const user = await userService.getUser({ id: '123' });
```

## 📊 Best Practices

### Service Design

- **Single Responsibility**: Each service should handle one domain area
- **Dependency Injection**: Use constructor injection for dependencies
- **Error Handling**: Provide clear, actionable error messages
- **Validation**: Validate inputs before processing
- **Documentation**: Document complex business logic

### Performance Considerations

- **Caching**: Implement caching for frequently accessed data
- **Batch Operations**: Support bulk operations where possible
- **Lazy Loading**: Only fetch related data when needed
- **Query Optimization**: Use efficient database queries
- **Connection Pooling**: Reuse database connections

### Error Handling

```typescript
export default class RobustService extends BaseService {
  async safeOperation(args: any) {
    try {
      // Validate input
      this.validateInput(args);

      // Perform operation
      const result = await this.performOperation(args);

      // Log success
      logger.info('Operation completed successfully', { args, result });

      return result;

    } catch (error) {
      // Log error with context
      logger.error('Operation failed', {
        args,
        error: error.message,
        stack: error.stack
      });

      // Return user-friendly error
      throw new Error('Operation failed. Please try again later.');
    }
  }

  private validateInput(args: any) {
    if (!args.id) {
      throw new Error('ID is required');
    }

    if (args.value && args.value < 0) {
      throw new Error('Value must be positive');
    }
  }
}
```

## 🚀 What's Next?

Now that you understand Services, let's explore:

- **[Query System](query.md)** - Efficient data retrieval
- **[Lifecycle Hooks](hooks.md)** - Business logic integration
- **[Entity System](entity.md)** - How entities work with services
- **[Advanced Features](../advanced/)** - Power user capabilities

---

*Ready to build APIs with services? Let's look at the [Query System](query.md) next!* 🚀