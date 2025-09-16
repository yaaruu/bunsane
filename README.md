<div align="center">

<img src="https://raw.githubusercontent.com/yaaruu/bunsane/refs/heads/main/BunSane.jpg" alt="BunSane" width="520" />

# BunSane — Batteries‑included TypeScript API framework for Bun

### Entity–Component storage on Postgres, a fluent query builder, and zero‑boilerplate GraphQL with GraphQL Yoga.
#### Skip Boilerplating and FOCUS writing Business Flow code 😉

### BunSane currently in `EXPERIMENTAL` state Not Production Ready
</div>

## Features

- Entity–Component model backed by PostgreSQL (auto-migrates base tables on first run)
- Declarative Components with decorators and indexed fields
- Fluent, performant Query builder (with/without population, filters, exclusions)
- Pluggable Services with decorators that generate a GraphQL schema automatically
- GraphQL Yoga server bootstrap out of the box
- Pino logging, pretty mode in development
- Zod-friendly GraphQL error helper

## Request-scoped Loaders & Context

BunSane provides request-scoped DataLoaders for efficient batching of entity and component loads within a single GraphQL request. This eliminates N+1 queries for relationships.

To enable, add the plugin to your GraphQL Yoga server:

```typescript
import { createYoga } from 'graphql-yoga';
import { createRequestContextPlugin } from 'bunsane';

const yoga = createYoga({
  // ... other options
  plugins: [createRequestContextPlugin()],
});
```

The loaders are available in resolvers via `context.locals.loaders`.

## Optimizing Relationships

BunSane provides several patterns to optimize relationship loading and avoid N+1 queries:

### Eager Loading Components

Use `.eagerLoadComponents()` to preload multiple component types in a single query:

```typescript
const query = new Query()
  .with(PostTag)
  .eagerLoadComponents([TitleComponent, ContentComponent, AuthorComponent]);

const posts = await query.exec();
```

### Batched Relationship Loading

Use `BatchLoader.loadRelatedEntitiesBatched()` to load related entities efficiently:

```typescript
// Load all authors for posts in one batch
const authors = await BatchLoader.loadRelatedEntitiesBatched(
  posts,
  AuthorComponent,
  Entity.LoadMultiple
);

// Access related entity
const authorEntity = authors.get(authorId);
```

### GraphQL Field-Based Optimization

Only load components when the corresponding GraphQL fields are requested:

```typescript
import { isFieldRequested } from 'bunsane/gql';

async resolver(args: any, context: any, info: any) {
  const componentsToLoad = [CoreComponent];
  
  if (isFieldRequested(info, 'author')) {
    componentsToLoad.push(AuthorComponent);
  }
  
  const query = new Query()
    .with(EntityTag)
    .eagerLoadComponents(componentsToLoad);
}
```

### Anti-Patterns to Avoid

❌ **Don't** use loops with individual `Entity.get()` calls:
```typescript
// This creates N+1 queries
for (const post of posts) {
  const author = await post.get(AuthorComponent);
  // Process author...
}
```

✅ **Do** use eager loading and batching:
```typescript
// This creates O(1-3) queries total
const posts = await query.eagerLoadComponents([AuthorComponent]).exec();
const authors = await BatchLoader.loadRelatedEntitiesBatched(posts, AuthorComponent, Entity.LoadMultiple);
```

## Install

Requires Bun and PostgreSQL.

```cmd
bun install bunsane
```

Ensure your tsconfig enables decorators in your app:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Full documentation visit: [Documentation](https://example.com)

## Core concepts

### ECS ( Entity Component Services )
TODO


## LICENSE 
MIT

---

## Made with⚡
- Bun
- GraphQL
- GraphQL Yoga
- PostgreSQL

