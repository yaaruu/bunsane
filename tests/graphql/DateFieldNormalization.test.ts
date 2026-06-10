/**
 * Regression tests for Date @CompData field serialization.
 *
 * Bug: gqloom maps `z.date()` -> GraphQLString (not the custom `Date`
 * scalar), so a Date instance returned by a resolver gets coerced through
 * `Date.valueOf()` and emitted as an epoch number instead of an ISO
 * string. The post-save in-memory return path was the visible failure
 * (DB-loaded path returns ISO already from JSONB). Resolvers now
 * normalize Date -> ISO at the component-prop leaf so the output is
 * stable across in-memory and DB-loaded paths.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { ensureComponentsRegistered } from '../utils';
import { ResolverGeneratorVisitor } from '../../gql/visitors/ResolverGeneratorVisitor';
import { compNameToFieldName } from '../../core/archetype/helpers';

@Component
class DateTestComponent extends BaseComponent {
    @CompData({ indexed: true })
    userId: string = '';

    @CompData({ indexed: true })
    clockInAt: Date = new Date();
}

@ArcheType({ name: 'DateTestArchetype' })
class DateTestArchetype extends BaseArcheType {
    @ArcheTypeField(DateTestComponent)
    clock!: DateTestComponent;
}

describe('Date @CompData field normalization', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(DateTestComponent);
    });

    describe('component-prop leaf resolver', () => {
        test('normalizes Date instance to ISO string (in-memory path)', () => {
            const archetype = new DateTestArchetype();
            const resolvers = archetype.generateFieldResolvers();

            const componentTypeName = compNameToFieldName(DateTestComponent.name);
            const clockInAtResolver = resolvers.find(
                r => r.typeName === componentTypeName && r.fieldName === 'clockInAt'
            );

            expect(clockInAtResolver).toBeDefined();

            const inMemoryComp = new DateTestComponent();
            const now = new Date('2026-05-17T07:29:08.272Z');
            inMemoryComp.clockInAt = now;
            inMemoryComp.userId = 'u1';

            const result = clockInAtResolver!.resolver(inMemoryComp, {}, {});
            expect(typeof result).toBe('string');
            expect(result).toBe('2026-05-17T07:29:08.272Z');
            expect(new Date(result).toISOString()).toBe(result);
        });

        test('passes ISO string through unchanged (DB-loaded path)', () => {
            const archetype = new DateTestArchetype();
            const resolvers = archetype.generateFieldResolvers();

            const componentTypeName = compNameToFieldName(DateTestComponent.name);
            const clockInAtResolver = resolvers.find(
                r => r.typeName === componentTypeName && r.fieldName === 'clockInAt'
            );

            const dbLoadedParent = {
                userId: 'u1',
                clockInAt: '2026-05-17T07:29:08.272Z',
            };

            const result = clockInAtResolver!.resolver(dbLoadedParent, {}, {});
            expect(result).toBe('2026-05-17T07:29:08.272Z');
        });

        test('returns string fields unchanged', () => {
            const archetype = new DateTestArchetype();
            const resolvers = archetype.generateFieldResolvers();

            const componentTypeName = compNameToFieldName(DateTestComponent.name);
            const userIdResolver = resolvers.find(
                r => r.typeName === componentTypeName && r.fieldName === 'userId'
            );

            const result = userIdResolver!.resolver({ userId: 'abc' }, {}, {});
            expect(result).toBe('abc');
        });
    });

    describe('Date scalar resolver hardening', () => {
        test('serializes Date instance to ISO string', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            expect(dateScalar).toBeDefined();
            expect(dateScalar.serialize(new Date('2026-05-17T07:29:08.272Z')))
                .toBe('2026-05-17T07:29:08.272Z');
        });

        test('serializes numeric epoch (ms) to ISO string', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            const ms = new Date('2026-05-17T07:29:08.272Z').getTime();
            expect(dateScalar.serialize(ms)).toBe('2026-05-17T07:29:08.272Z');
        });

        test('serializes numeric string to ISO string', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            const ms = new Date('2026-05-17T07:29:08.272Z').getTime();
            expect(dateScalar.serialize(String(ms))).toBe('2026-05-17T07:29:08.272Z');
        });

        test('passes ISO string through unchanged', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            expect(dateScalar.serialize('2026-05-17T07:29:08.272Z'))
                .toBe('2026-05-17T07:29:08.272Z');
        });

        test('passes null/undefined through', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            expect(dateScalar.serialize(null)).toBe(null);
            expect(dateScalar.serialize(undefined)).toBe(undefined);
        });

        test('throws on unsupported type', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            expect(() => dateScalar.serialize(true)).toThrow();
            expect(() => dateScalar.serialize({})).toThrow();
        });

        test('parseValue accepts numeric epoch', () => {
            const visitor = new ResolverGeneratorVisitor([]);
            const resolvers = visitor.getResults();
            const dateScalar: any = (resolvers as any).Date;

            const ms = new Date('2026-05-17T07:29:08.272Z').getTime();
            const parsed = dateScalar.parseValue(ms);
            expect(parsed).toBeInstanceOf(Date);
            expect(parsed.toISOString()).toBe('2026-05-17T07:29:08.272Z');
        });
    });
});
