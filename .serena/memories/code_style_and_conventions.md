# Code Style and Conventions

## Formatting
- **Indentation**: 4 spaces (configured in `.prettierrc`)
- **No tabs**: Spaces only
- **Prettier**: Used for formatting

## TypeScript Configuration
- **Strict mode**: Enabled
- **Experimental decorators**: Enabled
- **Emit decorator metadata**: Enabled
- **Module**: ESNext/Preserve
- **Path alias**: `@/*` maps to `./*`

## Naming Conventions
- **Classes**: PascalCase (e.g., `Entity`, `BaseComponent`, `CacheManager`)
- **Methods/Functions**: camelCase (e.g., `createEntity`, `getEntityWithID`)
- **Variables**: camelCase
- **Constants**: camelCase or UPPER_SNAKE_CASE for environment-like values
- **Private properties**: Prefix with underscore (e.g., `_dirty`, `_persisted`)
- **Interfaces**: PascalCase, often prefixed with `I` (e.g., `IEntity`)
- **Types**: PascalCase

## Decorators Usage
The framework heavily uses TypeScript decorators:

```typescript
// Component definition
@Component
class MyComponent extends BaseComponent {
    @CompData()
    myField!: string;
}

// ArcheType definition
class MyArcheType extends BaseArcheType {
    @ArcheTypeField(MyComponent)
    myComponent!: MyComponent;
}
```

## Import Style
- Use relative imports for internal modules
- Use `@/` path alias for project root imports
- Group imports: external packages first, then internal modules
- **Type-only imports**: Use `import type` for interface/type imports when only used for type checking:
  ```typescript
  import type { CacheProvider } from './CacheProvider';
  ```
  Benefits: Clearer intent, reduced runtime dependencies, better tree-shaking

## Testing Conventions
- Test files: `*.test.ts`
- Use Bun's built-in test runner (`bun:test`)
- Structure: `describe` blocks for grouping, `test` for individual cases
- Use `beforeAll`/`afterAll` for setup/cleanup
- Integration tests should clean up created entities

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

describe('FeatureName', () => {
    beforeAll(async () => { /* setup */ });
    afterAll(async () => { /* cleanup */ });
    
    test('should do something', async () => {
        expect(result).toBe(expected);
    });
});
```

## Documentation
- Use JSDoc comments for public APIs
- Block comments for file headers explaining purpose
- Inline comments sparingly, only when logic is complex
