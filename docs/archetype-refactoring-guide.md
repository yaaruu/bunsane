# Archetype Refactoring Guide: What to Remove

## ❌ What You DON'T Need Anymore

### 1. Manual GraphQL Type Definitions
```typescript
// ❌ REMOVE - Archetype auto-generates these
@GraphQLObjectType({
    name: "PointLocation",
    fields: {
        latitude: GraphQLFieldTypes.FLOAT_REQUIRED,
        longitude: GraphQLFieldTypes.FLOAT_REQUIRED
    }
})
@GraphQLObjectType({
    name: "ServiceArea",
    fields: {
        id: GraphQLFieldTypes.ID_REQUIRED,
        name: GraphQLFieldTypes.STRING_REQUIRED,
        center: "PointLocation!",
        prices: "[AreaPrice]"
    }
})
```

**Why?** The archetype system generates these from your components:
- `ST_Point` replaces `PointLocation`
- `ServiceArea` is generated from `ServiceAreaArcheType`
- Type definitions come from component `@CompData()` decorators

### 2. All Field Resolvers
```typescript
// ❌ REMOVE - Archetype handles these automatically
@GraphQLField({type: "ServiceArea", field: "id"})
async ServiceArea_id(parent: Entity) {
    return parent.id;
}

@GraphQLField({type: "ServiceArea", field: "name"})
async ServiceArea_name(parent: Entity) {
    const name = await parent.get(ServiceAreaInfo);
    return name?.name || "";
}

@GraphQLField({type: "ServiceArea", field: "center"})
async ServiceArea_center(parent: Entity) {
    const center = await parent.get(ServiceAreaInfo);
    return center?.center || { latitude: 0, longitude: 0 };
}

// ... 10+ more field resolvers ❌
```

**Why?** When you use `archetype.Unwrap(entity)`, it automatically:
- Extracts all component data
- Maps component properties to GraphQL fields
- Handles nested objects like `ST_Point`

### 3. Duplicate Input Type Definitions
```typescript
// ❌ REMOVE - Can use Zod schema directly
const AreaServiceOperation = {
    createArea: {
        name: GraphQLFieldTypes.STRING_REQUIRED,
        center: "PointLocation",
    } as const,
    // ...
}
```

**Why?** You can:
- Use Zod schemas for validation (`z.infer<typeof Schema>`)
- Input types will be auto-generated from archetype schemas (coming soon)
- Less duplication = less bugs

### 4. Custom Type Definitions for Standard Components
```typescript
// ❌ REMOVE - Use ST_Point from plugin
@GraphQLObjectType({
    name: "PointLocation",  // Duplicate of ST_Point!
    fields: {
        latitude: GraphQLFieldTypes.FLOAT_REQUIRED,
        longitude: GraphQLFieldTypes.FLOAT_REQUIRED
    }
})
```

**Why?** `ST_Point` is registered as a custom type and reused everywhere

## ✅ What You KEEP

### 1. Operation Decorators (Queries/Mutations)
```typescript
// ✅ KEEP - These define your business logic
@GraphQLOperation({
    type: "Mutation",
    input: { ... },
    output: "ServiceArea"  // Type auto-generated from archetype
})
async createServiceArea(args, context, info) {
    // Your logic here
}
```

### 2. Validation Schemas
```typescript
// ✅ KEEP - For runtime validation
const CreateServiceAreaSchema = z.object({
    name: z.string().min(3).max(100),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
});
```

### 3. Business Logic & Authorization
```typescript
// ✅ KEEP - Your domain logic
const auth = await AdminAuthService.Authorize(context, [AdminResource.area.write]);
if(auth instanceof Error) return auth;

// Validation, duplicate checks, etc.
const existing = await AreaService.GetPriceForAreaWithType(input.area_id, input.service_type);
if(existing.length > 0) {
    return responseError("Already exists", {...});
}
```

### 4. Utility Methods
```typescript
// ✅ KEEP - Helper functions
static async GetPriceForAreaWithType(areaId: string, serviceType: ServiceType): Promise<Entity[]> {
    return await new Query()
        .with(AreaPriceComponent, /* filters */)
        .exec();
}
```

## 📊 Line Count Comparison

### Before (Current AreaService.ts)
- **257 lines total**
- Manual type definitions: ~40 lines
- Field resolvers: ~80 lines
- Business logic: ~137 lines

### After (Using Archetypes)
- **~120 lines total** (53% reduction!)
- Manual type definitions: 0 lines ✅
- Field resolvers: 0 lines ✅
- Business logic: ~120 lines (same)

## 🔄 Migration Steps

### Step 1: Remove Type Definitions
Delete all `@GraphQLObjectType` decorators - the archetype system generates these.

### Step 2: Remove Field Resolvers
Delete all `@GraphQLField` methods - `archetype.Unwrap()` handles field resolution.

### Step 3: Update Operations to Use Archetypes
```typescript
// Before
const entity = Entity.Create().add(ServiceAreaInfo, {...});
await entity.save();
return entity;  // ❌ Returns Entity, GraphQL needs field resolvers

// After
const entity = await serviceAreaArcheType
    .fill({ info: {...} })
    .createAndSaveEntity();
return serviceAreaArcheType.Unwrap(entity);  // ✅ Returns plain object with all fields
```

### Step 4: Update GraphQL Output Types
```typescript
// Before
output: "ServiceArea"  // Manually defined type

// After
output: "ServiceArea"  // Auto-generated from ServiceAreaArcheType
```

## 🎯 Benefits

1. **Less Code**: 53% reduction in boilerplate
2. **Type Safety**: Components define both DB schema AND GraphQL types
3. **DRY Principle**: Define structure once, use everywhere
4. **Maintainability**: Change component → GraphQL updates automatically
5. **Consistency**: All archetypes follow same pattern
6. **Reusability**: `ST_Point` defined once, used in multiple archetypes

## 🚀 Next Level: Full Automation

Once the archetype CRUD generation is complete, you could even remove the operation definitions:

```typescript
// Future: Zero boilerplate!
// Just enable archetype operations in config:
// enableArchetypeOperations: true

// Auto-generates:
// - getServiceArea(id: ID!): ServiceArea
// - listServiceAreas(...): [ServiceArea!]!
// - createServiceArea(input: CreateServiceAreaInput!): ServiceArea!
// - updateServiceArea(id: ID!, input: UpdateServiceAreaInput!): ServiceArea!
// - deleteServiceArea(id: ID!): Boolean!
```

Then your service only contains:
- Custom business logic
- Complex queries
- Authorization rules
- Validation overrides

## 📝 Summary

**Remove:**
- ❌ `@GraphQLObjectType` decorators (40 lines)
- ❌ `@GraphQLField` resolvers (80 lines)
- ❌ Duplicate type definitions (20 lines)

**Keep:**
- ✅ `@GraphQLOperation` decorators
- ✅ Zod validation schemas
- ✅ Business logic & authorization
- ✅ Utility methods

**Result:**
- 53% less code
- 100% more maintainable
- Same functionality
