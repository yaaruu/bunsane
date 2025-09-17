# Code Examples

This section contains practical, runnable examples that demonstrate BunSane's capabilities. Each example includes complete code that you can copy and run in your own project.

## 🚀 Quick Start Example

Here's a complete example showing how to create a user management system with BunSane:

### Project Setup

```bash
# Create a new project
mkdir bunsane-user-app
cd bunsane-user-app

# Initialize with Bun
bun init -y

# Install BunSane
bun add bunsane

# Create project structure
mkdir -p src/services
```

### 1. Define Components

```typescript
// src/services/UserComponents.ts
import { Component, CompData, BaseComponent } from 'bunsane';

@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';

  @CompData({ indexed: true })
  username: string = '';

  @CompData()
  bio: string = '';

  @CompData()
  avatarUrl: string = '';
}

@Component
export class UserPreferences extends BaseComponent {
  @CompData()
  theme: 'light' | 'dark' | 'auto' = 'light';

  @CompData()
  notifications: boolean = true;

  @CompData()
  language: string = 'en';

  @CompData()
  timezone: string = 'UTC';
}

@Component
export class UserStats extends BaseComponent {
  @CompData()
  loginCount: number = 0;

  @CompData()
  lastLogin: Date = new Date();

  @CompData()
  postsCount: number = 0;

  @CompData()
  followersCount: number = 0;

  @CompData()
  followingCount: number = 0;
}
```

### 2. Create ArcheType

```typescript
// src/services/UserArcheType.ts
import { ArcheType } from 'bunsane';
import { UserProfile, UserPreferences, UserStats } from './UserComponents';

export const UserArcheType = new ArcheType([
  UserProfile,
  UserPreferences,
  UserStats
]);
```

### 3. Create Service

```typescript
// src/services/UserService.ts
import { BaseService, GraphQLObjectType, GraphQLOperation, GraphQLField, GraphQLFieldTypes } from 'bunsane';
import { UserArcheType } from './UserArcheType';

const userFields = {
  id: GraphQLFieldTypes.ID_REQUIRED,
  name: GraphQLFieldTypes.STRING_OPTIONAL,
  email: GraphQLFieldTypes.STRING_REQUIRED,
  username: GraphQLFieldTypes.STRING_OPTIONAL,
  bio: GraphQLFieldTypes.STRING_OPTIONAL,
  avatarUrl: GraphQLFieldTypes.STRING_OPTIONAL,
  theme: GraphQLFieldTypes.STRING_OPTIONAL,
  notifications: GraphQLFieldTypes.BOOLEAN_OPTIONAL,
  loginCount: GraphQLFieldTypes.INT_OPTIONAL,
  lastLogin: GraphQLFieldTypes.STRING_OPTIONAL,
  postsCount: GraphQLFieldTypes.INT_OPTIONAL,
  followersCount: GraphQLFieldTypes.INT_OPTIONAL,
  followingCount: GraphQLFieldTypes.INT_OPTIONAL
};

const userInputs = {
  createUser: {
    name: GraphQLFieldTypes.STRING_REQUIRED,
    email: GraphQLFieldTypes.STRING_REQUIRED,
    username: GraphQLFieldTypes.STRING_REQUIRED,
    bio: GraphQLFieldTypes.STRING_OPTIONAL,
    avatarUrl: GraphQLFieldTypes.STRING_OPTIONAL
  },
  getUser: {
    id: GraphQLFieldTypes.ID_REQUIRED
  },
  updateUser: {
    id: GraphQLFieldTypes.ID_REQUIRED,
    name: GraphQLFieldTypes.STRING_OPTIONAL,
    email: GraphQLFieldTypes.STRING_OPTIONAL,
    bio: GraphQLFieldTypes.STRING_OPTIONAL,
    avatarUrl: GraphQLFieldTypes.STRING_OPTIONAL
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
  async createUser(args: { name: string; email: string; username: string; bio?: string; avatarUrl?: string }) {
    const userEntity = UserArcheType.fill({
      userProfile: args,
      userPreferences: { theme: 'light', notifications: true },
      userStats: { loginCount: 0, lastLogin: new Date() }
    }).createEntity();

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

  @GraphQLOperation({
    type: "Mutation",
    input: userInputs.updateUser,
    output: "User"
  })
  async updateUser(args: { id: string; name?: string; email?: string; bio?: string; avatarUrl?: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) throw new Error('User not found');

    await UserArcheType.updateEntity(entity, {
      userProfile: args
    });

    await entity.save();
    return await UserArcheType.Unwrap(entity);
  }

  async deleteUser(args: { id: string }) {
    const entity = await Entity.FindById(args.id);
    if (!entity) throw new Error('User not found');

    await entity.delete(true);
    return { success: true, message: 'User deleted successfully' };
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

### 4. Set Up Application

```typescript
// index.ts
import { App } from 'bunsane';
import UserService from './src/services/UserService';

