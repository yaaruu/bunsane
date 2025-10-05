# Decorator Strategy: @GraphQLOperation vs Auto-Generation

## TL;DR Decision Tree

```
Do you need custom business logic, auth, or validation?
├─ YES → Use @GraphQLOperation decorator (Option 1)
└─ NO  → Use auto-generated operations (Option 2)
```

---

## Option 1: Manual @GraphQLOperation ✅ Current Approach

### What You Keep:
```typescript
@GraphQLOperation({
    type: "Query" | "Mutation",
    input: { /* fields */ },      // Optional for queries
    output: "ServiceArea"          // References auto-generated type
})
async myOperation(args, context, info) {
    // Your custom logic here
}
```

### What Changed with Archetypes:
```diff
  @GraphQLOperation({
      type: "Query",
-     output: "ServiceArea"  // ❌ Manual @GraphQLObjectType definition
+     output: "ServiceArea"  // ✅ Auto-generated from ServiceAreaArcheType
  })
  async getServiceAreas(args, context, info) {
      const entities = await new Query().with(ServiceAreaInfo).exec();
-     return entities;  // ❌ Needs field resolvers
+     return entities.map(e => serviceAreaArcheType.Unwrap(e));  // ✅ No field resolvers!
  }
```

### Before vs After

#### Before (Old Way):
```typescript
// ❌ Had to define type manually
@GraphQLObjectType({
    name: "ServiceArea",
    fields: {
        id: "ID!",
        name: "String!",
        center: "PointLocation!"
    }
})

// ❌ Operation uses manual type
@GraphQLOperation({
    output: "ServiceArea"
})
async getServiceAreas() {
    return entities;
}

// ❌ Had to write field resolvers
@GraphQLField({type: "ServiceArea", field: "id"})
async ServiceArea_id(parent: Entity) {
    return parent.id;
}

@GraphQLField({type: "ServiceArea", field: "name"})
async ServiceArea_name(parent: Entity) {
    const info = await parent.get(ServiceAreaInfo);
    return info?.name;
}
// ... 10+ more resolvers
```

#### After (With Archetypes):
```typescript
// ✅ Type auto-generated from archetype - NO manual definition needed!
// ServiceAreaArcheType → ServiceArea type

// ✅ Operation uses auto-generated type
@GraphQLOperation({
    output: "ServiceArea"  // References auto-generated type
})
async getServiceAreas() {
    const entities = await new Query().with(ServiceAreaInfo).exec();
    return entities.map(e => serviceAreaArcheType.Unwrap(e));  // ✅ One line!
}

// ✅ NO field resolvers needed - Unwrap() handles everything!
```

### When to Use This:
- ✅ Custom authorization (like your AdminAuthService)
- ✅ Complex validation beyond Zod schemas
- ✅ Business logic (checking duplicates, calculations, etc.)
- ✅ Custom query filtering
- ✅ You want explicit control over operations

---

## Option 2: Auto-Generated Operations 🚀 Future/Optional

### Configuration:
```typescript
// In your GraphQL schema generation
const { schema, resolvers } = generateGraphQLSchema(services, {
    enableArchetypeOperations: true  // Enable auto-generation
});
```

### What Gets Generated:
For each archetype (e.g., `ServiceAreaArcheType`), automatically creates:

```graphql
type Query {
  # Auto-generated
  getServiceArea(id: ID!): ServiceArea
  listServiceAreas(
    filter: ServiceAreaFilter
    limit: Int
    offset: Int
  ): [ServiceArea!]!
}

type Mutation {
  # Auto-generated
  createServiceArea(input: CreateServiceAreaInput!): ServiceArea!
  updateServiceArea(id: ID!, input: UpdateServiceAreaInput!): ServiceArea!
  deleteServiceArea(id: ID!): Boolean!
}

# Input types auto-generated from archetype components
input CreateServiceAreaInput {
  info: CreateServiceAreaInfoInput!
  price: CreateAreaPriceInput
}

input CreateServiceAreaInfoInput {
  name: String!
  center: ST_PointInput!
}

input ST_PointInput {
  latitude: Float!
  longitude: Float!
}

input ServiceAreaFilter {
  id: ID
  name: String
  # More filters...
}
```

### Your Code Becomes:
```typescript
class AreaService extends BaseService {
    // 🎉 NO decorators needed for standard CRUD!
    
    // Only add custom operations with business logic:
    @GraphQLOperation({
        type: "Query",
        output: "[ServiceArea]"
    })
    async getServiceAreasNearLocation(args: {lat: number, lng: number, radius: number}) {
        // Custom spatial query logic
    }
}
```

### When to Use This:
- ✅ Rapid prototyping
- ✅ Admin panels with generic CRUD
- ✅ Simple data management interfaces
- ✅ No special business logic needed
- ✅ Standard authorization (configured globally)

---

## Hybrid Approach 🎯 **RECOMMENDED**

Use both strategies together:

