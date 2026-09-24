import { getMetadataStorage } from "../metadata";

/**
 * Relation decorator target: a registered archetype name, the archetype class,
 * or a zero-arg thunk returning either (for circular references).
 */
export type RelationTarget =
    | string
    | ArchetypeCtor
    | (() => RelationTarget);

export type ArchetypeCtor = new (...args: never[]) => {
    getZodObjectSchema: (...args: never[]) => unknown;
};

export interface ResolvedRelationTarget {
    name: string;
    ctor: ArchetypeCtor;
}

function isArchetypeClass(value: unknown): value is ArchetypeCtor {
    if (typeof value !== "function") return false;
    const proto: unknown = value.prototype;
    if (!proto || typeof proto !== "object") return false;
    return "getZodObjectSchema" in proto && typeof proto.getZodObjectSchema === "function";
}

/**
 * Unwrap `() => Class` thunks. A class is not invoked — its prototype carries
 * archetype methods, a thunk's does not.
 */
export function unwrapRelationTarget(target: RelationTarget): string | ArchetypeCtor {
    let current: unknown = target;
    const seen = new Set<unknown>();
    while (typeof current === "function" && !isArchetypeClass(current)) {
        if (seen.has(current)) {
            throw new Error("Cyclic relation target thunk");
        }
        seen.add(current);
        current = current();
    }
    if (typeof current === "string" || isArchetypeClass(current)) {
        return current;
    }
    throw new Error(
        `Invalid relation target ${typeof current}. Pass an archetype class, () => Class, or a registered archetype name.`
    );
}

/**
 * Resolve a relation target to its registered GraphQL name and constructor.
 * Throws at schema build when the target was never registered with @ArcheType.
 */
export function resolveRelationTarget(target: RelationTarget): ResolvedRelationTarget {
    const resolved = unwrapRelationTarget(target);
    const storage = getMetadataStorage();

    if (typeof resolved === "string") {
        const meta = storage.archetypes.find((a) => a.name === resolved);
        if (!meta) {
            throw new Error(
                `Relation target "${resolved}" is not a registered archetype. ` +
                `Decorate the class with @ArcheType before schema build.`
            );
        }
        return { name: meta.name, ctor: meta.target as unknown as ArchetypeCtor };
    }

    const typeId = storage.getComponentId(resolved.name);
    const meta = storage.archetypes.find((a) => a.typeId === typeId);
    if (!meta) {
        throw new Error(
            `Relation target class ${resolved.name} is not a registered archetype. ` +
            `Decorate it with @ArcheType before schema build.`
        );
    }
    return { name: meta.name, ctor: resolved };
}

export function archetypeGraphqlName(archetype: { constructor: { name: string } }): string {
    const storage = getMetadataStorage();
    const archetypeId = storage.getComponentId(archetype.constructor.name);
    return (
        storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
        archetype.constructor.name
    );
}
