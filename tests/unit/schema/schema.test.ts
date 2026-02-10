import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
  t,
  SCHEMA_DSL_MARKER,
  isSchemaType,
  isSchemaInput,
  collectNestedTypeDefs,
} from '../../../gql/schema';
import type { SchemaType, InferInput } from '../../../gql/schema';

// ---------------------------------------------------------------------------
// 1. Scalar Types - toGraphQL()
// ---------------------------------------------------------------------------

describe('Scalar Types - toGraphQL()', () => {
  test('t.string().toGraphQL() returns "String"', () => {
    expect(t.string().toGraphQL()).toBe('String');
  });

  test('t.string().required().toGraphQL() returns "String!"', () => {
    expect(t.string().required().toGraphQL()).toBe('String!');
  });

  test('t.int().toGraphQL() returns "Int"', () => {
    expect(t.int().toGraphQL()).toBe('Int');
  });

  test('t.int().required().toGraphQL() returns "Int!"', () => {
    expect(t.int().required().toGraphQL()).toBe('Int!');
  });

  test('t.float().toGraphQL() returns "Float"', () => {
    expect(t.float().toGraphQL()).toBe('Float');
  });

  test('t.float().required().toGraphQL() returns "Float!"', () => {
    expect(t.float().required().toGraphQL()).toBe('Float!');
  });

  test('t.boolean().toGraphQL() returns "Boolean"', () => {
    expect(t.boolean().toGraphQL()).toBe('Boolean');
  });

  test('t.boolean().required().toGraphQL() returns "Boolean!"', () => {
    expect(t.boolean().required().toGraphQL()).toBe('Boolean!');
  });

  test('t.id().toGraphQL() returns "ID"', () => {
    expect(t.id().toGraphQL()).toBe('ID');
  });

  test('t.id().required().toGraphQL() returns "ID!"', () => {
    expect(t.id().required().toGraphQL()).toBe('ID!');
  });
});

// ---------------------------------------------------------------------------
// 2. Scalar Types - toZod()
// ---------------------------------------------------------------------------

