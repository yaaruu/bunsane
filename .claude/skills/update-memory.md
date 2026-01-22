---
name: update-memory
description: Updating project memories with new information
disable-model-invocation: false
allowed-tools: Read, Grep
---

# Update Memory Skill

This skill helps you update Serena project memories with new or changed information.

## When to Use

Use `/update-memory` when you need to:
- Record architectural decisions or patterns discovered during work
- Update project conventions based on new practices
- Document important findings from code exploration
- Add new information to existing memory files
- Create new memory files for undocumented aspects

## Instructions

1. **List existing memories** first to see what's available:
   - Use `mcp__serena__list_memories` to see all memory files

2. **Read the relevant memory** (if updating existing):
   - Use `mcp__serena__read_memory` with the memory file name
   - Understand the current content and structure

3. **Determine the action**:
   - **Update existing**: Use `mcp__serena__edit_memory` for targeted changes
   - **Create new**: Use `mcp__serena__write_memory` for new topics
   - **Delete obsolete**: Use `mcp__serena__delete_memory` (only if user confirms)

4. **For updates**, use `edit_memory` with:
   - `mode: "literal"` for exact string replacement
   - `mode: "regex"` for pattern-based changes
   - Keep the existing format and style

5. **For new memories**, use descriptive kebab-case names:
   - `project_overview` - General project info
   - `architecture` - System architecture
   - `code_style_and_conventions` - Coding standards
   - `{feature}-implementation` - Feature-specific docs

## Memory Naming Conventions

| Pattern | Purpose |
|---------|---------|
| `project_overview` | High-level project description |
| `architecture` | Directory structure, core concepts |
| `code_style_and_conventions` | Formatting, naming, patterns |
| `{topic}-decisions` | Architectural decisions on topic |
| `{feature}-implementation` | How a feature works |
| `suggested_commands` | Useful commands for the project |
| `task_completion_checklist` | Steps to verify work is complete |

## Example Usage

```
User: /update-memory Add that we use Bun for testing
Assistant: [Lists memories, reads code_style_and_conventions, updates with new testing info]

User: /update-memory Create a memory about the caching system
Assistant: [Creates new memory file: caching-system.md with relevant information]
```

## Important Notes

- Always read existing content before editing to preserve context
- Use markdown format for memory content
- Keep memories focused and organized
- Ask for confirmation before deleting memories
- After updating, summarize what was changed
