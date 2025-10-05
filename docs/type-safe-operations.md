# Type-Safe GraphQL Operations with Archetypes

## Overview

Instead of using string literals for output types in `@GraphQLOperation`, use **archetype instances** for full type safety, auto-completion, and refactoring support.

## ❌ Before: String Literals (No Type Safety)

```typescript
// Component only - no archetype
export class AreaPriceComponent extends BaseComponent {
    @CompData() area_id!: string;
    @CompData() service_type!: ServiceType;
    @CompData() base_price!: number;
    @CompData() addition_price_per_km!: number;
}

// Service uses string literal
@GraphQLOperation({
    type: "Mutation",
    output: "AreaPrice"  // ❌ String literal - typo-prone, no IDE support
})
async createAreaPrice(args, context, info) {
    const entity = Entity.Create().add(AreaPriceComponent, input);
    await entity.save();
    
    // ❌ Manual object construction
    return {
        id: entity.id,
        ...input
    };
}
```

**Problems:**
- ❌ No compile-time type checking
- ❌ Typos not caught until runtime
- ❌ No IDE auto-completion
- ❌ Refactoring won't update string references
- ❌ Manual object construction error-prone

## ✅ After: Archetype References (Type-Safe)

```typescript
// Component
export class AreaPriceComponent extends BaseComponent {
    @CompData() area_id!: string;
    @CompData() service_type!: ServiceType;
    @CompData() base_price!: number;
    @CompData() addition_price_per_km!: number;
}

// Archetype for AreaPrice
@ArcheType("AreaPrice")
export class AreaPriceArcheType extends BaseArcheType {
    @ArcheTypeField(AreaPriceComponent)
    price!: AreaPriceComponent;
}

// Export instance for use in operations
export const areaPriceArcheType = new AreaPriceArcheType();

// Service uses archetype instance
@GraphQLOperation({
    type: "Mutation",
    output: areaPriceArcheType  // ✅ Type-safe archetype reference!
})
async createAreaPrice(args, context, info) {
    // ✅ Use archetype to create entity
    const entity = await areaPriceArcheType.fill({
        price: input
    }).createAndSaveEntity();
    
    // ✅ Use archetype.Unwrap() for type-safe response
    return areaPriceArcheType.Unwrap(entity);
}
```

**Benefits:**
- ✅ Full compile-time type checking
- ✅ IDE auto-completion for archetype references
- ✅ Refactoring automatically updates references
- ✅ `Unwrap()` ensures correct shape
- ✅ Consistent with archetype-first design

## Pattern Variations

### Single Component Archetype

```typescript
// Simple archetype with one component
@ArcheType("User")
export class UserArcheType extends BaseArcheType {
    @ArcheTypeField(UserProfileComponent)
    profile!: UserProfileComponent;
}

export const userArcheType = new UserArcheType();

@GraphQLOperation({
    type: "Query",
    output: userArcheType  // ✅ Type-safe
})
async getUser(args) {
    const entity = await Entity.FindById(args.id);
    return userArcheType.Unwrap(entity);
}
```

### Multi-Component Archetype

```typescript
// Complex archetype with multiple components
@ArcheType("ServiceArea")
export class ServiceAreaArcheType extends BaseArcheType {
    @ArcheTypeField(ServiceAreaInfo)
    info!: ServiceAreaInfo;
    
    @ArcheTypeField(AreaPriceComponent)
    price!: AreaPriceComponent;
    
    @ArcheTypeField(AreaGeometryComponent)
    geometry!: AreaGeometryComponent;
}

export const serviceAreaArcheType = new ServiceAreaArcheType();

@GraphQLOperation({
    type: "Mutation",
    output: serviceAreaArcheType  // ✅ Type-safe
})
async createServiceArea(args) {
    const entity = await serviceAreaArcheType.fill({
        info: args.info,
        price: args.price,
        geometry: args.geometry
    }).createAndSaveEntity();
    
    return serviceAreaArcheType.Unwrap(entity);
}
```

### Array Output

```typescript
@GraphQLOperation({
    type: "Query",
    output: [serviceAreaArcheType]  // ✅ Array of type-safe archetypes
})
async listServiceAreas(args) {
    const entities = await Entity.Find({
        where: { /* filters */ }
    });
    
    // Map each entity through Unwrap()
    return entities.map(e => serviceAreaArcheType.Unwrap(e));
}
```

## Type Safety Levels

### Level 1: String Literals (Least Safe)
```typescript
output: "AreaPrice"  // ❌ No type safety at all
```

### Level 2: Type Constants (Moderate Safety)
```typescript
const OUTPUT_TYPES = {
    AreaPrice: "AreaPrice",
    ServiceArea: "ServiceArea"
} as const;

output: OUTPUT_TYPES.AreaPrice  // ⚠️ Better, but still strings
```

