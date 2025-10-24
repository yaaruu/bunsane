# New Query DAG System

This directory contains a new implementation of the Query class that uses a Directed Acyclic Graph (DAG) internally for better modularity and extensibility.

## Benefits

- **Modular Architecture**: Each query operation is isolated in its own node
- **Extensible**: Easy to add new query features by creating new node types
- **Maintainable**: Complex query logic is broken down into smaller, testable components
- **Same API**: Drop-in replacement with the same fluent interface

## OR Logic Support

The new Query system supports OR logic using the `or()` function:

```typescript
import { Query, or } from "bunsane/query";

// Find entities that have NameComponent with matching name OR UnitOfMeasure with matching label
const entities = await new Query()
    .with(or([
        { 
            component: NameComponent, 
            filters: [Query.filter("value", Query.filterOp.LIKE, "%search%")] 
        },
        { 
            component: UnitOfMeasure, 
            filters: [Query.filter("label", Query.filterOp.LIKE, "%search%")] 
        }
    ]))
    .exec();
```

### How OR Works

- Each branch in the `or()` array represents an alternative condition
- An entity matches if it satisfies **ANY** of the branches
- Each branch can specify a component and optional filters
- **All entities must have ALL components referenced in the OR query** (not just the matching branch)
- Global constraints (excluded components, entity exclusions) are applied to all results

Example: `or([{component: A, filters: [...]}, {component: B, filters: [...]}])` returns entities that have both A and B components, where either A's filters match OR B's filters match.

### SQL Generation

OR queries generate UNION-based SQL:

```sql
SELECT DISTINCT entity_id FROM (
    -- Branch 1
    SELECT ec.entity_id FROM entity_components ec 
    JOIN components c ON ec.entity_id = c.entity_id AND ec.type_id = $1
    WHERE c.data->>'field1' LIKE $2
    
    UNION
    
    -- Branch 2
    SELECT ec.entity_id FROM entity_components ec 
    JOIN components c ON ec.entity_id = c.entity_id AND ec.type_id = $3
    WHERE c.data->>'field2' LIKE $4
) AS or_results
WHERE entity_id NOT IN (excluded_entities)
-- Additional global constraints...
```

## Combining Requirements with OR Logic

You can combine base component requirements with OR filtering:

```typescript
// Entities must have BOTH User and Post components,
// AND match EITHER the title filter OR the content filter
const entities = await new Query()
    .with(UserComponent)      // Required: entities must have User
    .with(PostComponent)      // Required: entities must have Post  
    .with(or([
        { component: PostComponent, filters: [Query.filter("title", Query.filterOp.LIKE, "%hello%")] },
        { component: PostComponent, filters: [Query.filter("content", Query.filterOp.LIKE, "%world%")] }
    ]))
    .exec();
```

This generates SQL that first ensures entities have the required components, then applies OR filtering.

## Architecture

### Core Components

- **`Query`**: Main class with fluent API (wraps DAG functionality)
- **`QueryContext`**: Shared state management for parameters, aliases, etc.
- **`QueryNode`**: Abstract base class for all query operations
- **`QueryDAG`**: Manages the graph structure and execution

### Node Types

- **`SourceNode`**: Initial entity selection
- **`ComponentInclusionNode`**: Filters by required/excluded components

### Adding New Features

To add new query functionality:

1. Create a new node class extending `QueryNode`
2. Implement the `execute()` method to generate SQL
3. Add the node to the DAG in the appropriate place
4. Update the `Query` class to expose the new functionality

## Migration

The new Query class is designed as a drop-in replacement. Simply change your imports:

```typescript
// Old
import Query from "bunsane/core/Query";

// New
import { Query } from "bunsane/query";
```

## Debug Mode

Enable debug logging to see the generated SQL queries:

```typescript
const entities = await new Query()
    .with(Component)
    .debugMode(true)  // Enable debug logging
    .exec();
```

This will output:
```
🔍 Query DAG Debug:
SQL: SELECT DISTINCT entity_id FROM (...) AS or_results WHERE ...
Params: ['component-id', '%search%', ...]
Context componentIds: ['component-id']
Context excludedComponentIds: []
Context filters: {'component-id': [{field: 'name', operator: 'LIKE', value: '%search%'}]}
---
```