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
