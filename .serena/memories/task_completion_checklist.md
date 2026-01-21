# Task Completion Checklist

When completing a task, ensure the following steps are performed:

## 1. Code Quality
- [ ] Code follows the project's style conventions (4-space indent, TypeScript strict mode)
- [ ] No TypeScript errors (`tsc` passes)
- [ ] No unused imports or variables
- [ ] Proper error handling where appropriate

## 2. Testing
- [ ] Run all tests: `bun test`
- [ ] If adding new functionality, add corresponding tests
- [ ] Ensure no test regressions
- [ ] For integration tests, clean up created entities

## 3. Type Safety
- [ ] Use proper TypeScript types (avoid `any` when possible)
- [ ] Export types for public APIs
- [ ] Use decorators correctly (@Component, @CompData, etc.)

## 4. Documentation (if applicable)
- [ ] Add JSDoc comments for new public APIs
- [ ] Update README if adding new features
- [ ] Document breaking changes

## 5. Pre-Commit
- [ ] Run `tsc` to check for type errors
- [ ] Run `bun test` to ensure tests pass
- [ ] Consider running `bunx knip` for dead code detection

## Common Test Commands
```bash
# Run all tests
bun test

# Run specific test file
bun test path/to/test.test.ts

# Run with filter
bun test --filter "CacheManager"
```

## Notes
- Tests use `.env.test` for database configuration
- Test setup automatically initializes the database
- Integration tests may need a running PostgreSQL instance
- Cache tests default to memory provider
