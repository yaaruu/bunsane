# Archetype GraphQL Query & Mutation Generation

## Overview
This system automatically generates GraphQL Query and Mutation operations for your archetypes based on their cached schemas.

## Architecture

### 1. Component-Level Schema Caching (✅ Implemented)
- Components like `ServiceAreaInfo` generate Zod schemas once and cache them
- Custom types like `ST_Point` use `__typename` to control GraphQL naming
- Schemas are reused across multiple archetypes

### 2. Archetype Operation Generation (✅ Implemented - Stub)
Located in `gql/ArchetypeOperations.ts`

**Auto-generates for each archetype:**
- `getArchetypeName(id: ID!): ArchetypeName`
- `listArchetypeNames(filter: ArchetypeNameFilter, limit: Int, offset: Int): [ArchetypeName!]!`
- `createArchetypeName(input: CreateArchetypeNameInput!): ArchetypeName!`
- `updateArchetypeName(id: ID!, input: UpdateArchetypeNameInput!): ArchetypeName!`
- `deleteArchetypeName(id: ID!): Boolean!`

## Usage

### Option 1: Auto-Generated CRUD (Current Implementation)
```typescript
// In your App initialization
const { schema, resolvers } = generateGraphQLSchema(services, {
    enableArchetypeOperations: true  // Default
});
```

This generates:
```graphql
type ServiceArea {
  info: serviceAreaInfo!
  price: areaPrice!
}

type ST_Point {
  latitude: Float!
  longitude: Float!
}

type Query {
  getServiceArea(id: ID!): ServiceArea
  listServiceAreas(filter: ServiceAreaFilter, limit: Int, offset: Int): [ServiceArea!]!
}

type Mutation {
  createServiceArea(input: CreateServiceAreaInput!): ServiceArea!
  updateServiceArea(id: ID!, input: UpdateServiceAreaInput!): ServiceArea!
  deleteServiceArea(id: ID!): Boolean!
}
```

### Option 2: Unified Schema (For manual CRUD)
```typescript
import { weaveAllArchetypes } from "bunsane/core/ArcheType";

// Get the unified schema with all archetypes and shared types
const unifiedSchema = weaveAllArchetypes();
console.log(unifiedSchema);  // Full GraphQL SDL
```

## Implementation Status

### ✅ Complete
- Component schema caching
- Custom type naming with `__typename`
- Schema extraction from archetypes
- Type definition generation
- Query/Mutation field generation
- Resolver stubs

### 🚧 TODO
1. **Input Type Generation**
   - Extract fields from Zod schemas
   - Generate `CreateArchetypeInput` with required fields
   - Generate `UpdateArchetypeInput` with optional fields
   - Generate `ArchetypeFilter` with filter operators

2. **Resolver Implementation**
   - Connect to Entity/ArcheType system
   - Implement `get` resolver using `Entity.findById()`
   - Implement `list` resolver with filtering
   - Implement `create` resolver using `archetype.fill().createAndSaveEntity()`
   - Implement `update` resolver using `archetype.updateEntity()`
   - Implement `delete` resolver using `entity.delete()`

3. **Advanced Features**
   - Pagination support
   - Sorting options
   - Relation resolvers (if archetype has nested archetypes)
   - Custom filter operators (eq, ne, gt, lt, contains, etc.)
   - Batch operations

## Next Steps

### Immediate (High Priority)
1. **Implement input type generation from Zod schemas**
   ```typescript
   // Extract from zodSchema.shape and generate GraphQL input types
   function generateCreateInput(archetypeName: string, zodSchema: any): string {
     const fields = Object.entries(zodSchema.shape)
       .filter(([key]) => key !== '__typename' && key !== 'id')
       .map(([key, value]) => `  ${key}: ${zodTypeToGraphQL(value)}`)
       .join('\n');
     return `input Create${archetypeName}Input {\n${fields}\n}\n`;
   }
   ```

2. **Connect resolvers to Entity system**
   ```typescript
   function createCreateResolver(archetypeName: string, archetypeClass: any) {
     return async (_: any, { input }: any, context: any) => {
       const archetype = new archetypeClass();
       const entity = await archetype.fill(input).createAndSaveEntity();
       return archetype.Unwrap(entity);
     };
   }
   ```

### Medium Priority
3. Implement filtering and pagination
4. Add relation resolvers
5. Add custom operation decorators (`@ArchetypeQuery`, `@ArchetypeMutation`)

### Low Priority
6. GraphQL subscriptions for real-time updates
7. DataLoader integration for N+1 query optimization
8. Field-level permissions

## Example: Complete Flow

```typescript
// 1. Define Archetype
@ArcheType("ServiceArea")
export class ServiceAreaArcheType extends BaseArcheType {
    @ArcheTypeField(ServiceAreaInfo)
    info!: ServiceAreaInfo;
    
    @ArcheTypeField(AreaPriceComponent)
    price!: AreaPriceComponent;
}

// 2. Auto-generated GraphQL Schema
type ServiceArea {
  info: serviceAreaInfo!
  price: areaPrice!
}

type serviceAreaInfo {
  name: String!
  center: ST_Point!
}

type ST_Point {
  latitude: Float!
  longitude: Float!
}

input CreateServiceAreaInput {
  info: CreateServiceAreaInfoInput!
  price: CreateAreaPriceInput!
}

type Query {
  getServiceArea(id: ID!): ServiceArea
  listServiceAreas(filter: ServiceAreaFilter, limit: Int, offset: Int): [ServiceArea!]!
}

type Mutation {
  createServiceArea(input: CreateServiceAreaInput!): ServiceArea!
}

// 3. Usage in Client
mutation {
  createServiceArea(input: {
    info: {
      name: "Jakarta Pusat"
      center: {
        latitude: -6.2088
        longitude: 106.8456
      }
    }
    price: {
      area_id: "jkt-center"
      service_type: BIKE
      base_price: 5000
      addition_price_per_km: 2000
    }
  }) {
    info {
      name
      center {
        latitude
        longitude
      }
    }
  }
}
```

## Benefits

1. **Zero Boilerplate**: Define components once, get full CRUD automatically
2. **Type Safety**: Zod schemas ensure runtime validation matches GraphQL types
3. **Reusable Types**: `ST_Point` defined once, used everywhere
4. **Consistency**: All archetypes follow same CRUD pattern
5. **Maintainability**: Change component schema, GraphQL updates automatically
