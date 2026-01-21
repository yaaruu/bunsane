# AGENTS.md - AI Agent Guidelines for BunSane

This document provides guidelines for AI agents working on the BunSane codebase, with emphasis on using Serena MCP tools optimally to save context and maintain long-term memory.

---

## 1. First Steps: Project Activation & Onboarding

### Always Start With
```
1. mcp__serena__activate_project("G:\AA_JSCode\A_FRAMEWORK\bunsane")
2. mcp__serena__check_onboarding_performed()
3. mcp__serena__list_memories()  # See what knowledge exists
```

### Read Relevant Memories
Before starting any task, check if relevant memories exist:
- `project_overview` - Project purpose and tech stack
- `architecture` - Directory structure and core concepts
- `code_style_and_conventions` - How to write code
- `suggested_commands` - How to run tests, build, etc.
- `task_completion_checklist` - What to do when done

**Only read memories relevant to your current task** - don't load everything.

---

## 2. Context-Saving Strategies

### Use Symbolic Tools Instead of Reading Entire Files

**BAD** (wastes context):
```
Read entire file: core/Entity.ts (500+ lines)
```

**GOOD** (saves context):
```
1. get_symbols_overview("core/Entity.ts", depth=1)  # See structure
2. find_symbol("Entity/save", include_body=true)    # Read only what you need
```

### Tool Selection Guide

| Need | Tool | Context Cost |
|------|------|--------------|
| Understand file structure | `get_symbols_overview` | Low |
| Find a specific symbol | `find_symbol` | Low |
| Read symbol implementation | `find_symbol` with `include_body=true` | Medium |
| Find where symbol is used | `find_referencing_symbols` | Medium |
| Search for pattern/text | `search_for_pattern` | Variable |
| List directory contents | `list_dir` | Low |
| Find files by name | `find_file` | Low |

### Progressive Disclosure Pattern
1. **Start broad**: `get_symbols_overview` or `list_dir`
2. **Narrow down**: `find_symbol` with pattern
3. **Deep dive**: `find_symbol` with `include_body=true` only when needed
4. **Trace usage**: `find_referencing_symbols` to understand impact

---

## 3. Memory Management

### When to Write Memories
Write memories for information that:
- Will be useful across multiple sessions
- Took significant effort to discover
- Relates to project-specific patterns or conventions
- Documents decisions or architectural choices

### Memory Naming Conventions
Use descriptive, searchable names:
- `feature_<name>` - Feature-specific knowledge
- `pattern_<name>` - Design patterns used
- `debugging_<issue>` - Known issues and solutions
- `api_<service>` - External API integrations
- `migration_<topic>` - Migration guides

### Memory Examples for BunSane

```typescript
// After discovering how caching works
write_memory("pattern_cache_invalidation", `
# Cache Invalidation Patterns

## Entity Cache
- Invalidated on save() and delete()
- Uses write-through strategy by default
- Key format: entity:{id}

## Component Cache
- Invalidated when component is set/removed
- Key format: component:{entityId}:{componentType}
...
`);

// After debugging a tricky issue
write_memory("debugging_connection_pool_exhaustion", `
# Connection Pool Exhaustion in Tests

## Symptom
Tests hang or timeout with "too many connections"

## Cause
Parallel test workers each create connection pools

## Solution
bunfig.toml has smol=true to limit parallelism
...
`);
```

### Memory Hygiene
- Update outdated memories with `edit_memory`
- Delete obsolete memories with `delete_memory`
- Keep memories focused and concise

---

## 4. Efficient Code Exploration

### Understanding a New Feature

```
1. list_dir("feature/path", recursive=false)     # See structure
2. get_symbols_overview("feature/index.ts")      # Entry point
3. find_symbol("MainClass", depth=1)             # Get methods
4. find_symbol("MainClass/keyMethod", include_body=true)  # Read implementation
5. find_referencing_symbols("keyMethod", ...)    # See usage
```

### Finding Where Something is Defined

```
1. search_for_pattern("ClassName", restrict_search_to_code_files=true)
   OR
2. find_symbol("ClassName")  # If you know it's a symbol
```

### Understanding Call Hierarchy

```
1. find_symbol("methodName", include_body=true)
2. find_referencing_symbols("methodName", relative_path="...")
3. For each caller, repeat if needed
```

### Searching Non-Code Files