```typescript
class AreaService extends BaseService {
    // 🚀 Let archetype system auto-generate these:
    // - getServiceArea(id)
    // - listServiceAreas(filter, limit, offset)
    // - createServiceArea(input)
    // - updateServiceArea(id, input)
    // - deleteServiceArea(id)
    
    // ✅ Only add custom operations with special logic:
    
    @GraphQLOperation({
        type: "Query",
        output: "[ServiceArea]"
    })
    async getServiceAreasForAdmin(args, context, info) {
        // Custom: Requires admin auth
        const auth = await AdminAuthService.Authorize(context, [AdminResource.area.read]);
        if(auth instanceof Error) return auth;
        
        // Custom: Special filtering for admin view
        const entities = await new Query()
            .with(ServiceAreaInfo)
            .exec();
        
        return entities.map(e => serviceAreaArcheType.Unwrap(e));
    }
    
    @GraphQLOperation({
        type: "Mutation",
        input: { area_id: "ID!", service_type: "String!", ... },
        output: "AreaPrice"
    })
    async createAreaPrice(args, context, info) {
        // Custom: Admin auth
        const auth = await AdminAuthService.Authorize(context, [AdminResource.area.write]);
        
        // Custom: Duplicate check
        const existing = await AreaService.GetPriceForAreaWithType(...);
        if(existing.length > 0) {
            return responseError("Already exists");
        }
        
        // Standard: Entity creation (could be auto-generated)
        const entity = Entity.Create().add(AreaPriceComponent, args);
        await entity.save();
        return { id: entity.id, ...args };
    }
}
```

---

## Migration Path

### Phase 1: Current (Where you are now) ✅
- Keep `@GraphQLOperation` decorators
- Remove `@GraphQLObjectType` decorators (types auto-generated)
- Remove `@GraphQLField` resolvers (use `archetype.Unwrap()`)
- **Benefit**: 50% code reduction, still full control

### Phase 2: Enable Auto-Generation (Optional)
```typescript
// Enable in config
generateGraphQLSchema(services, {
    enableArchetypeOperations: true
});

// Remove simple CRUD operations
// Keep only operations with custom logic
```
- **Benefit**: 80% code reduction for CRUD, focus on business logic

### Phase 3: Global Auth/Validation (Future)
```typescript
// Configure global auth rules
archetype.configure({
    authorization: {
        read: [AdminResource.area.read],
        write: [AdminResource.area.write]
    }
});

// Now even auto-generated operations have auth!
```
- **Benefit**: 90% code reduction, declarative security

---

## What to Remove RIGHT NOW

### ❌ Remove These (100% Safe):

1. **All `@GraphQLObjectType` decorators**
   ```typescript
   // ❌ DELETE
   @GraphQLObjectType({
       name: "ServiceArea",
       fields: { ... }
   })
   ```

2. **All `@GraphQLField` resolvers**
   ```typescript
   // ❌ DELETE
   @GraphQLField({type: "ServiceArea", field: "id"})
   async ServiceArea_id(parent: Entity) { ... }
   ```

3. **Duplicate type definitions**
   ```typescript
   // ❌ DELETE - Use ST_Point instead
   @GraphQLObjectType({
       name: "PointLocation",
       fields: { latitude: "Float!", longitude: "Float!" }
   })
   ```

### ✅ Keep These (For Now):

1. **`@GraphQLOperation` decorators**
   ```typescript
   // ✅ KEEP - But simplify the implementation
   @GraphQLOperation({
       type: "Query",
       output: "[ServiceArea]"  // Now references auto-generated type
   })
   async getServiceAreas() {
       // Use archetype.Unwrap() instead of field resolvers
   }
   ```

2. **Zod validation schemas**
   ```typescript
   // ✅ KEEP
   const CreateServiceAreaSchema = z.object({
       name: z.string().min(3),
       latitude: z.number()
   });
   ```

3. **Business logic & auth**
   ```typescript
   // ✅ KEEP
   const auth = await AdminAuthService.Authorize(...);
   const existing = await checkDuplicates(...);
   ```

---

## Summary

**Current Best Practice:**

```typescript
// ✅ YES: Use @GraphQLOperation with auto-generated types
@GraphQLOperation({
    type: "Mutation",
    output: "ServiceArea"  // Auto-generated from ServiceAreaArcheType
})
async createServiceArea(args, context, info) {
    // Auth, validation, business logic
    const entity = await archetype.fill(args).createAndSaveEntity();
    return archetype.Unwrap(entity);  // No field resolvers needed!
}

// ❌ NO: Don't manually define types
@GraphQLObjectType({ name: "ServiceArea", ... })  // DELETE THIS

// ❌ NO: Don't write field resolvers
@GraphQLField({ type: "ServiceArea", field: "id" })  // DELETE THIS
```

**Result:**
- Keep operation control via `@GraphQLOperation`
- Get automatic type generation from archetypes
- Eliminate all field resolver boilerplate
- ~50-80% less code
