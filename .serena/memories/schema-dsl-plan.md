# Schema DSL for GraphQL Operation Inputs

## Status: Planning Complete, Ready for Implementation

**Date**: 2026-02-02

## Problem Statement

The current Zod → @gqloom → GraphQL pipeline is broken for complex input types:
- `zod: 4.1.5` (Zod v4 has breaking internal changes)
- `@gqloom/zod: ^0.12.2` (designed for Zod v3)
- `generateInputTypeFromZod()` is 360 lines of workarounds that still fail

### What's Broken
- Nested `z.object()` - Broken
- `.omit()`, `.extend()`, `.partial()` - Broken (empty `_def`)
- Arrays of objects - Broken
- Unions - Broken
- Effects/transforms - Broken
- Only basic scalars work: `z.string()`, `z.number()`, `z.boolean()`

## Solution: Custom Schema DSL

Build a purpose-built DSL (~400 lines) that:
1. Generates GraphQL SDL directly (bypasses @gqloom for inputs)
2. Uses Zod only for runtime validation
3. Coexists with existing system (ArcheTypes still use @gqloom for outputs)

## API Design

```typescript
import { t } from 'bunsane/schema';

@GraphQLOperation({
    type: "Mutation",
    input: {
        email: t.string().email().required(),
        password: t.string().minLength(8).required(),
        settings: t.object({
            theme: t.enum(['light', 'dark'] as const, 'Theme'),
            notifications: t.boolean(),
        }, 'SettingsInput'),
    },
    output: User
})
async createUser(input: InferInput<typeof input>) { ... }
```

## File Structure

```
schema/
├── index.ts           # Public exports: t, InferInput, SchemaType
├── types.ts           # Core interfaces and constraint types
├── builders/
│   ├── index.ts       # Export all builders
│   ├── base.ts        # BaseSchemaType abstract class
│   ├── scalars.ts     # StringType, IntType, FloatType, BooleanType, IDType
│   ├── enum.ts        # EnumType
│   ├── object.ts      # ObjectType (nested inputs)
│   ├── list.ts        # ListType (arrays)
│   └── ref.ts         # RefType (reference existing GraphQL types)
├── generators/
│   ├── graphql.ts     # Generate GraphQL SDL from schema
│   └── zod.ts         # Generate Zod schema from schema
└── inference.ts       # TypeScript type inference helpers
```

## Implementation Phases

### Phase 1: Foundation (Design Complete)
- [x] Core types and interfaces
- [x] Scalar types (String, Int, Float, Boolean, ID)
- [x] `.required()` / `.optional()` / `.nullable()`
- [x] Basic `toGraphQL()` and `toZod()` generation
- [ ] Integration point in SchemaGeneratorVisitor
- [ ] Basic tests

### Phase 2: Validation Constraints
- [ ] String: `.minLength()`, `.maxLength()`, `.email()`, `.url()`, `.uuid()`, `.pattern()`
- [ ] Number: `.min()`, `.max()`, `.positive()`, `.negative()`
- [ ] Zod schema generation with constraints

### Phase 3: Complex Types
- [ ] `ObjectType` for nested inputs
- [ ] `ListType` for arrays
- [ ] `EnumType` with proper GraphQL enum generation
- [ ] Nested type definition collection

### Phase 4: Polish & Migration
- [ ] `InferInput<>` type helper
- [ ] Error messages with field paths
- [ ] Documentation
- [ ] Migration guide

## Key Design Decisions

1. **Single source of truth** - One declaration generates GraphQL SDL + Zod validation + TypeScript types
2. **No @gqloom for inputs** - Generate SDL directly, use Zod only for runtime validation
3. **Coexist with existing system** - ArcheTypes still use @gqloom for output types
4. **Incremental adoption** - Support legacy `GraphQLFieldTypes` alongside new `t.` API

## Related Files

- Plan document: `plan/schema-dsl-analysis.md`
- Current broken implementation: `gql/generators/SchemaGeneratorVisitor.ts` (`generateInputTypeFromZod()`)
- Integration target: `gql/generators/SchemaGeneratorVisitor.ts`