```
search_for_pattern("pattern",
    restrict_search_to_code_files=false,
    paths_include_glob="*.md"  # or "*.json", "*.yaml", etc.
)
```

---

## 5. Editing Code Efficiently

### Symbol-Based Editing (Preferred)
Use when replacing entire methods/classes:
```
replace_symbol_body("ClassName/methodName", "relative/path.ts", newBody)
```

### Adding New Code
```
# Add after existing symbol
insert_after_symbol("lastFunction", "file.ts", newCode)

# Add before existing symbol (e.g., new import)
insert_before_symbol("firstSymbol", "file.ts", importStatement)
```

### When to Use File-Based Editing
- Small changes within a large function
- Non-code files (JSON, MD, config)
- When you need to edit multiple locations in one symbol

---

## 6. BunSane-Specific Patterns

### Key Directories to Know
| Directory | Purpose | When to Explore |
|-----------|---------|-----------------|
| `core/` | Framework core | Entity, Component, Cache work |
| `core/components/` | Component system | Adding/modifying components |
| `core/cache/` | Caching system | Cache-related changes |
| `query/` | Query builder | Query/filter changes |
| `gql/` | GraphQL generation | Schema/resolver changes |
| `database/` | DB layer | SQL, migrations |
| `test/` | Tests | Adding/fixing tests |

### Key Symbols to Know
| Symbol | Location | Purpose |
|--------|----------|---------|
| `Entity` | `core/Entity.ts` | Base entity class |
| `BaseComponent` | `core/components/BaseComponent.ts` | Component base |
| `Query` | `query/Query.ts` | Query builder |
| `CacheManager` | `core/cache/CacheManager.ts` | Cache orchestration |
| `App` | `core/App.ts` | Application entry |

### Decorator Patterns
```typescript
// Components
@Component
class MyComponent extends BaseComponent {
    @CompData() field!: string;
}

// ArcheTypes
class MyArcheType extends BaseArcheType {
    @ArcheTypeField(MyComponent) comp!: MyComponent;
}
```

---

## 7. Testing Workflow

### Before Running Tests
1. Ensure PostgreSQL is running
2. Check `.env.test` has correct credentials
3. Database will auto-initialize via `test/setup.ts`

### Test Commands
```bash
bun test                           # All tests
bun test path/to/file.test.ts      # Specific file
bun test --filter "pattern"        # Filter by name
```

### Writing Tests
- Place in `test/` or alongside code in `*/tests/`
- Use `describe`/`test` from `bun:test`
- Clean up created entities in `afterAll`
- Use memory cache provider for unit tests

---

## 8. Think Tools - Use Them!

### After Gathering Information
```
mcp__serena__think_about_collected_information()
```
Ask yourself: Do I have enough info? What's missing?

### Before Making Changes
```
mcp__serena__think_about_task_adherence()
```
Ask yourself: Am I still on track? Is this the right approach?

### When Finishing
```
mcp__serena__think_about_whether_you_are_done()
```
Ask yourself: Did I complete everything? Any loose ends?

---

## 9. Common Pitfalls to Avoid

1. **Reading entire files** - Use symbolic tools instead
2. **Not checking memories** - Previous sessions may have solved similar problems
3. **Forgetting to write memories** - Document discoveries for future sessions
4. **Over-reading** - Only read what you need for the current task
5. **Ignoring `restrict_search_to_code_files`** - Use it to filter noise
6. **Not using depth parameter** - `depth=1` gets immediate children efficiently
7. **Skipping think tools** - They help maintain focus on complex tasks

---

## 10. Quick Reference

### Minimal Context Exploration
```
list_dir(".", recursive=false)
get_symbols_overview("file.ts", depth=0)
find_symbol("Name", include_body=false)
```

### When You Need More Detail
```
get_symbols_overview("file.ts", depth=1)
find_symbol("Name", include_body=true, depth=1)
find_referencing_symbols("Name", "file.ts")
```

### Memory Operations
```
list_memories()
read_memory("memory_name")
write_memory("name", "content")
edit_memory("name", "needle", "replacement", "literal")
delete_memory("name")
```

---

## Summary

**Core Principle**: Minimize context usage while maximizing understanding.

1. Always check memories first
2. Use symbolic tools over file reads
3. Progressive disclosure: broad → narrow → deep
4. Write memories for reusable knowledge
5. Use think tools to stay on track
6. Clean up and update memories as the project evolves