async function main() {
  // Services are automatically registered when imported
  // No manual registration needed

  // Create and start the application
  const app = new App({
    port: 3000,
    databaseUrl: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/bunsane_db'
  });

  await app.start();

  console.log('🚀 BunSane server running on http://localhost:3000');
  console.log('📊 GraphQL Playground: http://localhost:3000/graphql');
}

main().catch(console.error);
```

### 5. Environment Configuration

```env
# .env
DATABASE_URL=postgresql://username:password@localhost:5432/bunsane_db
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
```

### 6. TypeScript Configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "index.ts"],
  "exclude": ["node_modules"]
}
```

## 🧪 Testing the Example

### Start the Server

```bash
bun run index.ts
```

### GraphQL Queries

Visit `http://localhost:3000/graphql` and try these queries:

#### Create a User

```graphql
mutation CreateUser($input: CreateUserInput!) {
  createUser(input: $input) {
    id
    name
    email
    username
    theme
    notifications
    loginCount
    lastLogin
  }
}
```

Variables:
```json
{
  "input": {
    "name": "John Doe",
    "email": "john.doe@example.com",
    "username": "johndoe",
    "bio": "Software developer passionate about TypeScript",
    "avatarUrl": "https://example.com/avatar.jpg"
  }
}
```

#### Get Users

```graphql
query GetUsers {
  getUsers(limit: 10, offset: 0) {
    id
    name
    email
    username
    bio
    postsCount
    followersCount
  }
}
```

#### Update User

```graphql
mutation UpdateUser($input: UpdateUserInput!) {
  updateUser(input: $input) {
    id
    name
    email
    bio
  }
}
```

Variables:
```json
{
  "input": {
    "id": "01HXXXXXXXXXXXXXXXXXXXXX",
    "name": "John Smith",
    "bio": "Full-stack developer specializing in modern web technologies"
  }
}
```

## 📚 More Examples

- **[Blog Application](blog-tutorial.md)** - Complete blogging platform
- **[E-commerce System](ecommerce-tutorial.md)** - Online store with products and orders
- **[Social Media Platform](social-tutorial.md)** - User interactions and content sharing

## 🔧 Running Examples

Each example includes:

1. **Complete code** - Copy and run immediately
2. **Database setup** - SQL scripts for schema creation
3. **GraphQL queries** - Ready-to-use API calls
4. **Testing instructions** - How to verify functionality

### Local Development

```bash
# Clone the example
git clone https://github.com/yaaruu/bunsane-examples.git
cd bunsane-examples/user-management

# Install dependencies
bun install

# Set up database
createdb bunsane_examples
psql bunsane_examples < schema.sql

# Start the server
bun run dev
```

### Docker Development

```bash
# Use Docker Compose for full development environment
docker-compose up -d

# Run the example
bun run index.ts
```

## 🎯 Learning Path

1. **Start Here** - User management system (you're here!)
2. **Add Features** - Extend with posts, comments, likes
3. **Go Advanced** - Add real-time updates, file uploads, caching
4. **Production Ready** - Add authentication, rate limiting, monitoring

---

*Ready to build something amazing? Try the [Blog Application](blog-tutorial.md) next!* 🚀