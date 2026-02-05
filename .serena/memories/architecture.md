# Project Architecture

## Directory Structure

```
bunsane/
├── core/                    # Core framework
│   ├── App.ts              # Main application entry point
│   ├── Entity.ts           # Entity class (base data unit)
│   ├── EntityManager.ts    # Entity lifecycle management
│   ├── ArcheType.ts        # Entity templates with component definitions
│   ├── BatchLoader.ts      # DataLoader for batching DB queries
│   ├── Config.ts           # Configuration management
│   ├── Logger.ts           # Pino logging setup
│   ├── ErrorHandler.ts     # Error handling utilities
│   ├── RequestContext.ts   # Request-scoped context
│   ├── ApplicationLifecycle.ts  # App state management
│   ├── cache/              # Caching system
│   │   ├── CacheManager.ts     # Main cache orchestration
│   │   ├── CacheProvider.ts    # Standard interface (all providers implement this)
│   │   ├── MemoryCache.ts      # In-memory cache provider
│   │   ├── RedisCache.ts       # Redis cache provider
│   │   ├── MultiLevelCache.ts  # L1/L2 cache strategy (wrapper)
│   │   ├── CacheAnalytics.ts   # Analytics wrapper provider
│   │   ├── TTLStrategy.ts      # Adaptive TTL wrapper provider
│   │   └── ...
│   ├── components/         # Component system
│   │   ├── BaseComponent.ts    # Base class for components
│   │   ├── ComponentRegistry.ts # Component registration
│   │   ├── Decorators.ts       # @Component, @CompData decorators
│   │   └── ...
│   ├── decorators/         # Additional decorators
│   ├── events/             # Event system
│   └── metadata/           # Metadata utilities
├── database/               # Database layer
│   ├── index.ts            # PostgreSQL connection (postgres.js)
│   ├── DatabaseHelper.ts   # DB setup and migrations
│   ├── PreparedStatementCache.ts  # Query caching
│   └── IndexingStrategy.ts # Index management
├── query/                  # Query builder
│   ├── Query.ts            # Main query class
│   ├── FilterBuilder.ts    # Filter construction
│   ├── QueryDAG.ts         # Query execution graph
│   └── ...
├── gql/                    # GraphQL generation
│   ├── Generator.ts        # Schema generation
│   ├── builders/           # Type/resolver builders
│   ├── decorators/         # GQL decorators
│   ├── strategies/         # Type generation strategies
│   └── visitors/           # Schema visitors
├── service/                # Service layer
│   ├── Service.ts          # Base service class
│   └── ServiceRegistry.ts  # Service registration
├── plugins/                # Plugin system
├── scheduler/              # Task scheduling
├── storage/                # File storage
├── upload/                 # File upload handling
├── rest/                   # REST endpoint support
├── swagger/                # OpenAPI documentation
├── studio/                 # BunSane Studio (web UI)
├── test/                   # Tests
│   ├── setup.ts            # Test environment setup
│   ├── integration/        # Integration tests
│   └── gql/                # GraphQL tests
├── types/                  # Type definitions
└── utils/                  # Utility functions
```

## Core Concepts Flow

1. **App** initializes the application, sets up GraphQL Yoga server
2. **Components** are registered via `@Component` decorator
3. **Entities** are created and manipulated, storing component data
4. **ArcheTypes** define entity templates for type-safe component access
5. **Query** builder retrieves entities with filters and component population
6. **Services** define business logic and auto-generate GraphQL resolvers
7. **CacheManager** handles caching at entity/component/query levels

## Cache System Architecture

All cache providers implement the standardized `CacheProvider` interface:

```typescript
interface CacheProvider {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttl?: number): Promise<void>;
    delete(key: string | string[]): Promise<void>;  // Supports single or multiple
    clear(): Promise<void>;
    getMany<T>(keys: string[]): Promise<(T | null)[]>;  // Returns ordered array
    setMany<T>(entries: Array<{key, value, ttl?}>): Promise<void>;  // Per-entry TTL
    deleteMany(keys: string[]): Promise<void>;
    invalidatePattern(pattern: string): Promise<void>;
    ping(): Promise<boolean>;  // Health check
    getStats(): Promise<CacheStats>;  // Metrics
}
```

**Cache Providers**:
- **MemoryCache**: In-memory LRU cache (base implementation)
- **RedisCache**: Redis-backed cache (base implementation)
- **MultiLevelCacheProvider**: L1 (memory) + L2 (Redis) wrapper
- **AnalyticsCacheProvider**: Metrics and latency tracking wrapper
- **AdaptiveTTLProvider**: Dynamic TTL adjustment wrapper

**Key Design Decisions** (as of 2026-01-24):
- Batch operations use arrays instead of Maps for ordering and flexibility
- `delete()` accepts both single string and string array for convenience
- `ping()` replaces `healthCheck()` for conventional naming
- All wrappers maintain full interface compliance

## Import Resolution (as of 2026-02-05)

All internal imports use **relative paths** (`./`, `../`). Bare imports like `from "core/Logger"` that rely on `baseUrl` are NOT allowed because they break TypeScript type checking for consumers who install bunsane as a dependency (their tsconfig does not have baseUrl pointing to bunsane root).

## Data Model

- **Entity**: UUID-identified record in `entities` table
- **Component**: JSONB data in `components` table, linked to entity
- Components are identified by `entity_id` + `component_type`
- Supports indexing specific component fields for queries

## CORS System (as of 2026-02-04)

The App class (`core/App.ts`) provides comprehensive CORS support with proper spec compliance.

**CorsConfig Type**:
```typescript
type CorsConfig = {
    origin?: string | string[] | ((origin: string) => boolean);
    credentials?: boolean;
    allowedHeaders?: string[];
    exposedHeaders?: string[];  // For Access-Control-Expose-Headers
    methods?: string[];
    maxAge?: number;  // Preflight cache duration in seconds
};
```

**Key Features**:
- **Origin Validation**: Validates request Origin header against configured origins
- **Array Origins**: Returns the matching origin (not comma-joined) per spec
- **Function Origins**: Supports `(origin: string) => boolean` for dynamic validation
- **Credentials + Wildcard**: When credentials=true with origin="*", reflects actual origin instead of wildcard
- **Vary Header**: Always includes `Vary: Origin` for proper caching
- **All Endpoints**: CORS headers applied to all response paths (health, docs, openapi, studio, errors)

**Usage**:
```typescript
app.setCors({
    origin: ["http://localhost:3000", "https://myapp.com"],
    credentials: true,
    maxAge: 86400,
    exposedHeaders: ["X-Custom-Header"]
});
```
