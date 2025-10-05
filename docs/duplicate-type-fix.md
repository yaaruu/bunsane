# Fix for Duplicate GraphQL Type Definitions

## Problem

When generating GraphQL schemas from archetypes, the same type (e.g., `areaPrice`) was being defined multiple times because:

1. Multiple archetypes used the same component (e.g., `AreaPriceComponent`)
2. Each archetype would generate a complete GraphQL schema including all nested types
3. The `generateArchetypeOperations()` function concatenated all schemas without checking for duplicates

### Example of the Issue

```graphql
# From ServiceArea archetype
type ServiceArea {
  id: String
  info: serviceAreaInfo!
  price: areaPrice!  # ← Uses areaPrice
}

type areaPrice {  # ← First definition
  area_id: String!
  service_type: ServiceType!
  base_price: Float!
  addition_price_per_km: Float!
}

# From AreaPrice archetype
type AreaPrice {
  id: String
  price: areaPrice!  # ← Also uses areaPrice
}

type areaPrice {  # ← Duplicate definition! ❌
  area_id: String!
  service_type: ServiceType!
  base_price: Float!
  addition_price_per_km: Float!
}
```

## Solution

Modified `gql/ArchetypeOperations.ts` to deduplicate type definitions:

### 1. Added Type Tracking
```typescript
// Track defined types to prevent duplicates
const definedTypes = new Set<string>();
```

### 2. Created Deduplication Function
```typescript
function deduplicateTypeDefinitions(typeDefinitions: string, definedTypes: Set<string>): string
```

This function:
- Parses GraphQL type definitions line by line
- Identifies type/enum/input declarations
- Tracks which types have been defined in a Set
- Only includes each type once in the output
- Logs when types are added or skipped

### 3. Updated generateArchetypeOperations
```typescript
schemas.forEach(({ zodSchema, graphqlSchema }) => {
    const typeDefinitions = extractTypeDefinitions(graphqlSchema);
    const deduplicatedTypes = deduplicateTypeDefinitions(typeDefinitions, definedTypes);
    typeDefs += deduplicatedTypes;
});
```

## Result

Now the generated schema will only contain one definition of `areaPrice`:

```graphql
type ServiceArea {
  id: String
  info: serviceAreaInfo!
  price: areaPrice!
}

type AreaPrice {
  id: String
  price: areaPrice!
}

# Only ONE definition of areaPrice
type areaPrice {
  area_id: String!
  service_type: ServiceType!
  base_price: Float!
  addition_price_per_km: Float!
}

enum ServiceType {
  jek
  car
  food
  package
}
```

## Technical Details

### How Deduplication Works

1. **Parsing**: The function reads type definitions line by line
2. **Pattern Matching**: Detects starts of type definitions using regex: `/^(type|enum|input)\s+(\w+)/`
3. **State Machine**: Tracks whether we're inside a type definition
4. **Set Tracking**: Uses a `Set<string>` to remember which types have been added
5. **Output Control**: Only adds a type to output if it hasn't been seen before

### Edge Cases Handled

- Types that span multiple lines
- Nested object types
- Enum definitions
- Input type definitions
- Comments and whitespace preservation
- Types without closing braces (malformed but won't crash)

## Benefits

✅ **Valid GraphQL Schema**: No duplicate type errors  
✅ **Maintains Relationships**: All references to shared types still work  
✅ **Performance**: Component schemas are still cached and reused  
✅ **Logging**: Clear trace logs show which types are added/skipped  
✅ **Type Safety**: Full TypeScript support maintained  
✅ **Proper ID Type**: ID fields now use GraphQL `ID` scalar instead of `String`

## Additional Fix: ID Scalar Type

### Problem
Generated types were using `String` for the `id` field:
```graphql
type ServiceArea {
  id: String  # ❌ Should be ID
  info: serviceAreaInfo!
  price: areaPrice!
}
```

### Solution
Modified `core/ArcheType.ts` to post-process the generated GraphQL schema and convert `id: String` to `id: ID`:

```typescript
const shape: Record<string, z.ZodTypeAny> = {
    __typename: z.literal(nameFromStorage).nullish(),
    id: z.string().nullish(),  // Will be converted to ID in post-processing
};

// ... generate schema ...
const schema = weave(ZodWeaver, ...schema_arr);
let graphqlSchemaString = printSchema(schema);

// Post-process: Replace 'id: String' with 'id: ID' for all id fields
graphqlSchemaString = graphqlSchemaString.replace(/\bid:\s*String\b/g, 'id: ID');
```

**Why post-processing?** GQLoom's ZodWeaver doesn't provide a direct way to map Zod string types to GraphQL ID scalars within object schemas. The post-processing approach is simple, reliable, and ensures all `id` fields consistently use the GraphQL `ID` scalar type.

### Result
```graphql
type ServiceArea {
  id: ID  # ✅ Correct GraphQL ID scalar
  info: serviceAreaInfo!
  price: areaPrice!
}
```

The `ID` scalar type is semantically correct for unique identifiers and is the GraphQL best practice.  

## Testing

To verify the fix works:

1. Create multiple archetypes that use the same component
2. Generate the GraphQL schema
3. Check the output - each type should appear only once
4. Verify all relationships still resolve correctly

Example test:
```typescript
const schemas = getAllArchetypeSchemas();
const ops = generateArchetypeOperations();
// ops.typeDefs should not contain duplicate type definitions
```

## Related Files

- `core/ArcheType.ts` - Where component schemas are generated and cached
- `gql/ArchetypeOperations.ts` - Where deduplication happens (FIXED)
- `gql/Generator.ts` - Where the final schema is assembled
