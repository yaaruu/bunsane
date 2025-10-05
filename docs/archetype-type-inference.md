# ArcheType Type Inference Guide

## Overview

The `InferArcheType` utility type allows you to extract component types from an ArcheType class, enabling type-safe component access patterns.

## Two Approaches

### 1. `InferArcheType<T>` - Runtime ComponentMap Inference

This approach infers types from the `componentMap` property, which is populated at runtime.

```typescript
type InferArcheType<T extends BaseArcheType> = {
    [K in keyof T['componentMap']]: T['componentMap'][K] extends new (...args: any[]) => infer C ? C : never
};
```

**Usage:**
```typescript
class UserArcheType extends BaseArcheType {
    @ArcheTypeField(EmailComponent)
    email!: EmailComponent;
}

type UserComponents = InferArcheType<UserArcheType>;
// Result: { email: typeof EmailComponent, ... }
```

**Pros:**
- Reflects the actual runtime structure
- Works with dynamically added components

**Cons:**
- Returns constructor types (`typeof Component`), not instance types
- Requires `componentMap` to be public
- Less accurate for static typing

### 2. `InferArcheTypeFromInstance<T>` - Property-Based Inference (Recommended)

This approach infers types directly from the declared class properties, which is more accurate for compile-time type checking.

```typescript
type InferArcheTypeFromInstance<T extends BaseArcheType> = {
    [K in keyof T as T[K] extends BaseComponent ? K : never]: T[K]
};
```

**Usage:**
```typescript
class UserArcheType extends BaseArcheType {
    @ArcheTypeField(EmailComponent)
    email!: EmailComponent;
    
    @ArcheTypeField(PasswordComponent)
    password!: PasswordComponent;
}

type UserComponents = InferArcheTypeFromInstance<UserArcheType>;
// Result: { email: EmailComponent, password: PasswordComponent }
```

**Pros:**
- Returns actual component instance types
- Fully type-safe at compile time
- Works with TypeScript's type system naturally
- No runtime dependencies

**Cons:**
- Only works with explicitly declared properties
- Doesn't reflect dynamically added components

## Complete Example

```typescript
import BaseArcheType, { 
    InferArcheType, 
    InferArcheTypeFromInstance, 
    ArcheTypeField 
} from './ArcheType';
import { BaseComponent } from './Components';

// Define your components
class EmailComponent extends BaseComponent {
    value!: string;
}

class PasswordComponent extends BaseComponent {
    value!: string;
    hash(): string { return '***'; }
}

class NameComponent extends BaseComponent {
    value!: string;
}

// Define your archetype
class UserArcheType extends BaseArcheType {
    @ArcheTypeField(EmailComponent)
    email!: EmailComponent;

    @ArcheTypeField(PasswordComponent)
    password!: PasswordComponent;

    @ArcheTypeField(NameComponent)
    name!: NameComponent;
}

// Infer the component types
type UserComponents = InferArcheTypeFromInstance<UserArcheType>;

// Type-safe function that expects user components
function validateUser(components: UserComponents): boolean {
    // ✅ All these are fully type-checked!
    const emailValid = components.email.value.includes('@');
    const hasPassword = components.password.value.length > 0;
    const hasName = components.name.value.length > 0;
    
    // ✅ Even component-specific methods are available!
    console.log(components.password.hash());
    
    return emailValid && hasPassword && hasName;
}

// Usage with an entity
async function processUser(entity: Entity) {
    const archetype = new UserArcheType();
    const components = await archetype.Unwrap(entity) as UserComponents;
    
    return validateUser(components);
}
```

## Advanced Usage: Partial Updates

You can combine with TypeScript utility types for partial updates:

```typescript
type UserComponents = InferArcheTypeFromInstance<UserArcheType>;
type PartialUserUpdate = Partial<UserComponents>;

async function updateUser(
    entity: Entity, 
    updates: PartialUserUpdate
): Promise<void> {
    const archetype = new UserArcheType();
    await archetype.updateEntity(entity, updates);
}

// Usage
await updateUser(userEntity, {
    email: newEmailComponent,  // ✅ Type-safe
    // password is optional
});
```

## When to Use Which Approach

**Use `InferArcheType<T>`** when:
- You need constructor types for component creation
- Working with component class references
- Building factory patterns

**Use `InferArcheTypeFromInstance<T>`** when:
- Working with component instances (most common case)
- Need compile-time type safety
- Building type-safe APIs and function signatures

## Technical Details

### Why componentMap needs to be public

TypeScript's type system can only access public members when performing type inference. If `componentMap` is protected or private, the type system cannot read it to perform the inference in `InferArcheType<T>`.

The change from:
```typescript
protected componentMap: Record<string, typeof BaseComponent> = {};
```

To:
```typescript
public componentMap: Record<string, typeof BaseComponent> = {};
```

Allows the type system to access this property for type inference purposes.

### Type Safety Guarantees

Both approaches provide different guarantees:

1. **`InferArcheType<T>`**: Guarantees alignment with runtime `componentMap`
2. **`InferArcheTypeFromInstance<T>`**: Guarantees alignment with declared class structure

For most use cases, **`InferArcheTypeFromInstance<T>` is recommended** because it provides better compile-time safety and works naturally with the decorator pattern.

## Migration Guide

If you're using the old pattern:

```typescript
// Old way (not type-safe)
const data = await archetype.Unwrap(entity);
console.log(data.email); // No type checking!
```

Migrate to:

```typescript
// New way (type-safe)
type UserComponents = InferArcheTypeFromInstance<UserArcheType>;
const data = await archetype.Unwrap(entity) as UserComponents;
console.log(data.email.value); // ✅ Fully type-checked!
```

## See Also

- [ArcheType Documentation](./archetype.md)
- [Component System](./components.md)
- [Entity System](./entity.md)
