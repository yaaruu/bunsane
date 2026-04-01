# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BunSane is an experimental TypeScript API framework for Bun using Entity-Component-System (ECS) architecture with PostgreSQL storage. It provides GraphQL Yoga integration with automatic schema generation from decorated services.

**Stack**: Bun, TypeScript, PostgreSQL, GraphQL Yoga, GQLoom, Zod 4.x, Pino logging

## Commands

```bash
# Install dependencies
bun install

# Build (includes studio + typecheck)
bun run build

# Typecheck only
tsc --noEmit

# Tests (requires PostgreSQL)
bun test                    # Unit + integration + GraphQL tests
bun run test:unit           # Unit tests only
bun run test:integration    # Integration tests only
bun run test:graphql        # GraphQL schema tests only

# Tests with PGlite (no PostgreSQL required)
bun run test:pglite         # All tests with PGlite
bun run test:pglite:unit    # Unit tests only with PGlite

# E2E and stress tests
bun run test:e2e            # HTTP tests (no DB needed)
bun run test:stress         # Performance benchmarks

# Run single test file
bun test path/to/file.test.ts

# Run tests matching pattern
bun test --grep "pattern"
```

## Architecture

### ECS Model
- **Entities**: Generic containers with UUID, stored in `entities` table
- **Components**: Data containers attached to entities, stored in `components` table with JSONB data
- **Services**: Business logic with GraphQL operations

### Core Classes

**Entity** (`core/Entity.ts`):
```typescript
const entity = Entity.Create();
entity.add(Position, { x: 0, y: 0 });    // Add component
await entity.set(Position, { x: 10 });   // Update component
const pos = await entity.get(Position);  // Get component data
await entity.save();
```

**BaseComponent** (`core/components/BaseComponent.ts`):
```typescript
@Component
class Position extends BaseComponent {
    @CompData() x: number = 0;
    @CompData({ indexed: true }) y: number = 0;  // Creates DB index
}
```

**BaseArcheType** (`core/ArcheType.ts`):
- Predefined entity templates with required components
- Auto-generates GraphQL types and CRUD operations

**Query** (`query/Query.ts`):
```typescript
const entities = await new Query()
    .with(Position)                       // Require component
    .with(Velocity, { filters: [...] })   // With filters
    .populate()                           // Load all components
    .limit(10)
    .exec();
```

**BaseService** (`service/Service.ts`):
```typescript
class UserService extends BaseService {
    @GraphQLOperation({ type: "Query", input: { id: t.id() }, output: User })
    async getUser(input: { id: string }, ctx: GraphQLContext) { ... }
}
```

### GraphQL

- Schema generated automatically from decorated services and archetypes
- Input types use Schema DSL (`gql/schema/index.ts`) via `t.` API
- Operations: `@GraphQLOperation`, `@GraphQLSubscription`
- Archetypes: `@ArcheTypeFunction` for computed fields

### Database

- PostgreSQL with Bun's native SQL driver (`Bun.SQL`)
- Auto-migrations on startup for base tables
- Component data stored as JSONB
- Indexed fields create GIN indexes automatically

### Caching

- Multi-level cache: L1 (memory) + L2 (Redis)
- `CacheManager.initialize(config)` is async - always await it
- Strategies: write-through, write-invalidate
- Cross-instance invalidation via Redis pub/sub

### File Uploads

- `UploadManager` handles file validation and storage
- `S3StorageProvider` for S3-compatible storage (AWS, MinIO, R2)
- REST: `handleUpload(req)` from `upload/RestUpload.ts`
- GraphQL: `@Upload()` decorator

## Critical Rules

### Import Style
**ALWAYS use relative imports** (`./`, `../`) for internal modules. Never use bare imports like `from "core/Logger"` - this breaks consumer typechecking.

### Architecture Decisions
- No Dependency Injection - uses singletons + global exports
- Singleton access: `CacheManager.getInstance()`, `EntityManager.instance`, etc.
- Services registered via `ServiceRegistry.register()`

### Test Database Setup
- Tests require `.env.test` with PostgreSQL config (or use PGlite mode)
- `bunfig.toml` preloads `tests/setup.ts`
- PGlite: `CREATE INDEX CONCURRENTLY` must check `process.env.USE_PGLITE`
- PGlite JSONB: pass JS objects directly, never `JSON.stringify() + ::jsonb`

### Running Tests with PGlite

**IMPORTANT**: To run tests with PGlite, always use `tests/pglite-setup.ts` as the entry point. This script starts an in-memory PostgreSQL server before spawning the test runner.

```bash
# Correct - uses pglite-setup.ts wrapper
bun run test:pglite                              # All tests
bun run test:pglite:unit                         # Unit tests only
bun tests/pglite-setup.ts tests/unit/            # Specific directory
bun tests/pglite-setup.ts path/to/file.test.ts   # Single file

# WRONG - will fail with connection errors
USE_PGLITE=true bun test path/to/file.test.ts    # Won't work!
```

The wrapper script:
1. Starts PGlite Socket server on port 54321
2. Sets required env vars (`USE_PGLITE`, `POSTGRES_*`)
3. Spawns `bun test` with correct configuration
4. Cleans up server on exit

**PGlite limitations:**
- `?|` and `?&` operators not supported (use `@>` / `<@` instead)
- `CREATE INDEX CONCURRENTLY` not supported
- Single connection only (`POSTGRES_MAX_CONNECTIONS=1`)

## Directory Structure

```
core/           # ECS core: Entity, Component, ArcheType, App
  cache/        # CacheManager, Redis, Memory caches
  components/   # BaseComponent, decorators, registry
  middleware/   # HTTP middleware (AccessLog, RequestId, SecurityHeaders)
database/       # DatabaseHelper, SQL utilities
gql/            # GraphQL generation, Schema DSL
  schema/       # t.* Schema DSL for inputs
query/          # Fluent Query builder, FilterBuilder
service/        # BaseService, ServiceRegistry
upload/         # File uploads, S3StorageProvider
scheduler/      # Cron-style task scheduling
tests/          # Unit, integration, GraphQL, E2E, stress tests
```