### Level 3: Archetype References (Most Safe) ✅
```typescript
output: areaPriceArcheType  // ✅ Full TypeScript type safety
```

## Migration Guide

### Step 1: Create Archetype for Each Output Type

**Before:**
```typescript
// Just component
export class DriverComponent extends BaseComponent {
    @CompData() name!: string;
    @CompData() phone!: string;
}
```

**After:**
```typescript
// Component + Archetype
export class DriverComponent extends BaseComponent {
    @CompData() name!: string;
    @CompData() phone!: string;
}

@ArcheType("Driver")
export class DriverArcheType extends BaseArcheType {
    @ArcheTypeField(DriverComponent)
    driver!: DriverComponent;
}

export const driverArcheType = new DriverArcheType();
```

### Step 2: Replace String with Archetype Reference

**Before:**
```typescript
@GraphQLOperation({
    output: "Driver"  // ❌ String
})
```

**After:**
```typescript
@GraphQLOperation({
    output: driverArcheType  // ✅ Archetype instance
})
```

### Step 3: Use Unwrap() in Return

**Before:**
```typescript
async getDriver(args) {
    const entity = await Entity.FindById(args.id);
    const driver = await entity.get(DriverComponent);
    return { id: entity.id, ...driver };  // ❌ Manual
}
```

**After:**
```typescript
async getDriver(args) {
    const entity = await Entity.FindById(args.id);
    return driverArcheType.Unwrap(entity);  // ✅ Type-safe
}
```

## Advanced: TypeScript Type Extraction

Extract TypeScript types from archetypes for function signatures:

```typescript
// Get the TypeScript type from archetype instance
type AreaPriceData = ReturnType<typeof areaPriceArcheType.Unwrap>;

// Use in function signatures
function processAreaPrice(data: AreaPriceData) {
    // data is fully typed!
    console.log(data.price.base_price);  // ✅ Auto-complete works
}

// Or use the class type directly
type ServiceAreaData = InstanceType<typeof ServiceAreaArcheType>;
```

## How It Works Internally

When you pass an archetype instance to `output`:

1. **Schema Generation**: The GraphQL generator extracts the archetype's name and Zod schema
   ```typescript
   const archetypeName = archetype.constructor.name.replace("ArcheType", "");
   const zodSchema = archetype.getZodObjectSchema();
   ```

2. **Type Registration**: The archetype's schema is cached and reused
   ```typescript
   ArchetypeSchemaRegistry.set(archetypeName, {
       schema: zodSchema,
       graphqlType: weave(ZodWeaver, zodSchema)
   });
   ```

3. **Runtime Resolution**: `Unwrap()` extracts component data from entities
   ```typescript
   Unwrap(entity: Entity) {
       const result: any = { id: entity.id };
       for (const [key, ComponentClass] of this.fields) {
           result[key] = await entity.get(ComponentClass);
       }
       return result;
   }
   ```

## Benefits Summary

| Aspect | String Literal | Archetype Reference |
|--------|---------------|---------------------|
| Compile-time check | ❌ | ✅ |
| IDE auto-complete | ❌ | ✅ |
| Refactoring support | ❌ | ✅ |
| Type inference | ❌ | ✅ |
| Runtime validation | ⚠️ | ✅ |
| Code consistency | ❌ | ✅ |

## When to Create an Archetype

**Create an archetype when:**
- ✅ The type is returned from GraphQL operations
- ✅ You need multiple components together (e.g., Profile + Settings)
- ✅ You want type-safe entity creation with `fill()`
- ✅ You need consistent data structure across queries/mutations

**Stick with component only when:**
- Component is only used internally
- Never returned directly from GraphQL
- Used only as part of other archetypes

## Best Practices

1. **Export both class and instance:**
   ```typescript
   export class AreaPriceArcheType extends BaseArcheType { /* ... */ }
   export const areaPriceArcheType = new AreaPriceArcheType();
   ```

2. **Use consistent naming:**
   - Class: `{Name}ArcheType`
   - Instance: `{name}ArcheType` (camelCase)
   - GraphQL type: `{Name}` (from `@ArcheType("Name")`)

3. **Always use Unwrap():**
   ```typescript
   return archetype.Unwrap(entity);  // ✅ Type-safe
   // NOT: return { id: entity.id, ... }  // ❌ Manual
   ```

4. **Prefer fill() for creation:**
   ```typescript
   const entity = await archetype.fill(data).createAndSaveEntity();
   // Better than: Entity.Create().add(Component, data)
   ```

## See Also

- [Archetype System](./archetype-system.md) - Core concepts
- [Decorator Strategy](./decorator-strategy-guide.md) - When to use decorators
- [Refactoring Guide](./archetype-refactoring-guide.md) - Migration steps
