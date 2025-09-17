# Getting Started with BunSane

This guide will walk you through installing and setting up BunSane for your first project.

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- **Bun Runtime**: Version 1.0 or later ([Download Bun](https://bun.sh/))
- **PostgreSQL**: Version 12 or later ([Download PostgreSQL](https://www.postgresql.org/download/))
- **Node.js**: Version 18+ (for some development tools, though Bun is the primary runtime)

## 🚀 Installation

### 1. Install BunSane

```bash
bun install bunsane
```

### 2. Verify Installation

```bash
bun run --version
# Should show Bun version 1.x.x
```

## ⚙️ Configuration

### TypeScript Configuration

BunSane requires experimental decorators to be enabled. Update your `tsconfig.json`:

```json
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

### Database Setup

Create a PostgreSQL database for your application:

```sql
-- Create database
CREATE DATABASE bunsane_app;

-- Create user (optional)
CREATE USER bunsane_user WITH PASSWORD 'your_password';

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE bunsane_app TO bunsane_user;
```

### Environment Configuration

Create a `.env` file in your project root:

```env
# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/bunsane_app

# Application Configuration
NODE_ENV=development
PORT=3000

# Optional: Logging
LOG_LEVEL=info
```

## 🏗️ Your First BunSane Application

### Project Structure

Create the following directory structure:

```
my-bunsane-app/
├── src/
│   ├── services/
│   └── helpers/
├── index.ts
├── package.json
├── tsconfig.json
└── .env
```

### 1. Create Your First Component

```typescript
// src/services/UserService.ts
import { Component, CompData, BaseComponent, ArcheType, Entity, GraphQLObjectType, GraphQLOperation, GraphQLFieldTypes, GraphQLField } from 'bunsane';

@Component
export class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';

  @CompData({ indexed: true })
  username: string = '';
}

@Component
export class UserPreferences extends BaseComponent {
  @CompData()
  theme: 'light' | 'dark' = 'light';

  @CompData()
  notifications: boolean = true;
}
```

### 2. Create an ArcheType

```typescript
// src/services/UserService.ts (continued)
import { ArcheType } from 'bunsane';

export const UserArcheType = new ArcheType([
  UserProfile,
  UserPreferences
]);
```

### 3. Create a Service

```typescript
// src/services/UserService.ts (continued)
import { BaseService, GraphQLObjectType, GraphQLOperation, GraphQLFieldTypes, GraphQLField } from 'bunsane';

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

  @GraphQLField({ type: "User", field: "username" })
  async usernameResolver(parent: Entity) {
    const profile = await parent.get(UserProfile);
    return profile?.username ?? "";
  }
}
```

### 4. Set Up the Application

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
    databaseUrl: process.env.DATABASE_URL
  });

  await app.start();

  console.log('🚀 BunSane server running on http://localhost:3000');
}

main().catch(console.error);
```

### 5. Run Your Application

```bash
bun run index.ts
```

## 🧪 Testing Your Setup

### GraphQL API Testing

Your service now exposes GraphQL endpoints. Visit `http://localhost:3000/graphql` to access the GraphQL playground.

**Create User Mutation:**
```graphql
mutation CreateUser($input: CreateUserInput!) {
  createUser(input: $input) {
    id
    name
    email
    username
  }
}
```

With variables:
```json
{
  "input": {
    "name": "John Doe",
    "email": "john.doe@example.com",
    "username": "johndoe"
  }
}
```

**Get User Query:**
```graphql
query GetUser($id: ID!) {
  getUser(input: { id: $id }) {
    id
    name
    email
    username
  }
}
```

### REST API Testing

You can also test REST endpoints using tools like curl or Postman:

```bash
# Example curl request
curl -X GET http://localhost:3000/api/users
```

## 🔍 What's Next?

Congratulations! You now have a working BunSane application. Here's what you can explore next:

- **[Entity System](core-concepts/entity.md)** - Deep dive into entity management
- **[Component Architecture](core-concepts/components.md)** - Advanced component patterns
- **[Query System](core-concepts/query.md)** - Efficient data retrieval
- **[Lifecycle Hooks](core-concepts/hooks.md)** - Business logic integration
- **[Real Examples](examples/)** - Complete application tutorials

## 🐛 Troubleshooting

### Common Issues

**"Component not registered" error**
- Ensure all components are properly decorated with `@Component`
- Check that components are imported before use

**Database connection failed**
- Verify PostgreSQL is running
- Check DATABASE_URL format and credentials
- Ensure database exists and user has permissions

**Service not found error**
- Verify services extend `BaseService`
- Check that services are registered with `ServiceRegistry`

### Getting Help

- [GitHub Issues](https://github.com/yaaruu/bunsane/issues) - Report bugs
- [GitHub Discussions](https://github.com/yaaruu/bunsane/discussions) - Ask questions
- [Documentation](https://yaaruu.github.io/bunsane/) - Complete reference

---

*Ready to build something amazing? Let's continue with the [Entity System](core-concepts/entity.md)!* 🚀