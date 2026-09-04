/**
 * Regression: archetype component-field resolvers must treat a request
 * DataLoader null as authoritative ("component absent").
 *
 * Bug: when `context.loaders.componentsByEntityType.load()` returned null
 * for an optional (`nullable: true`) component, the resolver fell through to
 * `ensureEntity(parent).get(componentCtor)` — one bare, un-batched SELECT per
 * absent component per parent. Measured on a 20-row order list with two
 * nullable components: 40 of 51 statements per request.
 */
import { describe, test, expect, beforeAll, afterEach, spyOn } from 'bun:test';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../core/ArcheType';
import { Entity } from '../../core/Entity';
import { ensureComponentsRegistered } from '../utils';

@Component
class NcfrCoreComponent extends BaseComponent {
    @CompData() label: string = '';
}

@Component
class NcfrOptionalComponent extends BaseComponent {
    @CompData() status: string = '';
    @CompData() attempts: number = 0;
}

@Component
class NcfrOptionalValueComponent extends BaseComponent {
    @CompData() value: string = '';
}

@ArcheType({ name: 'NcfrArchetype' })
class NcfrArchetype extends BaseArcheType {
    @ArcheTypeField(NcfrCoreComponent)
    core!: NcfrCoreComponent;

    @ArcheTypeField(NcfrOptionalComponent, { nullable: true })
    optional!: NcfrOptionalComponent | null;

    @ArcheTypeField(NcfrOptionalValueComponent, { nullable: true })
    optionalValue!: NcfrOptionalValueComponent | null;
}

function fakeLoaders(answer: (key: { entityId: string; typeId: string }) => any) {
    const calls: Array<{ entityId: string; typeId: string }> = [];
    return {
        calls,
        loaders: {
            componentsByEntityType: {
                load: async (key: { entityId: string; typeId: string }) => {
                    calls.push(key);
                    return answer(key);
                },
            },
            entityById: {
                load: async () => {
                    throw new Error('entityById loader must not be consulted');
                },
            },
        },
    };
}

describe('nullable component field resolver — loader null is authoritative', () => {
    let archetype: NcfrArchetype;
    let getSpy: ReturnType<typeof spyOn>;

    beforeAll(async () => {
        await ensureComponentsRegistered(NcfrCoreComponent, NcfrOptionalComponent, NcfrOptionalValueComponent);
        archetype = new NcfrArchetype();
    });

    afterEach(() => {
        getSpy?.mockRestore();
    });

    function resolverFor(field: string) {
        const entry = archetype
            .generateFieldResolvers()
            .find(r => r.typeName === 'NcfrArchetype' && r.fieldName === field);
        expect(entry).toBeDefined();
        return entry!.resolver;
    }

    test('object component: absent → null, no fallback entity.get()', async () => {
        const parent = Entity.Create();
        const { loaders, calls } = fakeLoaders(() => null);
        getSpy = spyOn(Entity.prototype, 'get').mockImplementation(async () => {
            throw new Error('fallback entity.get() fired');
        });

        const out = await resolverFor('optional')(parent, {}, { loaders });

        expect(out).toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.entityId).toBe(parent.id);
        expect(getSpy).not.toHaveBeenCalled();
    });

    test('unwrapped value component: absent → undefined/null, no fallback entity.get()', async () => {
        const parent = Entity.Create();
        const { loaders, calls } = fakeLoaders(() => null);
        getSpy = spyOn(Entity.prototype, 'get').mockImplementation(async () => {
            throw new Error('fallback entity.get() fired');
        });

        const out = await resolverFor('optionalValue')(parent, {}, { loaders });

        expect(out == null).toBe(true);
        expect(calls).toHaveLength(1);
        expect(getSpy).not.toHaveBeenCalled();
    });

    test('object component: present → loader data returned verbatim', async () => {
        const parent = Entity.Create();
        const data = { status: 'SENT', attempts: 2 };
        const { loaders } = fakeLoaders(() => ({ id: 'c1', data }));
        getSpy = spyOn(Entity.prototype, 'get').mockImplementation(async () => {
            throw new Error('fallback entity.get() fired');
        });

        const out = await resolverFor('optional')(parent, {}, { loaders });

        expect(out).toEqual(data);
        expect(getSpy).not.toHaveBeenCalled();
    });

    test('no loaders on context → legacy entity.get() path still used', async () => {
        const parent = Entity.Create();
        getSpy = spyOn(Entity.prototype, 'get').mockImplementation(async () => null);

        const out = await resolverFor('optional')(parent, {}, {});

        expect(out).toBeNull();
        expect(getSpy).toHaveBeenCalledTimes(1);
    });
});