describe('Scalar Types - toZod()', () => {
  test('t.string().required().toZod() parses "hello" successfully', () => {
    const schema = t.string().required().toZod();
    const result = schema.safeParse('hello');
    expect(result.success).toBe(true);
  });

  test('t.string().toZod() parses undefined successfully (optional)', () => {
    const schema = t.string().toZod();
    const result = schema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  test('t.int().required().toZod() parses 42 successfully', () => {
    const schema = t.int().required().toZod();
    const result = schema.safeParse(42);
    expect(result.success).toBe(true);
  });

  test('t.int().required().toZod() rejects 3.14 (not integer)', () => {
    const schema = t.int().required().toZod();
    const result = schema.safeParse(3.14);
    expect(result.success).toBe(false);
  });

  test('t.float().required().toZod() parses 3.14 successfully', () => {
    const schema = t.float().required().toZod();
    const result = schema.safeParse(3.14);
    expect(result.success).toBe(true);
  });

  test('t.boolean().required().toZod() parses true successfully', () => {
    const schema = t.boolean().required().toZod();
    const result = schema.safeParse(true);
    expect(result.success).toBe(true);
  });

  test('t.id().required().toZod() parses "abc-123" successfully', () => {
    const schema = t.id().required().toZod();
    const result = schema.safeParse('abc-123');
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. String Constraints
// ---------------------------------------------------------------------------

describe('String Constraints', () => {
  test('minLength(3) rejects "ab" (too short)', () => {
    const schema = t.string().minLength(3).required().toZod();
    const result = schema.safeParse('ab');
    expect(result.success).toBe(false);
  });

  test('minLength(3) accepts "abc"', () => {
    const schema = t.string().minLength(3).required().toZod();
    const result = schema.safeParse('abc');
    expect(result.success).toBe(true);
  });

  test('maxLength(5) rejects "abcdef"', () => {
    const schema = t.string().maxLength(5).required().toZod();
    const result = schema.safeParse('abcdef');
    expect(result.success).toBe(false);
  });

  test('email() accepts "user@example.com"', () => {
    const schema = t.string().email().required().toZod();
    const result = schema.safeParse('user@example.com');
    expect(result.success).toBe(true);
  });

  test('email() rejects "not-email"', () => {
    const schema = t.string().email().required().toZod();
    const result = schema.safeParse('not-email');
    expect(result.success).toBe(false);
  });

  test('url() accepts "https://example.com"', () => {
    const schema = t.string().url().required().toZod();
    const result = schema.safeParse('https://example.com');
    expect(result.success).toBe(true);
  });

  test('uuid() accepts valid UUID', () => {
    const schema = t.string().uuid().required().toZod();
    const result = schema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(true);
  });

  test('pattern(/^[A-Z]+$/) accepts "ABC"', () => {
    const schema = t.string().pattern(/^[A-Z]+$/).required().toZod();
    const result = schema.safeParse('ABC');
    expect(result.success).toBe(true);
  });

  test('pattern(/^[A-Z]+$/) rejects "abc"', () => {
    const schema = t.string().pattern(/^[A-Z]+$/).required().toZod();
    const result = schema.safeParse('abc');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Number Constraints
// ---------------------------------------------------------------------------

describe('Number Constraints', () => {
  test('t.int().min(1) rejects 0', () => {
    const schema = t.int().min(1).required().toZod();
    const result = schema.safeParse(0);
    expect(result.success).toBe(false);
  });

  test('t.int().min(1) accepts 1', () => {
    const schema = t.int().min(1).required().toZod();
    const result = schema.safeParse(1);
    expect(result.success).toBe(true);
  });

  test('t.int().max(10) rejects 11', () => {
    const schema = t.int().max(10).required().toZod();
    const result = schema.safeParse(11);
    expect(result.success).toBe(false);
  });

  test('t.float().min(0.5).max(9.5) accepts 5.0', () => {
    const schema = t.float().min(0.5).max(9.5).required().toZod();
    const result = schema.safeParse(5.0);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Nullable modifier
// ---------------------------------------------------------------------------

describe('Nullable modifier', () => {
  test('t.string().nullable().required().toZod() accepts null', () => {
    const schema = t.string().nullable().required().toZod();
    const result = schema.safeParse(null);
    expect(result.success).toBe(true);
  });

  test('t.string().required().nullable().toZod() accepts null', () => {
    const schema = t.string().required().nullable().toZod();
    const result = schema.safeParse(null);
    expect(result.success).toBe(true);
  });

  test('t.string().required().toZod() rejects null', () => {
    const schema = t.string().required().toZod();
    const resultNull = schema.safeParse(null);
    expect(resultNull.success).toBe(false);
  });

  test('t.string().required().toZod() rejects undefined', () => {
    const schema = t.string().required().toZod();
    const resultUndef = schema.safeParse(undefined);
    expect(resultUndef.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. ObjectType
// ---------------------------------------------------------------------------

describe('ObjectType', () => {
  const UserInput = t.object({
    id: t.id().required(),
    name: t.string().required(),
    email: t.string().email(),
    age: t.int(),
    active: t.boolean(),
  }, 'UserInput');

  test('toGraphQL() returns the type name', () => {
    expect(UserInput.toGraphQL()).toBe('UserInput');
  });

  test('required().toGraphQL() returns "TypeName!"', () => {
    expect(UserInput.required().toGraphQL()).toBe('UserInput!');
  });

  test('toGraphQLTypeDef() generates correct SDL with all field types', () => {
    const sdl = UserInput.toGraphQLTypeDef();
    expect(sdl).toContain('input UserInput {');
    expect(sdl).toContain('id: ID!');
    expect(sdl).toContain('name: String!');
    expect(sdl).toContain('email: String');
    expect(sdl).toContain('age: Int');
    expect(sdl).toContain('active: Boolean');
    expect(sdl).toContain('}');
  });

  test('toZod() validates correct shape', () => {
    const schema = UserInput.required().toZod();
    const result = schema.safeParse({
      id: '123',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
      active: true,
    });
    expect(result.success).toBe(true);
  });

  test('toZod() rejects missing required fields', () => {
    const schema = UserInput.required().toZod();
    const result = schema.safeParse({
      email: 'alice@example.com',
    });
    expect(result.success).toBe(false);
  });

  test('nested objects generate correct SDL', () => {
    const AddressInput = t.object({
      street: t.string().required(),
      city: t.string().required(),
    }, 'AddressInput');

    const PersonInput = t.object({
      name: t.string().required(),
      address: AddressInput.required(),
    }, 'PersonInput');

    const sdl = PersonInput.toGraphQLTypeDef();
    expect(sdl).toContain('input PersonInput {');
    expect(sdl).toContain('name: String!');
    expect(sdl).toContain('address: AddressInput!');
  });
});

// ---------------------------------------------------------------------------
// 7. ListType
// ---------------------------------------------------------------------------

describe('ListType', () => {
  test('t.list(t.string()).toGraphQL() returns "[String]"', () => {
    expect(t.list(t.string()).toGraphQL()).toBe('[String]');
  });

  test('t.list(t.string().required()).toGraphQL() returns "[String!]"', () => {
    expect(t.list(t.string().required()).toGraphQL()).toBe('[String!]');
  });

  test('t.list(t.string()).required().toGraphQL() returns "[String]!"', () => {
    expect(t.list(t.string()).required().toGraphQL()).toBe('[String]!');
  });

  test('t.list(t.string().required()).required().toGraphQL() returns "[String!]!"', () => {
    expect(t.list(t.string().required()).required().toGraphQL()).toBe('[String!]!');
  });

  test('toZod() validates arrays of strings', () => {
    const schema = t.list(t.string().required()).required().toZod();
    const result = schema.safeParse(['a', 'b', 'c']);
    expect(result.success).toBe(true);
  });

  test('toZod() rejects non-array', () => {
    const schema = t.list(t.string().required()).required().toZod();
    const result = schema.safeParse('not-an-array');
    expect(result.success).toBe(false);
  });

  test('minItems constraint works', () => {
    const schema = t.list(t.string().required()).minItems(2).required().toZod();
    const tooFew = schema.safeParse(['one']);
    expect(tooFew.success).toBe(false);

    const enough = schema.safeParse(['one', 'two']);
    expect(enough.success).toBe(true);
  });

  test('maxItems constraint works', () => {
    const schema = t.list(t.string().required()).maxItems(2).required().toZod();
    const tooMany = schema.safeParse(['a', 'b', 'c']);
    expect(tooMany.success).toBe(false);

    const withinLimit = schema.safeParse(['a', 'b']);
    expect(withinLimit.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. EnumType
// ---------------------------------------------------------------------------

describe('EnumType', () => {
  const StatusEnum = t.enum(['ACTIVE', 'INACTIVE', 'PENDING'] as const, 'Status');

  test('toGraphQL() returns the enum name', () => {
    expect(StatusEnum.toGraphQL()).toBe('Status');
  });

  test('required().toGraphQL() returns "EnumName!"', () => {
    expect(StatusEnum.required().toGraphQL()).toBe('Status!');
  });

  test('toGraphQLTypeDef() generates correct enum SDL', () => {
    const sdl = StatusEnum.toGraphQLTypeDef();
    expect(sdl).toContain('enum Status {');
    expect(sdl).toContain('ACTIVE');
    expect(sdl).toContain('INACTIVE');
    expect(sdl).toContain('PENDING');
    expect(sdl).toContain('}');
  });

  test('toZod() accepts valid values', () => {
    const schema = StatusEnum.required().toZod();
    expect(schema.safeParse('ACTIVE').success).toBe(true);
    expect(schema.safeParse('INACTIVE').success).toBe(true);
    expect(schema.safeParse('PENDING').success).toBe(true);
  });

  test('toZod() rejects invalid values', () => {
    const schema = StatusEnum.required().toZod();
    expect(schema.safeParse('UNKNOWN').success).toBe(false);
    expect(schema.safeParse(123).success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. RefType
// ---------------------------------------------------------------------------

describe('RefType', () => {
  test('t.ref("DateTime").toGraphQL() returns "DateTime"', () => {
    expect(t.ref('DateTime').toGraphQL()).toBe('DateTime');
  });

  test('t.ref("DateTime").required().toGraphQL() returns "DateTime!"', () => {
    expect(t.ref('DateTime').required().toGraphQL()).toBe('DateTime!');
  });

  test('t.ref with custom zod schema validates correctly', () => {
    const dateRef = t.ref('DateTime', z.string().datetime());
    const schema = dateRef.required().toZod();
    expect(schema.safeParse('2026-02-06T12:00:00Z').success).toBe(true);
    expect(schema.safeParse('not-a-date').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. collectNestedTypeDefs
// ---------------------------------------------------------------------------

describe('collectNestedTypeDefs', () => {
  test('collects ObjectType typedef', () => {
    const Item = t.object({ name: t.string().required() }, 'Item');
    const defs = collectNestedTypeDefs({ item: Item });
    expect(defs.size).toBe(1);
    expect(defs.get('Item')).toContain('input Item {');
    expect(defs.get('Item')).toContain('name: String!');
  });

  test('collects EnumType typedef', () => {
    const Color = t.enum(['RED', 'GREEN', 'BLUE'] as const, 'Color');
    const defs = collectNestedTypeDefs({ color: Color });
    expect(defs.size).toBe(1);
    expect(defs.get('Color')).toContain('enum Color {');
  });

  test('collects nested ObjectType typedefs (depth-first)', () => {
    const Inner = t.object({ value: t.int().required() }, 'Inner');
    const Outer = t.object({
      inner: Inner.required(),
      label: t.string().required(),
    }, 'Outer');
    const defs = collectNestedTypeDefs({ root: Outer });
    expect(defs.size).toBe(2);
    // Depth-first: Inner appears before Outer in iteration order
    const keys = Array.from(defs.keys());
    expect(keys[0]).toBe('Inner');
    expect(keys[1]).toBe('Outer');
  });

  test('collects from ListType elements', () => {
    const Tag = t.object({ name: t.string().required() }, 'Tag');
    const defs = collectNestedTypeDefs({ tags: t.list(Tag) });
    expect(defs.size).toBe(1);
    expect(defs.get('Tag')).toContain('input Tag {');
  });

  test('deduplicates by type name', () => {
    const Shared = t.object({ id: t.id().required() }, 'Shared');
    const defs = collectNestedTypeDefs({
      first: Shared,
      second: Shared,
      inList: t.list(Shared),
    });
    expect(defs.size).toBe(1);
    expect(defs.get('Shared')).toContain('input Shared {');
  });

  test('scalar types produce no typedefs', () => {
    const defs = collectNestedTypeDefs({
      name: t.string().required(),
      age: t.int(),
      score: t.float(),
      active: t.boolean(),
      id: t.id(),
    });
    expect(defs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Detection functions
// ---------------------------------------------------------------------------

describe('Detection functions', () => {
  test('isSchemaType returns true for all t.xxx() builders', () => {
    expect(isSchemaType(t.string())).toBe(true);
    expect(isSchemaType(t.int())).toBe(true);
    expect(isSchemaType(t.float())).toBe(true);
    expect(isSchemaType(t.boolean())).toBe(true);
    expect(isSchemaType(t.id())).toBe(true);
    expect(isSchemaType(t.object({ a: t.string() }, 'X'))).toBe(true);
    expect(isSchemaType(t.list(t.string()))).toBe(true);
    expect(isSchemaType(t.enum(['A'] as const, 'E'))).toBe(true);
    expect(isSchemaType(t.ref('Ref'))).toBe(true);
  });

  test('isSchemaType returns true for modified builders', () => {
    expect(isSchemaType(t.string().required())).toBe(true);
    expect(isSchemaType(t.int().nullable())).toBe(true);
    expect(isSchemaType(t.list(t.string()).required())).toBe(true);
  });

  test('isSchemaType returns false for plain objects', () => {
    expect(isSchemaType({ name: 'test' })).toBe(false);
    expect(isSchemaType({})).toBe(false);
  });

  test('isSchemaType returns false for Zod schemas', () => {
    expect(isSchemaType(z.string())).toBe(false);
    expect(isSchemaType(z.object({ a: z.string() }))).toBe(false);
  });

  test('isSchemaType returns false for primitives and nullish', () => {
    expect(isSchemaType(null)).toBe(false);
    expect(isSchemaType(undefined)).toBe(false);
    expect(isSchemaType(42)).toBe(false);
    expect(isSchemaType('hello')).toBe(false);
  });

  test('isSchemaInput returns true for Record of SchemaTypes', () => {
    expect(
      isSchemaInput({
        name: t.string().required(),
        age: t.int(),
      })
    ).toBe(true);
  });

  test('isSchemaInput returns false for Zod object (has _def)', () => {
    const zodObj = z.object({ a: z.string() });
    expect(isSchemaInput(zodObj)).toBe(false);
  });

  test('isSchemaInput returns false for null/undefined', () => {
    expect(isSchemaInput(null)).toBe(false);
    expect(isSchemaInput(undefined)).toBe(false);
  });

  test('isSchemaInput returns false for Record of non-SchemaType values', () => {
    expect(isSchemaInput({ a: 'string', b: 123 })).toBe(false);
    expect(isSchemaInput({ a: z.string() })).toBe(false);
  });

  test('isSchemaInput returns false for empty object', () => {
    expect(isSchemaInput({})).toBe(false);
  });

  test('isSchemaInput returns false for arrays', () => {
    expect(isSchemaInput([t.string()])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. SCHEMA_DSL_MARKER
// ---------------------------------------------------------------------------

describe('SCHEMA_DSL_MARKER', () => {
  test('all builder instances have the marker symbol', () => {
    const builders = [
      t.string(),
      t.int(),
      t.float(),
      t.boolean(),
      t.id(),
      t.object({ a: t.string() }, 'Test'),
      t.list(t.string()),
      t.enum(['A'] as const, 'TestEnum'),
      t.ref('Ref'),
    ];

    for (const builder of builders) {
      expect(SCHEMA_DSL_MARKER in builder).toBe(true);
      expect((builder as any)[SCHEMA_DSL_MARKER]).toBe(true);
    }
  });

  test('marker is a Symbol (unforgeable)', () => {
    expect(typeof SCHEMA_DSL_MARKER).toBe('symbol');
    const fake = Symbol('SCHEMA_DSL');
    expect(fake).not.toBe(SCHEMA_DSL_MARKER);
  });

  test('required/nullable variants retain the marker', () => {
    expect((t.string().required() as any)[SCHEMA_DSL_MARKER]).toBe(true);
    expect((t.string().nullable() as any)[SCHEMA_DSL_MARKER]).toBe(true);
    expect((t.int().required().nullable() as any)[SCHEMA_DSL_MARKER]).toBe(true);
  });
});
