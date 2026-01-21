# Architectural Decision: No Dependency Injection (For Now)

**Date:** 2026-01-21  
**Status:** Decided  
**Context:** Framework v0.1.5 (experimental)

## Decision

BunSane will NOT implement a formal Dependency Injection (DI) container at this stage.

## Current Approach

The framework uses:
- **Singleton patterns** for shared services (`CacheManager.getInstance()`, `EntityManager.instance`, `ComponentRegistry`)
- **Global exports** for database (`import db from "database"`) and logger
- **ApplicationLifecycle phases** for managing initialization order
- **Metadata-driven decorators** for component/service registration

## Rationale

### Why DI Was Considered
- Testing pain points: type-unsafe hacks like `(EntityManager as any).dbReady = true`
- Hard to mock/swap implementations in tests
- Singletons share global state between tests

### Why DI Was Rejected (For Now)

1. **Framework is experimental (v0.1.5)** - Too early for such fundamental architectural changes

2. **Added complexity outweighs benefits** - DI adds another abstraction layer to an already complex ECS + GraphQL framework

3. **Current approach works** - ApplicationLifecycle phases already manage dependency initialization order effectively

4. **Users don't need to swap implementations** - Extensions happen via Components, Services, and Plugins, none of which benefit significantly from DI

5. **Testing pain can be solved simpler** - Lightweight patterns like `reset()` methods or optional instance injection suffice

6. **Bun ecosystem norms** - DI isn't a common pattern in modern Bun/TypeScript frameworks

7. **Runtime overhead** - Relevant concern for a performance-focused framework

## Alternative: Lightweight Testability Pattern

Instead of full DI, use optional instance injection for testability:

```typescript
class CacheManager {
    private static _instance: CacheManager | null = null;
    
    static getInstance(): CacheManager {
        return this._instance ??= new CacheManager();
    }
    
    // For testing only
    static setInstance(instance: CacheManager | null): void {
        this._instance = instance;
    }
}
```

## When to Revisit

Consider DI if/when:
- Framework reaches v1.0 with stable APIs
- Users request ability to swap implementations
- Codebase grows significantly larger (200+ files)
- Multiple database/cache backends become first-class options

## Related Files

- `core/cache/CacheManager.ts` - Singleton cache manager
- `core/EntityManager.ts` - Singleton entity manager
- `core/components/ComponentRegistry.ts` - Singleton component registry
- `service/ServiceRegistry.ts` - Singleton service registry
- `core/ApplicationLifecycle.ts` - Lifecycle phase management
- `database/index.ts` - Global database export
