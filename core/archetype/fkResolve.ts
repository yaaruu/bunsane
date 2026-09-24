import type { ComponentConstructor } from "../components/ComponentRegistry";
import { getMetadataStorage } from "../metadata";

export type ComponentCtor = ComponentConstructor;

export interface FkResolution {
    componentCtor: ComponentCtor;
    componentTypeId: string;
    foreignKeyField: string;
}

/**
 * Find the single component on `componentMap` that owns `foreignKey`.
 * Dotted keys (`field.prop`) select the component by archetype property name.
 * Undotted keys match the first component whose metadata declares that property.
 * Callers memoize the result — it does not change for the life of a schema.
 */
export function resolveFkOnMap(
    componentMap: Record<string, ComponentCtor>,
    foreignKey: string | undefined
): FkResolution | null {
    if (!foreignKey) return null;
    const storage = getMetadataStorage();

    if (foreignKey.includes(".")) {
        const dot = foreignKey.indexOf(".");
        const fieldName = foreignKey.slice(0, dot);
        const propName = foreignKey.slice(dot + 1);
        const componentCtor = componentMap[fieldName];
        if (!componentCtor || !propName) return null;
        return {
            componentCtor,
            componentTypeId: storage.getComponentId(componentCtor.name),
            foreignKeyField: propName,
        };
    }

    for (const comp of Object.values(componentMap)) {
        const typeId = storage.getComponentId(comp.name);
        const props = storage.getComponentProperties(typeId);
        if (props.some((p) => p.propertyKey === foreignKey)) {
            return {
                componentCtor: comp,
                componentTypeId: typeId,
                foreignKeyField: foreignKey,
            };
        }
    }
    return null;
}

/** Close over the owning component so belongsTo/hasOne/hasMany do not rescan metadata per parent. */
export function memoResolveFk(
    getMap: () => Record<string, ComponentCtor>,
    foreignKey: string | undefined
): () => FkResolution | null {
    let cached: FkResolution | null | undefined;
    return () => {
        if (cached !== undefined) return cached;
        cached = resolveFkOnMap(getMap(), foreignKey);
        return cached;
    };
}

/** Historical unscoped relation scan looked for these JSON keys. */
const IMPLICIT_FK_FIELDS = ["user_id", "parent_id"] as const;

export interface ImplicitFkMatch extends FkResolution {
    componentField: string;
}

export function componentMapOf(instance: object): Record<string, ComponentCtor> {
    if (!("componentMap" in instance) || instance.componentMap == null || typeof instance.componentMap !== "object") {
        return {};
    }
    return instance.componentMap as Record<string, ComponentCtor>;
}

/**
 * Components on `componentMap` that declare `user_id` or `parent_id`.
 * One match can be pinned to a partition; zero or several cannot.
 */
export function implicitFkMatches(componentMap: Record<string, ComponentCtor>): ImplicitFkMatch[] {
    const storage = getMetadataStorage();
    const matches: ImplicitFkMatch[] = [];
    for (const [componentField, componentCtor] of Object.entries(componentMap)) {
        const componentTypeId = storage.getComponentId(componentCtor.name);
        const props = storage.getComponentProperties(componentTypeId);
        for (const foreignKeyField of IMPLICIT_FK_FIELDS) {
            if (props.some((prop) => prop.propertyKey === foreignKeyField)) {
                matches.push({
                    componentCtor,
                    componentTypeId,
                    foreignKeyField,
                    componentField,
                });
            }
        }
    }
    return matches;
}

export function implicitFkError(archetypeName: string, fieldName: string, matches: readonly ImplicitFkMatch[]): Error {
    const detail = matches.length === 0
        ? "zero components match a user_id or parent_id property"
        : `multiple components match (${matches.map((match) => `${match.componentField}.${match.foreignKeyField}`).join(", ")})`;
    return new Error(
        `Relation ${archetypeName}.${fieldName} has no foreignKey and ${detail}. ` +
        `Set foreignKey: 'component.prop'.`
    );
}

/**
 * FK-less relations must resolve to exactly one component property so the
 * loader can pin `type_id`. Throws at schema build otherwise.
 */
export function requireImplicitFk(
    archetypeName: string,
    fieldName: string,
    componentMap: Record<string, ComponentCtor>,
): FkResolution {
    const matches = implicitFkMatches(componentMap);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (!only) throw implicitFkError(archetypeName, fieldName, matches);
    return only;
}
